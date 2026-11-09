'use strict';
/**
 * POSTGRESQL  el lado ACID de la solucion
 * 
 * Lo que NO tolera inconsistencia (citas, historia clinica, recetas, auditoria)
 * vive aca, dentro de transacciones con garantias:
 *   A atomicidad   -> o se graban todos los pasos o ninguno (COMMIT/ROLLBACK)
 *   C consistencia -> constraints UNIQUE/FK impiden estados invalidos
 *   I aislamiento  -> SELECT ... FOR UPDATE serializa dos pacientes que pelean
 *                     por el mismo cupo de agenda
 *   D durabilidad  -> commiteado = escrito en disco
 */
const { Pool } = require('pg');
const config = require('./config');

// Un pool por PROCESO (no por request). Cada replica tiene el suyo.
const pool = new Pool({
  host: config.pg.host,
  port: config.pg.port,
  user: config.pg.user,
  password: config.pg.password,
  database: config.pg.database,
  max: config.pg.max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) =>
  console.error(`[${config.serviceName}] error en pool PG:`, err.message));

/** Consulta suelta (auto-commit), para lecturas simples. */
async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Ejecuta una funcion completa dentro de UNA transaccion.
 *   - Si la funcion retorna  -> COMMIT
 *   - Si la funcion lanza    -> ROLLBACK (se deshace TODO)
 * Esta es literalmente la demostracion de atomicidad del script 04.
 */
async function withTransaction(fn, { isolationLevel = 'READ COMMITTED' } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexion ya rota */ }
    throw err;
  } finally {
    // Siempre devolver la conexion al pool, si no se agota bajo carga.
    client.release();
  }
}

/** Espera activa a que la base este lista (arranque del contenedor). */
async function waitForDb(retries = 30, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      console.log(`[${config.serviceName}] esperando a PostgreSQL... (${i + 1}/${retries}) - motivo: ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('No se pudo conectar a PostgreSQL');
}

module.exports = { pool, query, withTransaction, waitForDb };