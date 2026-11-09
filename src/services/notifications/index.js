'use strict';
/**
 * COMPONENTE: notifications-service       (HU3)
 * 
 * Interfaz EXPUESTA : INotificaciones (bandeja del paciente)
 * Interfaz CONSUMIDA: topicos eventos:turnos y eventos:retiros del broker
 *
 * TFU5: en la TFU4 escuchaba un canal PUB/SUB. Pub/sub es "fire and forget":
 * si notifications estaba reiniciando en ese segundo, el aviso "es tu turno"
 * se perdia para siempre (falacia "la red es confiable"). Ahora consume
 * STREAMS con consumer group: si esta caido, los eventos lo esperan.
 * Ademas, como la entrega es at-least-once, deduplica por id de evento.
 *
 * Es un SUSCRIPTOR: queue-service publica "acercate al mostrador" sin saber
 * quien escucha. Manana se agrega un componente que manda SMS suscribiendose al
 * mismo canal, sin tocar una linea de queue-service.
 * FACILIDAD DE MODIFICACION por bajo acoplamiento.
 */
const { createApp, listen, errorHandler } = require('../../shared/server');
const { requireAuth } = require('../../shared/auth');
const { getRedis, KEYS } = require('../../shared/redisClient');
const { TOPICOS, suscribir } = require('../../shared/eventBus');
const { procesarUnaVezRedis } = require('../../shared/inbox');

const NOMBRE = 'notifications-service';
const app = createApp(NOMBRE);

/** GET /api/notifications/mias -> la app del paciente hace polling aca. */
app.get('/api/notifications/mias', requireAuth(['paciente']), async (req, res, next) => {
  try {
    const redis = await getRedis();
    const items = await redis.lRange(KEYS.notificaciones(req.usuario.id), 0, 19);
    res.json({ cantidad: items.length, notificaciones: items.map((i) => JSON.parse(i)) });
  } catch (err) { next(err); }
});

/** Guarda la notificacion en la bandeja del paciente (ultimas 20). */
async function guardar(redis, n) {
  // lPush + lTrim: estado blando (soft state), tipico de BASE.
  await redis.lPush(KEYS.notificaciones(n.pacienteId), JSON.stringify(n));
  await redis.lTrim(KEYS.notificaciones(n.pacienteId), 0, 19);
  console.log(`[${NOMBRE}] notificacion para ${n.pacienteId}: ${n.titulo}`);
}

/** TurnoProximo / TurnoLlamado (los publica queue-service). */
async function onEventoTurno(evento) {
  const d = evento.datos || {};
  if (!d.pacienteId) return;
  const redis = await getRedis();
  await procesarUnaVezRedis(redis, 'notifications', evento, () => guardar(redis, {
    pacienteId: d.pacienteId, titulo: d.titulo, mensaje: d.mensaje,
    tipo: evento.tipo, eventoId: evento.id, ts: evento.ocurridoEn
  }));
}

/**
 * RetiroSolicitado (lo publica pharmacy): acuse de recibo al paciente.
 * Es un consumidor NUEVO del mismo evento que ya consumen queue y records:
 * se agrego sin tocar el productor (fan-out por consumer groups).
 */
async function onEventoRetiro(evento) {
  if (evento.tipo !== 'RetiroSolicitado') return;
  const d = evento.datos || {};
  if (!d.pacienteId) return;
  const redis = await getRedis();
  await procesarUnaVezRedis(redis, 'notifications', evento, () => guardar(redis, {
    pacienteId: d.pacienteId, titulo: 'Recibimos tu solicitud de retiro',
    mensaje: `Tu ticket es ${d.ticketCode}. Te avisamos cuando estes cerca del mostrador.`,
    tipo: evento.tipo, eventoId: evento.id, ts: evento.ocurridoEn
  }));
}

app.use(errorHandler(NOMBRE));

(async () => {
  listen(app, NOMBRE);
  suscribir({ topico: TOPICOS.turnos, grupo: 'notifications', handler: onEventoTurno })
    .catch((err) => console.error(`[${NOMBRE}] suscripcion turnos:`, err.message));
  suscribir({ topico: TOPICOS.retiros, grupo: 'notifications', handler: onEventoRetiro })
    .catch((err) => console.error(`[${NOMBRE}] suscripcion retiros:`, err.message));
})();