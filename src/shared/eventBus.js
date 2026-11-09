'use strict';
/**
 * BUS DE EVENTOS  (TFU5 - Arquitectura Basada en Eventos, topologia BROKER)
 *
 * Es el mecanismo de comunicacion PRINCIPAL entre componentes. En la TFU4 los
 * componentes se llamaban entre si por REST de forma sincrona (pharmacy ->
 * records, queue -> pharmacy, pharmacy -> records). En la TFU5 los componentes
 * PUBLICAN HECHOS ("RecetaEmitida", "RetiroSolicitado", "RetiroAtendido") y los
 * interesados REACCIONAN a ellos. El productor no conoce a sus consumidores.
 *
 * Implementacion: Redis Streams en un contenedor propio (broker) con AOF.
 *  - TOPICO = un stream (eventos:recetas, eventos:retiros, eventos:turnos).
 *  - Cada componente interesado crea su CONSUMER GROUP sobre el topico: todos
 *    los grupos reciben TODOS los eventos (fan-out / publish-subscribe), y
 *    dentro de un grupo cada evento lo procesa UNA sola replica (competing
 *    consumers). Asi records, queue y notifications reaccionan al mismo
 *    RetiroSolicitado de forma independiente.
 *  - A diferencia del pub/sub de Redis que usabamos para notificaciones en la
 *    TFU4, el stream es DURABLE: si un consumidor esta caido, los eventos lo
 *    esperan y los procesa al volver (falacia "la red es confiable").
 *
 * Garantia de entrega: AT-LEAST-ONCE. Un evento puede llegar mas de una vez
 * (reintento, reclamo de pendientes, relay del outbox que publica dos veces).
 * Por eso TODOS los consumidores son IDEMPOTENTES (ver inbox.js).
 *
 * Mensajes venenosos: si un handler falla EVENT_MAX_INTENTOS veces con el
 * mismo evento, se mueve a la DEAD LETTER QUEUE (eventos:dlq) y se reconoce,
 * para que no bloquee ni consuma CPU para siempre.
 */
const crypto = require('crypto');
const { createClient } = require('redis');
const config = require('./config');

const TOPICOS = {
  recetas: 'eventos:recetas',   // records publica: RecetaEmitida
  retiros: 'eventos:retiros',   // pharmacy: RetiroSolicitado | queue: RetiroAtendido
  turnos:  'eventos:turnos',    // queue publica: TurnoProximo, TurnoLlamado
  dlq:     'eventos:dlq'        // dead letter queue (todos los topicos)
};

// ---------------------------------------------------------------------------
// Conexiones al broker
// ---------------------------------------------------------------------------
async function conectarBroker(etiqueta) {
  const client = createClient({
    url: config.brokerUrl,
    // Sin cola offline: si el broker NO esta, el comando falla al instante en
    // vez de quedar encolado en memoria del proceso (que es justamente lo que
    // NO queremos: el outbox es quien guarda lo pendiente, de forma durable).
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: (intentos) => Math.min(250 * intentos, 2000)
    }
  });
  client.on('error', (err) =>
    console.error(`[${config.serviceName}][broker:${etiqueta}] ${err.message}`));
  await client.connect().catch((err) => {
    // El primer connect puede fallar si el broker todavia no esta: la
    // reconnectStrategy sigue intentando sola en segundo plano.
    console.error(`[${config.serviceName}][broker:${etiqueta}] connect: ${err.message}`);
  });
  return client;
}

let publicador = null;
async function getPublicador() {
  if (!publicador) publicador = await conectarBroker('pub');
  return publicador;
}

