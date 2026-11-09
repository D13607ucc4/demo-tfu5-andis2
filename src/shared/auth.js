'use strict';
/**
 * AUTENTICACION / AUTORIZACION  clave del "servicio sin estado"
 * 
 * Usamos JWT en lugar de sesiones en memoria:
 *  - Sesion clasica: el server guarda {sessionId -> usuario} en RAM. Con 3
 *    replicas, la request que cae en la replica B no conoce la sesion creada en
 *    la replica A -> haria falta sticky sessions (rompe el balanceo) o un store
 *    externo (un salto de red mas por request).
 *  - JWT: el token viaja firmado con los datos del usuario. CUALQUIER replica lo
 *    valida con el secreto compartido sin consultar nada. Cero estado de sesion.
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('./config');

// --- Hash de contrasenas con scrypt (viene en la stdlib, sin binarios nativos) ---
function hashPassword(plano) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivada = crypto.scryptSync(plano, salt, 32).toString('hex');
  return `${salt}:${derivada}`;
}

function verifyPassword(plano, guardado) {
  const [salt, esperada] = String(guardado).split(':');
  if (!salt || !esperada) return false;
  const derivada = crypto.scryptSync(plano, salt, 32).toString('hex');
  const a = Buffer.from(derivada, 'hex');
  const b = Buffer.from(esperada, 'hex');
  // timingSafeEqual evita ataques por tiempo de comparacion.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Emision del token: lleva TODO lo que los otros componentes necesitan ---
function signToken(usuario) {
  return jwt.sign(
    { sub: usuario.id, rol: usuario.rol, nombre: usuario.nombre, email: usuario.email },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn, issuer: 'clinicare-auth' }
  );
}

/** Middleware: exige JWT valido y, opcionalmente, un rol de la lista. */
function requireAuth(rolesPermitidos = []) {
  return (req, res, next) => {
    // -----------------------------------------------------------------------
    // PATRON GATEKEEPER (defensa en profundidad): aunque el JWT sea valido,
    // exigimos ver la marca del gatekeeper. Asi, alguien que llegue DIRECTO a
    // la red interna (saltando el gateway) no puede operar. El JWT se sigue
    // verificando abajo: no confiamos solo en los headers del gatekeeper.
    // No afecta a requireInternal (interfaces internas) ni a /healthz.
    // -----------------------------------------------------------------------
    if (config.gatekeeperOnly && req.headers['x-gatekeeper-token'] !== config.gatekeeperToken) {
      return res.status(403).json({ error: 'Acceso directo no permitido' });
    }

    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Falta header Authorization: Bearer <token>' });

    try {
      const payload = jwt.verify(token, config.jwtSecret, { issuer: 'clinicare-auth' });
      req.usuario = { id: payload.sub, rol: payload.rol, nombre: payload.nombre, email: payload.email };
      if (rolesPermitidos.length && !rolesPermitidos.includes(payload.rol)) {
        return res.status(403).json({
          error: `Rol '${payload.rol}' no autorizado. Requiere: ${rolesPermitidos.join(', ')}`
        });
      }
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Token invalido o vencido', detalle: err.message });
    }
  };
}

/**
 * Middleware para INTERFACES INTERNAS (componente -> componente).
 * Ej: records le pregunta a scheduling si el medico tiene cita con ese paciente.
 * Esa interfaz no pasa por el gateway y exige un token de red interna.
 */
function requireInternal(req, res, next) {
  if (req.headers['x-internal-token'] !== config.internalToken) {
    return res.status(403).json({ error: 'Interfaz interna: token invalido' });
  }
  return next();
}

module.exports = { hashPassword, verifyPassword, signToken, requireAuth, requireInternal };