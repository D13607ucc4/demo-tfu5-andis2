'use strict';
/**
 * FABRICA DE SERVIDORES HTTP
 * 
 * Todos los componentes comparten el mismo esqueleto:
 *  - /healthz: lo usa Docker (healthcheck) y nginx para no mandar trafico a una
 *    replica caida. Expone tambien el estado de los CIRCUIT BREAKERS del proceso.
 *  - Header X-Served-By con el id del contenedor: es la evidencia visible del
 *    balanceo entre replicas (mismo request, distinta instancia responde).
 *  - Correlation-Id: permite seguir una operacion que atraviesa 3 componentes.
 */
const express = require('express');
const config = require('./config');
const { circuitSnapshot } = require('./httpClient');
const { snapshotEventos } = require('./eventBus');

function createApp(nombre, { jsonLimit } = {}) {
  const app = express();
  // El limite del body es configurable: el gatekeeper lo usa para rechazar
  // cuerpos grandes (413) antes de tocar los servicios de negocio.
  app.use(express.json({ limit: jsonLimit || '100kb' }));
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const inicio = Date.now();
    req.correlationId = req.headers['x-correlation-id'] || `cid-${Math.random().toString(36).slice(2, 10)}`;
    res.setHeader('X-Correlation-Id', req.correlationId);
    res.setHeader('X-Served-By', `${nombre}@${config.instanceId}`);
    res.on('finish', () => {
      console.log(`[${nombre}@${config.instanceId}] ${req.method} ${req.originalUrl} -> ` +
                  `${res.statusCode} (${Date.now() - inicio}ms) cid=${req.correlationId}`);
    });
    next();
  });

  // Health check barato: no toca la base, para no volverse un cuello de botella.
  // Ademas expone el estado de los circuit breakers hacia cada dependencia.
  // TFU5: ademas muestra los contadores de eventos consumidos por grupo y, si
  // el componente tiene outbox, cuantos eventos esperan ser publicados.
  app.get('/healthz', (req, res) =>
    res.json({
      ok: true, componente: nombre, instancia: config.instanceId,
      circuits: circuitSnapshot(),
      eventos: snapshotEventos(),
      ...(app.locals.estadoExtra ? app.locals.estadoExtra() : {})
    }));

  return app;
}

/** Arranque + apagado ordenado (importante al reescalar contenedores). */
function listen(app, nombre) {
  const server = app.listen(config.port, '0.0.0.0', () =>
    console.log(`[${nombre}@${config.instanceId}] escuchando en :${config.port}`));

  // Docker manda SIGTERM al bajar o reescalar: cerramos sin cortar requests en vuelo.
  const cerrar = () => {
    console.log(`[${nombre}@${config.instanceId}] SIGTERM, cerrando...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', cerrar);
  process.on('SIGINT', cerrar);
  return server;
}

function errorHandler(nombre) {
  return (err, req, res, _next) => {
    // Errores que levanta express.json (validacion del body en el gatekeeper).
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Cuerpo de la solicitud demasiado grande', detalle: err.message });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'JSON invalido en el cuerpo', detalle: err.message });
    }
    console.error(`[${nombre}] ERROR:`, err.message);
    res.status(err.status || 500).json({ error: err.publicMessage || 'Error interno', detalle: err.message });
  };
}

module.exports = { createApp, listen, errorHandler };
