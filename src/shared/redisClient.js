'use strict';
/**
 * REDIS  el lado BASE de la solucion
 * 
 * La COLA HIBRIDA y las NOTIFICACIONES usan Redis:
 *   Basically Available   -> la cola sigue respondiendo aunque PostgreSQL este lento
 *   Soft state            -> el estado de la cola es efimero (vive el dia)
 *   Eventually consistent -> el retiro se graba en PostgreSQL y viaja por un
 *                            stream de eventos; durante unos milisegundos la
 *                            cola todavia no lo muestra (script 05).
 *
 * Ademas es lo que hace posible que queue-service sea SIN ESTADO: el estado de
 * la cola no vive en la memoria del proceso, vive afuera. Por eso 3 replicas
 * ven exactamente la misma cola.
 */
const { createClient } = require('redis');
const config = require('./config');

async function makeRedis(etiqueta = 'main') {
  const client = createClient({ url: config.redisUrl });
  client.on('error', (err) =>
    console.error(`[${config.serviceName}][redis:${etiqueta}] ${err.message}`));
  await client.connect();
  return client;
}

let clientePrincipal = null;
async function getRedis() {
  if (!clientePrincipal) clientePrincipal = await makeRedis('main');
  return clientePrincipal;
}

// Claves y canales centralizados (para no repetir strings sueltos por ahi).
const KEYS = {
  colaFarmacia: 'cola:farmacia',                 // lista FIFO de tickets esperando
  ticket: (code) => `cola:ticket:${code}`,       // hash con los datos del ticket
  atendiendo: 'cola:farmacia:atendiendo',        // ticket en el mostrador
  notificaciones: (pid) => `notif:${pid}`,       // bandeja del paciente
  // TFU5: el stream vive en el BROKER (ver eventBus.js, TOPICOS.retiros). Se
  // mantiene el nombre para que el script 10 de la TFU4 siga funcionando.
  streamRetiros: 'eventos:retiros',              // stream que emite pharmacy
  grupoCola: 'grupo-cola',                       // consumer group: cada evento lo
                                                 // procesa UNA sola replica
  // (TFU4) canal pub/sub hacia notifications. En la TFU5 se reemplazo por el
  // topico durable eventos:turnos del broker.

  // --- CACHE-ASIDE (patron de performance) ---
  // Copias de lecturas caras en Redis. El prefijo "cache:sch:" permite borrar
  // todo el cache de scheduling de golpe (redis-cli --scan --pattern).
  cacheEspecialidades: 'cache:sch:especialidades',
  cacheMedicos: (especialidad) => `cache:sch:medicos:${especialidad || 'all'}`,
  cacheSlots: (medico, fecha) => `cache:sch:slots:${medico}:${fecha || 'all'}`
};

module.exports = { makeRedis, getRedis, KEYS };