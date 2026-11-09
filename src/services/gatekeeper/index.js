'use strict';
/**
 * COMPONENTE: gatekeeper-service      <<< PATRON GATEKEEPER (seguridad) >>>
 *
 * Interfaz EXPUESTA : TODA la API (es la unica puerta de entrada real).
 * Interfaces CONSUMIDAS: las interfaces internas de auth, scheduling, records,
 *                        pharmacy, queue y notifications (les hace de proxy).
 *
 * POR QUE UN GATEKEEPER Y NO DEJAR LAS VALIDACIONES EN CADA SERVICIO:
 * centralizamos en UN punto las decisiones transversales de seguridad, en vez
 * de repetirlas (y desincronizarlas) en 6 componentes. Los servicios se
 * concentran en su negocio. Es el mismo motivo por el que el sistema tiene un
 * API Gateway, pero un nivel mas adentro: el gateway hace balanceo/offloading,
 * el gatekeeper hace CONTROL DE ACCESO y saneamiento.
 *
 * DEFENSA EN PROFUNDIDAD: el gatekeeper valida el JWT y el rol ANTES de tocar
 * los servicios; ADEMAS los servicios exigen ver la marca X-Gatekeeper-Token
 * (PATRON GATEKEEPER_ONLY en src/shared/auth.js) para rechazar el acceso
 * directo por la red interna. Si alguien saltea el gateway, igual no pasa.
 *
 * GATEKEEPER vs GATEWAY: el gateway (nginx) es infraestructura; el gatekeeper
 * es un componente de aplicacion que entiende el modelo de roles del dominio.
 */
const http = require('http');
const jwt = require('jsonwebtoken');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const { createApp, listen, errorHandler } = require('../../shared/server');
const config = require('../../shared/config');

const NOMBRE = 'gatekeeper';
// El limite del body se aplica con express.json: > limite => 413; JSON roto => 400.
const app = createApp(NOMBRE, { jsonLimit: config.gatekeeperMaxBody });

// ---------------------------------------------------------------------------
// TABLA DE POLITICAS (allow-list explicita).
//
// Regla de oro: ruta NO listada => 404 (no se proxea nada por defecto).
//  - publico: no exige token (login y el resumen de cola que usan los scripts).
//  - roles:   lista de roles autorizados (se valida contra el JWT).
//  - destino: componente al que se reenvía por DNS interno.
//
// Los roles replican EXACTAMENTE lo que verifican los servicios (requireAuth),
// pero aca se cortan antes de llegar al servicio. Es defensa en profundidad,
// no reemplazo: el servicio vuelve a verificar el JWT.
// ---------------------------------------------------------------------------
const POLITICAS = [
  // --- auth-service ---
  { metodo: 'POST', patron: /^\/api\/auth\/login$/,              publico: true, destino: 'auth' },
  { metodo: 'GET',  patron: /^\/api\/auth\/yo$/,                               destino: 'auth' },
  { metodo: 'GET',  patron: /^\/api\/auth\/usuarios$/,           roles: ['admin'], destino: 'auth' },

  // --- scheduling-service ---
  { metodo: 'GET',  patron: /^\/api\/scheduling\/especialidades$/,             destino: 'scheduling' },
  { metodo: 'GET',  patron: /^\/api\/scheduling\/medicos$/,                    destino: 'scheduling' },
  { metodo: 'GET',  patron: /^\/api\/scheduling\/slots$/,                      destino: 'scheduling' },
  { metodo: 'POST', patron: /^\/api\/scheduling\/citas$/,        roles: ['paciente'], destino: 'scheduling' },
  { metodo: 'GET',  patron: /^\/api\/scheduling\/citas\/mias$/,  roles: ['paciente'], destino: 'scheduling' },
  { metodo: 'GET',  patron: /^\/api\/scheduling\/citas\/agenda$/, roles: ['medico'], destino: 'scheduling' },
  { metodo: 'POST', patron: /^\/api\/scheduling\/citas\/[^/]+\/iniciar$/, roles: ['medico'], destino: 'scheduling' },

  // --- records-service ---
  { metodo: 'GET',  patron: /^\/api\/records\/pacientes\/[^/]+\/historia$/,     destino: 'records' },
  { metodo: 'POST', patron: /^\/api\/records\/pacientes\/[^/]+\/entradas$/, roles: ['medico'], destino: 'records' },
  { metodo: 'POST', patron: /^\/api\/records\/recetas$/,         roles: ['medico'], destino: 'records' },
  { metodo: 'GET',  patron: /^\/api\/records\/recetas\/mias$/,   roles: ['paciente'], destino: 'records' },
  { metodo: 'GET',  patron: /^\/api\/records\/auditoria$/,       roles: ['admin'], destino: 'records' },

  // --- pharmacy-service ---
  { metodo: 'POST', patron: /^\/api\/pharmacy\/retiros$/,              roles: ['paciente'], destino: 'pharmacy' },
  { metodo: 'GET',  patron: /^\/api\/pharmacy\/retiros\/mios$/,        roles: ['paciente'], destino: 'pharmacy' },
  { metodo: 'GET',  patron: /^\/api\/pharmacy\/retiros\/pendientes$/,  roles: ['farmaceutico'], destino: 'pharmacy' },
  // TFU5: replica local de recetas en farmacia (evidencia de consistencia eventual).
  { metodo: 'GET',  patron: /^\/api\/pharmacy\/recetas\/mias$/,        roles: ['paciente'], destino: 'pharmacy' },
  // TFU5: replica local de recetas en farmacia (evidencia de consistencia eventual).
  { metodo: 'GET',  patron: /^\/api\/pharmacy\/recetas\/mias$/,       roles: ['paciente'], destino: 'pharmacy' },

  // --- queue-service ---
  { metodo: 'GET',  patron: /^\/api\/queue\/farmacia$/,                    destino: 'queue' },
  // Endpoint de apoyo (mide carga/BASE). Se deja publico para no romper los
  // scripts 0-6, que lo consultan sin token a proposito.
  { metodo: 'GET',  patron: /^\/api\/queue\/farmacia\/resumen$/, publico: true, destino: 'queue' },
  { metodo: 'GET',  patron: /^\/api\/queue\/mi-turno$/,           roles: ['paciente'], destino: 'queue' },
  { metodo: 'POST', patron: /^\/api\/queue\/farmacia\/presencial$/, roles: ['farmaceutico'], destino: 'queue' },
  { metodo: 'POST', patron: /^\/api\/queue\/farmacia\/siguiente$/,  roles: ['farmaceutico'], destino: 'queue' },

  // --- notifications-service ---
  { metodo: 'GET',  patron: /^\/api\/notifications\/mias$/,      roles: ['paciente'], destino: 'notifications' }
];

