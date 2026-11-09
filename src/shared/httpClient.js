'use strict';
/**
 * CLIENTE HTTP PARA INTERFACES CONSUMIDAS
 *
 * En el diagrama UML, cuando un componente dibuja un "socket" (interfaz
 * requerida) hacia otro, en el codigo eso es esta funcion. Incluye:
 *  - token interno (la interfaz no es publica),
 *  - propagacion del correlation-id (trazabilidad end-to-end),
 *  - TIMEOUT: si la dependencia se cuelga, yo no me cuelgo. Fallo rapido en vez
 *    de agotar mis conexiones y arrastrar a todo el sistema.
 *  - CIRCUIT BREAKER + RETRY (patron de DISPONIBILIDAD): si la dependencia
 *    falla varias veces seguidas, dejo de golpearla y respondo al instante.
 *
 * POR QUE EN ESTE ARCHIVO Y NO EN CADA SERVICIO:
 * callInternal es el unico punto por el que TODOS los componentes consumen a
 * otros. Poner el breaker aca garantiza que ningun llamador tenga que cambiar
 * su firma ni su formato de retorno, y que la proteccion valga para todos.
 */
const config = require('./config');

// ---------------------------------------------------------------------------
// CIRCUIT BREAKER por HOST destino (en memoria del proceso).
//
// Estados:
//   CLOSED    -> todo normal, las llamadas pasan.
//   OPEN      -> la dependencia fallo CB_FAILURE_THRESHOLD veces seguidas.
//                Respondemos 503 INMEDIATO sin hacer la llamada (fail fast) y
//                dejamos pasar una unica request de prueba tras CB_OPEN_MS.
//   HALF_OPEN -> dejamos pasar UNA request de prueba: si sale bien volvemos a
//                CLOSED; si falla, volvemos a OPEN.
//
// Un breaker vive en memoria del proceso: es una optimizacion local, no un
// dato de negocio. Que dos replicas tengan vision distinta del estado de una
// dependencia es aceptable e incluso deseable (cada una protege su propio pool).
// ---------------------------------------------------------------------------
const breakers = new Map();

function getBreaker(host) {
  if (!breakers.has(host)) {
    breakers.set(host, { host, estado: 'CLOSED', fallos: 0, abiertoHasta: 0, enPrueba: false });
  }
  return breakers.get(host);
}

/** Registra (y loguea) una transicion de estado. */
function transicionar(b, nuevo) {
  if (b.estado !== nuevo) {
    console.log(`[circuit-breaker] ${b.host}: ${b.estado} -> ${nuevo}`);
    b.estado = nuevo;
  }
}

function registrarExito(b) {
  b.fallos = 0;
  b.enPrueba = false;
  transicionar(b, 'CLOSED');
}

function registrarFallo(b) {
  b.fallos += 1;
  // En HALF_OPEN un solo fallo reabre; en CLOSED hace falta llegar al umbral.
  if (b.estado === 'HALF_OPEN' || b.fallos >= config.circuitBreaker.failureThreshold) {
    b.abiertoHasta = Date.now() + config.circuitBreaker.openMs;
    b.enPrueba = false;
    transicionar(b, 'OPEN');
  }
}

/**
 * Decide si la llamada puede pasar y, si corresponde, marca la prueba de
 * HALF_OPEN. Devuelve { permitido, retryAfterMs }.
 */
function evaluarPermiso(b) {
  const ahora = Date.now();
  if (b.estado === 'CLOSED') return { permitido: true };

  if (b.estado === 'OPEN') {
    if (ahora >= b.abiertoHasta) {
      transicionar(b, 'HALF_OPEN');
      b.enPrueba = true;
      return { permitido: true };            // esta es la request de prueba
    }
    return { permitido: false, retryAfterMs: b.abiertoHasta - ahora };
  }

  // HALF_OPEN: solo una request de prueba en vuelo a la vez.
  if (b.enPrueba) return { permitido: false, retryAfterMs: 1000 };
  b.enPrueba = true;
  return { permitido: true };
}

/** Snapshot para /healthz: { "<host>": "CLOSED|OPEN|HALF_OPEN" } */
function circuitSnapshot() {
  const out = {};
  for (const b of breakers.values()) out[b.host] = b.estado;
  return out;
}

/** loguea y formatea el estado para la demo. */
function circuitDatos(host, retryAfterMs) {
  return {
    error: `Circuito abierto hacia ${host}`,
    circuit: 'OPEN',
    retryAfterMs: Math.max(0, Math.round(retryAfterMs || 0))
  };
}

