'use strict';
/**
 * PATRON IDEMPOTENT CONSUMER (inbox)   (TFU5 - falacia "la red es confiable")
 *
 * El broker entrega AT-LEAST-ONCE: el mismo evento puede llegar dos veces
 * (reintento tras un timeout, XAUTOCLAIM de un consumidor que murio, el relay
 * del outbox que publico y se cayo antes de marcar la fila). Si el consumidor
 * aplica el efecto dos veces, rompe el negocio (dos notificaciones, un estado
 * que retrocede, etc).
 *
 * Solucion para consumidores con PostgreSQL: registramos el id del evento en
 * <schema>.eventos_procesados DENTRO DE LA MISMA TRANSACCION que el efecto.
 *  - Si el INSERT choca con la PK => ya lo procesamos: no hacemos nada (y el
 *    bus hace ACK igual, asi no se reintenta para siempre).
 *  - Si el efecto falla => ROLLBACK de las dos cosas => el reintento lo vuelve
 *    a aplicar desde cero.
 *
 * Para consumidores que solo usan Redis (queue, notifications) la marca se
 * guarda con SET NX en el mismo Redis donde vive su estado (ver procesarUnaVezRedis).
 */
const { withTransaction } = require('./db');

const SCHEMAS_VALIDOS = new Set(['records', 'pharmacy']);

/**
 * Ejecuta fn(client) una sola vez por (consumidor, evento).
 * Devuelve true si se aplico, false si era un duplicado.
 */
async function procesarUnaVez(schema, consumidor, evento, fn) {
  if (!SCHEMAS_VALIDOS.has(schema)) throw new Error(`schema invalido: ${schema}`);
  return withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO ${schema}.eventos_procesados (evento_id, consumidor, tipo)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [evento.id, consumidor, evento.tipo]);
    if (ins.rowCount === 0) {
      console.log(`[${consumidor}] duplicado ignorado: ${evento.tipo} ${evento.id}`);
      return false;
    }
    await fn(client);
    return true;
  });
}

/**
 * Variante Redis: marca el evento como procesado con SET NX (TTL 7 dias).
 * Si fn falla, borramos la marca para que el reintento lo aplique.
 */
async function procesarUnaVezRedis(redis, consumidor, evento, fn) {
  const clave = `procesado:${consumidor}:${evento.id}`;
  const nuevo = await redis.set(clave, '1', { NX: true, EX: 7 * 24 * 3600 });
  if (!nuevo) {
    console.log(`[${consumidor}] duplicado ignorado: ${evento.tipo} ${evento.id}`);
    return false;
  }
  try {
    await fn();
    return true;
  } catch (err) {
    await redis.del(clave).catch(() => {});
    throw err;
  }
}

module.exports = { procesarUnaVez, procesarUnaVezRedis };