const DESTINOS = {
  auth: config.urls.auth,
  scheduling: config.urls.scheduling,
  records: config.urls.records,
  pharmacy: config.urls.pharmacy,
  queue: config.urls.queue,
  notifications: config.urls.notifications
};

// ---------------------------------------------------------------------------
// Proxies: UNO POR DESTINO, creado una sola vez.
//
// agent keepAlive:false es a proposito: con keepAlive, http-proxy reutilizaria
// un socket fijo y el DNS interno no se re-resuelve, con lo cual al hacer
// `docker compose up --scale queue=3` el gatekeeper seguiria pegandole a una
// sola replica. Sin keepAlive, cada request abre conexion nueva -> round-robin.
// ---------------------------------------------------------------------------
const agentePlano = new http.Agent({ keepAlive: false });
const proxies = {};

function proxyDe(destino) {
  if (!proxies[destino]) {
    proxies[destino] = createProxyMiddleware({
      target: DESTINOS[destino],
      changeOrigin: false,
      agent: agentePlano,
      on: {
        // Re-escribe el body ya parseado por express.json hacia el upstream.
        proxyReq: fixRequestBody,
        error: (err, req, res) => {
          console.error(`[${NOMBRE}] error proxeando a ${destino}: ${err.message}`);
          if (!res.headersSent) {
            res.status(502).json({ error: 'Servicio destino no disponible', detalle: err.message });
          }
        }
      }
    });
  }
  return proxies[destino];
}

// ---------------------------------------------------------------------------
// SANEAMIENTO DE HEADERS.
// Borramos todo lo que un cliente NO debe poder inyectar hacia adentro y
// dejamos la marca del gatekeeper + la identidad resuelta del JWT.
// ---------------------------------------------------------------------------
function sanearHeaders(req, usuario) {
  for (const nombre of Object.keys(req.headers)) {
    const n = nombre.toLowerCase();
    if (n.startsWith('x-user-') || n === 'x-internal-token' || n === 'x-gatekeeper-token') {
      delete req.headers[nombre];
    }
  }
  // Sello del gatekeeper: los servicios lo exigen (GATEKEEPER_ONLY).
  req.headers['x-gatekeeper-token'] = config.gatekeeperToken;
  // Identidad derivada del JWT, no de headers del cliente.
  if (usuario) {
    req.headers['x-user-id'] = usuario.id;
    req.headers['x-user-rol'] = usuario.rol;
  }
  // Trazabilidad: si nginx no mando correlation-id, createApp genero uno.
  req.headers['x-correlation-id'] = req.correlationId;
}

function extraerUsuario(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return { error: 401, mensaje: 'Falta header Authorization: Bearer <token>' };
  try {
    const payload = jwt.verify(token, config.jwtSecret, { issuer: 'clinicare-auth' });
    return { usuario: { id: payload.sub, rol: payload.rol, nombre: payload.nombre, email: payload.email } };
  } catch (err) {
    return { error: 401, mensaje: 'Token invalido o vencido', detalle: err.message };
  }
}

// ---------------------------------------------------------------------------
// Middleware principal: resolver politica + autorizar + validar + proxear.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  // createApp ya atiende /healthz y no llega aca para esa ruta.
  const politica = POLITICAS.find((p) => p.metodo === req.method && p.patron.test(req.path));
  if (!politica) {
    return res.status(404).json({ error: 'Ruta no encontrada', patron: 'gatekeeper' });
  }

  // 4) Validacion de Content-Type en peticiones con cuerpo.
  const largo = Number(req.headers['content-length'] || 0);
  const conCuerpo = ['POST', 'PUT', 'PATCH'].includes(req.method) && largo > 0;
  if (conCuerpo) {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.includes('application/json')) {
      return res.status(415).json({ error: 'Content-Type debe ser application/json' });
    }
  }

  let usuario = null;
  if (!politica.publico) {
    // 2) Autenticacion y autorizacion ANTES de tocar el servicio.
    const resultado = extraerUsuario(req);
    if (resultado.error) return res.status(resultado.error).json(resultado);
    usuario = resultado.usuario;
    if (politica.roles && politica.roles.length && !politica.roles.includes(usuario.rol)) {
      return res.status(403).json({
        error: `Rol '${usuario.rol}' no autorizado. Requiere: ${politica.roles.join(', ')}`
      });
    }
  }

  // 3) Saneamiento de headers + sello del gatekeeper.
  sanearHeaders(req, usuario);

  // 5) Proxy por DNS interno al destino (sin keepAlive, ver nota arriba).
  return proxyDe(politica.destino)(req, res, next);
});

app.use(errorHandler(NOMBRE));

listen(app, NOMBRE);
console.log(`[${NOMBRE}] politicas cargadas: ${POLITICAS.length}`);