// ---------------------------------------------------------------------------
// Una unica ejecucion de la llamada. No conoce el breaker: solo clasifica el
// resultado en 'ok' (2xx), 'cliente' (4xx, la dependencia esta viva) o 'fallo'
// (red, timeout o 5xx).
// ---------------------------------------------------------------------------
async function unaLlamada(url, { method, body, correlationId }, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': config.internalToken,
        'X-Correlation-Id': correlationId || 'sin-cid'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const texto = await res.text();
    let datos = null;
    try { datos = texto ? JSON.parse(texto) : null; } catch (_) { datos = { raw: texto }; }
    const respuesta = { ok: res.ok, status: res.status, datos };
    // 4xx => la dependencia respondio: NO cuenta como fallo del circuito.
    return { categoria: res.status >= 500 ? 'fallo' : (res.ok ? 'ok' : 'cliente'), respuesta };
  } catch (err) {
    return { categoria: 'fallo', motivo: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Backoff exponencial con jitter (evita que N replicas reintenten en sincronia). */
function esperarBackoff(intento) {
  const base = config.circuitBreaker.retryBaseMs * Math.pow(2, intento);
  const jitter = Math.random() * config.circuitBreaker.retryBaseMs;
  return new Promise((r) => setTimeout(r, Math.round(base + jitter)));
}

async function callInternal(url, { method = 'GET', body, correlationId, timeoutMs = 3000 } = {}) {
  let host = url;
  try { host = new URL(url).host; } catch (_) { /* url relativa: usamos el string */ }

  const b = getBreaker(host);
  const permiso = evaluarPermiso(b);
  if (!permiso.permitido) {
    // Fail fast: NO tocamos la red. Es lo que mantiene a flote al llamador.
    return { ok: false, status: 503, datos: circuitDatos(host, permiso.retryAfterMs) };
  }

  // Retry solo en metodos idempotentes: reintentar un POST podria duplicar.
  const idempotente = String(method).toUpperCase() === 'GET';
  const intentosMax = idempotente ? 1 + Math.max(0, config.circuitBreaker.retries) : 1;

  let ultimo;
  for (let intento = 0; intento < intentosMax; intento++) {
    ultimo = await unaLlamada(url, { method, body, correlationId }, timeoutMs);

    if (ultimo.categoria === 'ok' || ultimo.categoria === 'cliente') {
      // La dependencia respondio (aunque sea un 4xx): el circuito esta sano.
      registrarExito(b);
      return ultimo.respuesta;
    }
    if (intento < intentosMax - 1) await esperarBackoff(intento);
  }

  // Todos los intentos fallaron: UN fallo para el breaker (no uno por intento).
  registrarFallo(b);
  return {
    ok: false,
    status: 503,
    datos: { error: `Dependencia no disponible: ${ultimo.motivo || 'error de red o 5xx'}` }
  };
}

/**
 * TFU5: CIRCUIT BREAKER GENERICO (independiente del protocolo).
 *
 * En la TFU4 el breaker solo envolvia llamadas REST/JSON (callInternal). En la
 * TFU5 la unica dependencia SINCRONA que queda entre componentes es la
 * operacion SOAP ConsultarRelacionClinica (records -> scheduling), que no usa
 * fetch sino un cliente SOAP generado desde el WSDL. Reutilizamos el MISMO
 * mapa de breakers, asi el estado sigue apareciendo en /healthz.
 *
 * fn: funcion async que hace la llamada. Si lanza, cuenta como fallo de la
 *     dependencia, salvo que el error traiga `esCliente = true` (equivalente a
 *     un 4xx: la dependencia respondio, el problema es del pedido).
 *
 * Devuelve { ok: true, valor } o { ok: false, circuitoAbierto, retryAfterMs, motivo }.
 */
async function conCircuito(host, fn) {
  const b = getBreaker(host);
  const permiso = evaluarPermiso(b);
  if (!permiso.permitido) {
    return { ok: false, circuitoAbierto: true, retryAfterMs: permiso.retryAfterMs,
             motivo: `Circuito abierto hacia ${host}` };
  }
  try {
    const valor = await fn();
    registrarExito(b);
    return { ok: true, valor };
  } catch (err) {
    if (err && err.esCliente) {
      registrarExito(b);
      return { ok: false, circuitoAbierto: false, motivo: err.message };
    }
    registrarFallo(b);
    return { ok: false, circuitoAbierto: false, motivo: (err && err.message) || 'fallo de la dependencia' };
  }
}

module.exports = { callInternal, circuitSnapshot, conCircuito };