function conTimeout(promesa, ms, que) {
  let t;
  return Promise.race([
    promesa,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${que} (${ms}ms)`)), ms); })
  ]).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------------------
// Sobre (envelope) comun de TODOS los eventos
// ---------------------------------------------------------------------------
/**
 * Arma un evento. El id es un UUID generado por el PRODUCTOR (no el id que le
 * asigna Redis al XADD): asi, si el outbox publica dos veces el mismo evento,
 * los dos mensajes llevan el mismo id y el consumidor detecta el duplicado.
 */
function crearEvento(tipo, datos, { id, correlationId, origen } = {}) {
  return {
    id: id || crypto.randomUUID(),
    tipo,
    version: 1,
    origen: origen || config.serviceName,
    ocurridoEn: new Date().toISOString(),
    correlationId: correlationId || 'sin-cid',
    datos
  };
}

/** Serializa el sobre a los campos planos que acepta XADD. */
function aCampos(ev) {
  return {
    id: ev.id,
    tipo: ev.tipo,
    version: String(ev.version || 1),
    origen: ev.origen || '',
    ocurridoEn: ev.ocurridoEn || '',
    correlationId: ev.correlationId || '',
    datos: JSON.stringify(ev.datos || {})
  };
}

/** Reconstruye el sobre desde los campos del stream. Lanza si esta corrupto. */
function deCampos(campos, msgId) {
  // Compatibilidad con eventos "planos" de la TFU4 (sin sobre): los tratamos
  // como RetiroSolicitado y usamos el id del mensaje como id del evento.
  if (!campos.tipo && campos.ticketCode) {
    return { id: `legacy-${msgId}`, tipo: 'RetiroSolicitado', version: 0, origen: 'tfu4',
             ocurridoEn: '', correlationId: '', datos: campos };
  }
  if (!campos.id || !campos.tipo) throw new Error('evento sin id o tipo');
  return {
    id: campos.id,
    tipo: campos.tipo,
    version: Number(campos.version || 1),
    origen: campos.origen,
    ocurridoEn: campos.ocurridoEn,
    correlationId: campos.correlationId,
    datos: JSON.parse(campos.datos || '{}')      // JSON roto => lanza => DLQ
  };
}

// ---------------------------------------------------------------------------
// PUBLICAR
// ---------------------------------------------------------------------------
/**
 * Publica un evento YA ARMADO en un topico. Lanza si el broker no responde
 * (el llamador decide: el relay del outbox reintenta; queue-service devuelve
 * 503 al farmaceutico).
 */
async function publicar(topico, evento) {
  const broker = await getPublicador();
  if (!broker.isReady) throw new Error('broker no disponible');
  return conTimeout(
    broker.xAdd(topico, '*', aCampos(evento), {
      TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: config.streamMaxlen }
    }),
    config.eventos.publishTimeoutMs,
    'publicando en el broker');
}

// ---------------------------------------------------------------------------
// SUSCRIBIRSE (consumer group + reintentos + DLQ)
// ---------------------------------------------------------------------------
const estadisticas = {};   // por "topico|grupo": procesados, duplicados, fallos, dlq

function stats(clave) {
  if (!estadisticas[clave]) estadisticas[clave] = { procesados: 0, fallos: 0, aDlq: 0 };
  return estadisticas[clave];
}

async function moverADlq(broker, topico, grupo, msgId, campos, motivo) {
  await broker.xAdd(TOPICOS.dlq, '*', {
    topicoOriginal: topico,
    grupo,
    msgIdOriginal: msgId,
    motivo: String(motivo).slice(0, 500),
    campos: JSON.stringify(campos),
    movidoEn: new Date().toISOString()
  });
  await broker.xAck(topico, grupo, msgId);
  console.error(`[${config.serviceName}] evento ${msgId} de ${topico} -> DLQ (${motivo})`);
}

/**
 * Se suscribe a un topico con un consumer group.
 *
 * handler(evento, { msgId, intento }) -> async. Si retorna, se hace ACK. Si
 * lanza, el mensaje queda PENDIENTE y se reintenta (XAUTOCLAIM) hasta
 * maxIntentos; despues va a la DLQ.
 *
 * desde: '0' = el grupo procesa tambien la historia del stream al crearse
 *        (util para que una replica local se reconstruya desde cero).
 */
async function suscribir({ topico, grupo, handler, desde = '0', delayMs = 0 }) {
  // Dos conexiones: XREADGROUP BLOCK deja la conexion "ocupada" hasta 2s, y
  // node-redis encola los demas comandos detras. Si el reclamo de pendientes
  // usara la misma conexion, sus comandos esperarian al bloqueo y dos ciclos
  // de reclamo se solaparian (procesando el mismo mensaje dos veces).
  const broker = await conectarBroker(`sub:${grupo}`);
  const brokerReclamo = await conectarBroker(`reclamo:${grupo}`);
  const consumidor = `${grupo}-${config.instanceId}`;
  const clave = `${topico}|${grupo}`;
  const s = stats(clave);
  const maxIntentos = config.eventos.maxIntentos;

  async function asegurarGrupo() {
    try {
      await broker.xGroupCreate(topico, grupo, desde, { MKSTREAM: true });
      console.log(`[${config.serviceName}] grupo ${grupo} creado sobre ${topico}`);
    } catch (err) {
      if (!String(err.message).includes('BUSYGROUP')) throw err;
    }
  }

  async function procesar(msgId, campos, intento, conn = broker) {
    let evento;
    try {
      evento = deCampos(campos, msgId);
    } catch (err) {
      // Mensaje corrupto: reintentar no lo va a arreglar -> DLQ directo.
      s.aDlq += 1;
      await moverADlq(conn, topico, grupo, msgId, campos, `mensaje corrupto: ${err.message}`);
      return;
    }
    try {
      await handler(evento, { msgId, intento });
      await conn.xAck(topico, grupo, msgId);
      s.procesados += 1;
    } catch (err) {
      s.fallos += 1;
      console.error(`[${config.serviceName}] handler ${grupo} fallo con ${evento.tipo} ` +
                    `${evento.id} (intento ${intento}/${maxIntentos}): ${err.message}`);
      if (intento >= maxIntentos) {
        s.aDlq += 1;
        await moverADlq(conn, topico, grupo, msgId, campos, err.message);
      }
      // si no, queda pendiente: lo levanta reclamar() en el proximo ciclo.
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  /** Reintentos: toma los mensajes pendientes "colgados" (de cualquier replica). */
  let reclamando = false;
  async function reclamar() {
    if (reclamando) return;              // nunca dos ciclos de reclamo a la vez
    reclamando = true;
    try {
      const res = await brokerReclamo.xAutoClaim(topico, grupo, consumidor,
        config.eventos.reclaimIdleMs, '0-0', { COUNT: 20 });
      for (const m of (res && res.messages) || []) {
        if (!m || !m.message) continue;
        // Cuantas veces se entrego (XAUTOCLAIM ya sumo esta entrega). Si ya no
        // figura como pendiente, otro consumidor lo reconocio: lo salteamos.
        const info = await brokerReclamo.xPendingRange(topico, grupo, m.id, m.id, 1);
        if (!info || !info[0]) continue;
        await procesar(m.id, m.message, info[0].deliveriesCounter || 1, brokerReclamo);
      }
    } catch (err) {
      if (!String(err.message).includes('NOGROUP')) {
        console.error(`[${config.serviceName}] reclamo ${grupo}: ${err.message}`);
      }
    } finally {
      reclamando = false;
    }
  }

  // Bucle principal (no bloquea el event loop: XREADGROUP BLOCK espera en Redis).
  let grupoListo = false;
  (async () => {
    for (;;) {
      try {
        if (!broker.isReady) { await new Promise((r) => setTimeout(r, 1000)); continue; }
        if (!grupoListo) { await asegurarGrupo(); grupoListo = true; }
        const resp = await broker.xReadGroup(grupo, consumidor,
          [{ key: topico, id: '>' }], { COUNT: 10, BLOCK: 2000 });
        if (resp) {
          for (const stream of resp) {
            for (const msg of stream.messages) await procesar(msg.id, msg.message, 1);
          }
        }
      } catch (err) {
        // NOGROUP: alguien borro el stream (p.ej. un FLUSHALL en la demo).
        if (String(err.message).includes('NOGROUP')) grupoListo = false;
        console.error(`[${config.serviceName}] consumidor ${grupo}: ${err.message}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })();

  const t = setInterval(() => { if (brokerReclamo.isReady) reclamar(); }, config.eventos.reclaimCadaMs);
  t.unref();

  console.log(`[${config.serviceName}] suscrito a ${topico} (grupo ${grupo}, consumidor ${consumidor})`);
}

function snapshotEventos() { return estadisticas; }

module.exports = {
  TOPICOS, crearEvento, publicar, suscribir, conectarBroker, getPublicador,
  snapshotEventos, conTimeout
};
