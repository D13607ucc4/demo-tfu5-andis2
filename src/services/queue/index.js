'use strict';
/**
 * COMPONENTE: queue-service
 *   <<< ESCALABILIDAD HORIZONTAL + SERVICIO SIN ESTADO + BASE >>>
 * 
 * Interfaz EXPUESTA : ICola (estado de la cola, mi turno, check-in presencial,
 *                     llamar al siguiente)
 * Interfaces CONSUMIDAS: Redis (estado). Ninguna sincrona (TFU5).
 *
 * TFU5 - EVENTOS:
 *   CONSUME : RetiroSolicitado (eventos:retiros)  -> ticket en la cola
 *   PUBLICA : RetiroAtendido   (eventos:retiros)  -> lo consumen pharmacy y records
 *             TurnoProximo / TurnoLlamado (eventos:turnos) -> notifications
 *   En la TFU4, al llamar al siguiente, queue hacia un POST sincrono a pharmacy
 *   (/internal/retiros/:id/atendido) y las notificaciones iban por pub/sub
 *   (si notifications estaba caido, el aviso se perdia). Ahora todo es un
 *   hecho publicado en un stream durable.
 *
 * ESTE ES EL COMPONENTE QUE ESCALAMOS A 3 REPLICAS. Puede hacerse porque:
 *  1) NO guarda NADA en memoria: la cola entera vive en Redis. Cualquier
 *     replica responde igual, no hace falta sticky session.
 *  2) Los eventos se consumen con un CONSUMER GROUP de Redis Streams: aunque
 *     haya 3 replicas leyendo el mismo stream, cada evento lo procesa UNA sola.
 *     Sin esto, el mismo ticket entraria 3 veces a la cola.
 *  3) Las operaciones sobre la lista (rPush / lPop) son ATOMICAS en Redis, asi
 *     que dos farmaceuticos simultaneos nunca llaman al mismo paciente.
 *
 * COLA HIBRIDA: entran tickets VIRTUALES (paciente desde el celular, via evento)
 * y PRESENCIALES (walk-in en el mostrador) a la MISMA lista FIFO.
 */
const { createApp, listen, errorHandler } = require('../../shared/server');
const { requireAuth } = require('../../shared/auth');
const { getRedis, KEYS } = require('../../shared/redisClient');
const { TOPICOS, crearEvento, publicar, getPublicador, suscribir } = require('../../shared/eventBus');
const config = require('../../shared/config');

const NOMBRE = 'queue-service';
const app = createApp(NOMBRE);

// ---------------------------------------------------------------------------
// Utilidades sobre el estado compartido (Redis)
// ---------------------------------------------------------------------------

/** Lee la cola completa con las posiciones calculadas. */
async function leerCola(redis) {
  const codigos = await redis.lRange(KEYS.colaFarmacia, 0, -1);
  const tickets = [];
  for (let i = 0; i < codigos.length; i++) {
    const datos = await redis.hGetAll(KEYS.ticket(codigos[i]));
    tickets.push({ posicion: i + 1, ticket: codigos[i], ...datos });
  }
  return tickets;
}

/**
 * Publica un evento de turno en el topico eventos:turnos.
 * queue-service NO sabe como se entrega la notificacion (push, SMS, mail): solo
 * publica el hecho. notifications-service se encarga. Bajo acoplamiento.
 * TFU5: antes era pub/sub (si nadie escuchaba en ese instante, se perdia);
 * ahora es un stream durable con consumer group.
 * Devuelve true si se publico. Una notificacion no debe tumbar la operacion
 * de la cola: si el broker no responde se loguea y se sigue.
 */
async function notificar(_redis, pacienteId, titulo, mensaje, tipo = 'TurnoProximo') {
  try {
    await publicar(TOPICOS.turnos, crearEvento(tipo, { pacienteId, titulo, mensaje }));
    return true;
  } catch (err) {
    console.error(`[${NOMBRE}] no se pudo publicar ${tipo}: ${err.message}`);
    return false;
  }
}

/** HU3: avisa a los que ya estan cerca del frente que se acerquen. */
async function avisarProximos(redis) {
  const cola = await leerCola(redis);
  for (const t of cola) {
    if (t.posicion > config.avisoPosicion) break;   // la lista ya esta ordenada
    // Marca "avisado" para no spamear al mismo paciente en cada llamada.
    const yaAvisado = await redis.hGet(KEYS.ticket(t.ticket), 'avisado');
    if (yaAvisado === '1') continue;
    if (!t.pacienteId || t.pacienteId === 'mostrador') continue;
    const ok = await notificar(redis, t.pacienteId, 'Tu turno esta por llegar',
      `Ticket ${t.ticket}: quedan ${t.posicion - 1} personas delante. Acercate al mostrador de farmacia.`);
    if (ok) await redis.hSet(KEYS.ticket(t.ticket), 'avisado', '1');
  }
}

// ---------------------------------------------------------------------------
// INTERFAZ EXPUESTA: ICola
// ---------------------------------------------------------------------------

