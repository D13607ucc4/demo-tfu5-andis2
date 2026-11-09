'use strict';
/**
 * PATRON TRANSACTIONAL OUTBOX   (TFU5 - falacia "la red es confiable")
 *
 * PROBLEMA (lo teniamos en la TFU4): pharmacy hacia
 *     1) COMMIT del retiro en PostgreSQL
 *     2) XADD del evento en Redis   ("fire and forget", en un try/catch)
 * Son DOS sistemas distintos y no hay transaccion que los abarque. Si la red o
 * el broker fallan entre 1 y 2, el retiro existe pero el evento NUNCA sale: el
 * paciente tiene ticket y nunca aparece en la cola. Silenciosamente.
 * Y al reves (publicar primero y despues hacer COMMIT) es peor: un evento de
 * algo que nunca ocurrio.
 *
 * SOLUCION: el evento se escribe en una tabla <schema>.outbox DENTRO de la
 * MISMA transaccion ACID que el cambio de negocio. O se graban los dos o
 * ninguno. Un proceso aparte (relay) lee lo pendiente y lo publica en el
 * broker; recien cuando el broker confirma lo marca como publicado. Si el
 * broker esta caido, los eventos ESPERAN en la tabla y salen cuando vuelve.
 *
 * Consecuencia: el relay puede publicar un evento DOS veces (publica, se cae
 * antes de marcarlo). Por eso el sobre lleva un id estable (el de la fila) y
 * los consumidores son idempotentes (inbox.js). At-least-once + idempotencia
 * = efecto exactly-once.
 *
 * Con varias replicas del mismo servicio, FOR UPDATE SKIP LOCKED reparte las
 * filas entre los relays sin que dos publiquen la misma fila a la vez.
 */
const config = require('./config');
const { pool } = require('./db');
const { publicar, crearEvento } = require('./eventBus');

const SCHEMAS_VALIDOS = new Set(['records', 'pharmacy']);

function validarSchema(schema) {
  if (!SCHEMAS_VALIDOS.has(schema)) throw new Error(`schema de outbox invalido: ${schema}`);
}

/**
 * Registra un evento en el outbox USANDO EL CLIENTE DE LA TRANSACCION en curso.
 * No publica nada: solo garantiza que el evento queda atado al COMMIT.
 */
async function registrarEvento(client, schema, { topico, tipo, datos, correlationId }) {
  validarSchema(schema);
  const ev = crearEvento(tipo, datos, { correlationId });
  await client.query(
    `INSERT INTO ${schema}.outbox (id, topico, tipo, datos, correlation_id, ocurrido_en)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ev.id, topico, tipo, JSON.stringify(datos), ev.correlationId, ev.ocurridoEn]);
  return ev.id;
}

const estado = { publicados: 0, fallosPublicacion: 0, ultimoError: null, pendientes: 0 };

/** Una pasada del relay. Devuelve cuantos publico. */
async function pasada(schema) {
  const client = await pool.connect();
  let publicados = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, topico, tipo, datos, correlation_id, ocurrido_en
       FROM ${schema}.outbox
       WHERE publicado_en IS NULL
       ORDER BY creado_en
       LIMIT $1
       FOR UPDATE SKIP LOCKED`, [config.outbox.lote]);

    for (const fila of rows) {
      const ev = {
        id: fila.id, tipo: fila.tipo, version: 1, origen: config.serviceName,
        ocurridoEn: new Date(fila.ocurrido_en).toISOString(),
        correlationId: fila.correlation_id, datos: fila.datos
      };
      try {
        await publicar(fila.topico, ev);
        await client.query(
          `UPDATE ${schema}.outbox SET publicado_en = now(), intentos = intentos + 1 WHERE id = $1`, [fila.id]);
        publicados += 1;
      } catch (err) {
        // El broker no responde: dejamos esta fila (y las siguientes) para la
        // proxima pasada. Cortamos el lote para respetar el orden de creacion.
        await client.query(
          `UPDATE ${schema}.outbox SET intentos = intentos + 1, ultimo_error = $2 WHERE id = $1`,
          [fila.id, String(err.message).slice(0, 300)]);
        estado.fallosPublicacion += 1;
        if (estado.ultimoError !== err.message) {
          console.error(`[${config.serviceName}] outbox: no se pudo publicar (${err.message}); se reintenta`);
        }
        estado.ultimoError = err.message;
        break;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexion rota */ }
    estado.ultimoError = err.message;
  } finally {
    client.release();
  }
  if (publicados > 0) {
    estado.publicados += publicados;
    if (estado.ultimoError) console.log(`[${config.serviceName}] outbox: broker recuperado, publicados ${publicados}`);
    estado.ultimoError = null;
  }
  return publicados;
}

/**
 * Verifica que la base tenga las tablas de la TFU5. Postgres solo corre
 * init.sql con el volumen vacio: un volumen de la TFU4 no las tiene.
 */
async function verificarEsquema(schema) {
  try {
    const { rows } = await pool.query(
      `SELECT to_regclass($1) AS outbox, to_regclass($2) AS inbox`,
      [`${schema}.outbox`, `${schema}.eventos_procesados`]);
    if (!rows[0].outbox || !rows[0].inbox) {
      const msg = `FALTAN LAS TABLAS DE LA TFU5 (${schema}.outbox / ${schema}.eventos_procesados). ` +
        'El volumen de PostgreSQL es de una version anterior: ejecutar ' +
        '"docker compose down -v && docker compose up -d --build".';
      estado.ultimoError = msg;
      console.error(`[${config.serviceName}] *** ${msg} ***`);
      return false;
    }
    return true;
  } catch (_) { return true; }
}

/** Arranca el relay en segundo plano. */
function arrancarRelay(schema) {
  validarSchema(schema);
  verificarEsquema(schema);
  let corriendo = false;
  const t = setInterval(async () => {
    if (corriendo) return;            // nunca dos pasadas solapadas en el proceso
    corriendo = true;
    try {
      // Si el lote vino lleno, seguimos sin esperar al proximo tick.
      while ((await pasada(schema)) >= config.outbox.lote) { /* drenar */ }
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${schema}.outbox WHERE publicado_en IS NULL`);
      estado.pendientes = rows[0].n;
    } catch (_) { /* la base puede estar arrancando */ }
    finally { corriendo = false; }
  }, config.outbox.pollMs);
  t.unref();
  console.log(`[${config.serviceName}] relay del outbox ${schema}.outbox activo (cada ${config.outbox.pollMs}ms)`);
}

function snapshotOutbox() { return { ...estado }; }

module.exports = { registrarEvento, arrancarRelay, snapshotOutbox };