/** GET /api/queue/farmacia -> estado publico de la cola (HU7). */
app.get('/api/queue/farmacia', requireAuth(), async (req, res, next) => {
  try {
    const redis = await getRedis();
    const atendiendoRaw = await redis.get(KEYS.atendiendo);
    const cola = await leerCola(redis);
    res.json({
      atendiendo: atendiendoRaw ? JSON.parse(atendiendoRaw) : null,
      esperando: cola.length,
      cola,
      // Header X-Served-By dice que replica respondio; esto lo repite en el body
      // para que se vea comodo en los scripts.
      atendidoPorInstancia: config.instanceId
    });
  } catch (err) { next(err); }
});

/** GET /api/queue/mi-turno -> el paciente consulta su posicion desde el celular. */
app.get('/api/queue/mi-turno', requireAuth(['paciente']), async (req, res, next) => {
  try {
    const redis = await getRedis();
    const cola = await leerCola(redis);
    const mio = cola.find((t) => t.pacienteId === req.usuario.id);
    if (!mio) return res.status(404).json({ error: 'No tenes un ticket activo en la cola' });
    res.json({
      ticket: mio.ticket,
      posicion: mio.posicion,
      personasDelante: mio.posicion - 1,
      // Estimacion simple: 4 minutos por atencion.
      esperaEstimadaMin: (mio.posicion - 1) * 4,
      atendidoPorInstancia: config.instanceId
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/queue/farmacia/presencial  body: { pacienteId?, nota? }
 * La pata PRESENCIAL de la cola hibrida: alguien llega al mostrador sin app y
 * el farmaceutico lo agrega. Entra en la MISMA lista FIFO que los virtuales.
 */
app.post('/api/queue/farmacia/presencial', requireAuth(['farmaceutico']), async (req, res, next) => {
  try {
    const redis = await getRedis();
    // INCR es atomico: dos farmaceuticos simultaneos nunca generan el mismo nro.
    const nro = await redis.incr('cola:contador:presencial');
    const ticket = `P-${String(nro).padStart(3, '0')}`;

    await redis.hSet(KEYS.ticket(ticket), {
      ticket,
      pacienteId: req.body?.pacienteId || 'mostrador',
      medicamento: req.body?.nota || 'Consulta en mostrador',
      tipo: 'PRESENCIAL',
      creado: new Date().toISOString()
    });
    await redis.rPush(KEYS.colaFarmacia, ticket);
    await avisarProximos(redis);

    const largo = await redis.lLen(KEYS.colaFarmacia);
    res.status(201).json({ mensaje: 'Ticket presencial agregado', ticket, posicion: largo });
  } catch (err) { next(err); }
});

/**
 * POST /api/queue/farmacia/siguiente  (HU7)
 * El farmaceutico termino y llama al proximo.
 * lPop es ATOMICO: si dos mostradores llaman a la vez, cada uno saca un ticket
 * distinto. Es la garantia de exclusion mutua sin bloqueos aplicativos.
 */
app.post('/api/queue/farmacia/siguiente', requireAuth(['farmaceutico']), async (req, res, next) => {
  try {
    const redis = await getRedis();

    // Cerramos el que estaba siendo atendido.
    const anteriorRaw = await redis.get(KEYS.atendiendo);
    if (anteriorRaw) {
      const anterior = JSON.parse(anteriorRaw);
      if (anterior.retiroId) {
        // TFU5: en vez de llamar a pharmacy (POST sincrono), PUBLICAMOS el
        // hecho. pharmacy cierra el retiro y records marca la receta RETIRADA,
        // cada uno a su ritmo. Si el broker no confirma, NO avanzamos la cola
        // (503): perder este evento dejaria la receta "en retiro" para siempre.
        try {
          await publicar(TOPICOS.retiros, crearEvento('RetiroAtendido', {
            retiroId: anterior.retiroId, recetaId: anterior.recetaId || null,
            ticketCode: anterior.ticket, pacienteId: anterior.pacienteId
          }, { correlationId: req.correlationId }));
        } catch (err) {
          return res.status(503).json({
            error: 'No se pudo registrar la entrega (broker de eventos no disponible)',
            detalle: err.message
          });
        }
      }
      await redis.del(KEYS.ticket(anterior.ticket));
    }

    const codigo = await redis.lPop(KEYS.colaFarmacia);
    if (!codigo) {
      await redis.del(KEYS.atendiendo);
      return res.json({ mensaje: 'No hay nadie esperando', atendiendo: null });
    }

    const datos = await redis.hGetAll(KEYS.ticket(codigo));
    const actual = { ticket: codigo, ...datos, desde: new Date().toISOString() };
    await redis.set(KEYS.atendiendo, JSON.stringify(actual));

    // Aviso "es tu turno" + aviso a los que quedaron cerca del frente.
    if (datos.pacienteId && datos.pacienteId !== 'mostrador') {
      await notificar(redis, datos.pacienteId, 'Es tu turno',
        `Ticket ${codigo}: pasa al mostrador de farmacia.`, 'TurnoLlamado');
    }
    await avisarProximos(redis);

    res.json({ mensaje: 'Turno llamado', atendiendo: actual, atendidoPorInstancia: config.instanceId });
  } catch (err) { next(err); }
});

/**
 * Endpoint de apoyo para los scripts de carga (mide latencia bajo estres).
 * Se AMPLIA (sin romper el JSON existente) con el estado del stream de eventos:
 *   pendientesEnStream -> mensajes entregados pero todavia no reconocidos (ACK)
 *   totalEnStream      -> largo del stream (XLEN)
 * Es la evidencia de QUEUE-BASED LOAD LEVELING: la cola "absorbe" la rafaga y
 * la drena al ritmo del consumidor.
 */
app.get('/api/queue/farmacia/resumen', async (req, res, next) => {
  try {
    const redis = await getRedis();
    const largo = await redis.lLen(KEYS.colaFarmacia);

    let pendientesEnStream = 0;
    let totalEnStream = 0;
    try {
      // TFU5: el stream vive en el BROKER, no en el Redis de la cola.
      const broker = await getPublicador();
      totalEnStream = await broker.xLen(KEYS.streamRetiros);
      // XPENDING (forma resumen) -> cuantos mensajes quedaron sin ACK.
      pendientesEnStream = contarPendientes(await broker.xPending(KEYS.streamRetiros, KEYS.grupoCola));
    } catch (err) {
      // NOGROUP al arrancar (todavia no hay consumidor) o Redis caido: no rompemos.
      pendientesEnStream = 0;
    }

    res.json({
      esperando: largo,
      instancia: config.instanceId,
      pendientesEnStream,
      totalEnStream
    });
  } catch (err) { next(err); }
});

/** Normaliza las distintas formas en que puede volver XPENDING (RESP2/RESP3). */
function contarPendientes(p) {
  if (p == null) return 0;
  if (typeof p === 'number') return p;
  if (typeof p.total === 'number') return p.total;
  if (Array.isArray(p)) return Number(p[0]) || 0;
  return 0;
}


// ---------------------------------------------------------------------------
// PATRON QUEUE-BASED LOAD LEVELING + COMPETING CONSUMERS
//
// QUÉ RESUELVE: pharmacy recibe una rafaga de retiros y NO los procesa en la
// request. Los publica en un stream (Redis) y responde 201 enseguida. La cola
// hace de amortiguador (load leveling): absorbe el pico y el trabajo se hace a
// un ritmo controlado, independiente de la rafaga de entrada.
//
// COMPETING CONSUMERS: N replicas de queue-service leen el MISMO consumer group.
// Redis entrega cada mensaje a UN solo consumidor -> el trabajo se reparte y no
// se duplica. Si una replica muere a mitad de un mensaje, XAUTOCLAIM reasigna
// los pendientes a otra replica (no se pierden eventos).
// ---------------------------------------------------------------------------

/**
 * Procesa UN RetiroSolicitado: lo convierte en ticket de la cola.
 * Idempotente: si el ticket ya existe en la cola, no lo duplica (eso es lo que
 * permite que el bus reintente o reclame pendientes sin miedo).
 */
async function onEventoRetiro(evento) {
  if (evento.tipo !== 'RetiroSolicitado') return;   // RetiroAtendido lo publicamos nosotros
  const ev = evento.datos || {};
  if (!ev.ticketCode) throw new Error('RetiroSolicitado sin ticketCode');
  const principal = await getRedis();
  const existe = await principal.exists(KEYS.ticket(ev.ticketCode));
  if (existe) return;
  await principal.hSet(KEYS.ticket(ev.ticketCode), {
    ticket: ev.ticketCode,
    retiroId: ev.retiroId || '',
    recetaId: ev.recetaId || '',
    pacienteId: ev.pacienteId || '',
    medicamento: ev.medicamento || '',
    tipo: ev.tipo || 'VIRTUAL',
    creado: new Date().toISOString()
  });
  await principal.rPush(KEYS.colaFarmacia, ev.ticketCode);
  console.log(`[${NOMBRE}@${config.instanceId}] ticket ${ev.ticketCode} agregado a la cola`);
  await avisarProximos(principal);
}

app.use(errorHandler(NOMBRE));

(async () => {
  // Ojo: queue-service NO espera a PostgreSQL. No lo usa. Por eso la cola sigue
  // operativa aunque la base relacional este degradada (Basically Available).
  listen(app, NOMBRE);
  // PATRON QUEUE-BASED LOAD LEVELING + COMPETING CONSUMERS (TFU4) sobre el bus
  // de eventos (TFU5): N replicas comparten el grupo 'grupo-cola'; cada evento
  // lo procesa UNA. Los reintentos, XAUTOCLAIM y la DLQ los resuelve eventBus.
  suscribir({ topico: TOPICOS.retiros, grupo: KEYS.grupoCola, handler: onEventoRetiro,
              delayMs: config.consumerDelayMs })
    .catch((err) => console.error(`[${NOMBRE}] consumidor caido:`, err));
})();