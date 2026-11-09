'use strict';
/**
 * COMPONENTE: auth-service
 * 
 * Interfaz EXPUESTA : IAutenticacion  (login, perfil)
 * Interfaces CONSUMIDAS: ninguna (solo su schema en PostgreSQL)
 *
 * Conceptos que demuestra:
 *  - SERVICIO SIN ESTADO: emite un JWT autocontenido. No guarda sesiones, por lo
 *    que se puede replicar N veces sin ninguna coordinacion.
 * 
 */
const { createApp, listen, errorHandler } = require('../../shared/server');
const { query, waitForDb } = require('../../shared/db');
const { hashPassword, verifyPassword, signToken, requireAuth } = require('../../shared/auth');

const NOMBRE = 'auth-service';
const app = createApp(NOMBRE);

// UUID fijos: el init.sql siembra historias clinicas y medicos con estos mismos
// identificadores, asi todos los componentes "calzan" sin pasos manuales.
const USUARIOS_SEMILLA = [
  { id: '11111111-1111-1111-1111-111111111111', email: 'ana@paciente.uy',   rol: 'paciente',     nombre: 'Ana Perez',           pass: 'ana123' },
  { id: '22222222-2222-2222-2222-222222222222', email: 'beto@paciente.uy',  rol: 'paciente',     nombre: 'Beto Gomez',          pass: 'beto123' },
  { id: '33333333-3333-3333-3333-333333333333', email: 'lucia@clinica.uy',  rol: 'medico',       nombre: 'Dra. Lucia Fernandez',pass: 'lucia123' },
  { id: '44444444-4444-4444-4444-444444444444', email: 'martin@clinica.uy', rol: 'medico',       nombre: 'Dr. Martin Rossi',    pass: 'martin123' },
  { id: '55555555-5555-5555-5555-555555555555', email: 'farma@clinica.uy',  rol: 'farmaceutico', nombre: 'Sofia Lopez',         pass: 'farma123' },
  { id: '66666666-6666-6666-6666-666666666666', email: 'admin@clinica.uy',  rol: 'admin',        nombre: 'Admin Sistema',       pass: 'admin123' }
];

/** Siembra idempotente: si ya existen, no hace nada (ON CONFLICT DO NOTHING). */
async function sembrarUsuarios() {
  for (const u of USUARIOS_SEMILLA) {
    await query(
      `INSERT INTO auth.usuarios (id, email, password_hash, rol, nombre)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
      [u.id, u.email, hashPassword(u.pass), u.rol, u.nombre]
    );
  }
  console.log(`[${NOMBRE}] usuarios de prueba listos`);
}

// INTERFAZ EXPUESTA: IAutenticacion

/** POST /api/auth/login  devuelve el JWT */
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Faltan email y password' });

    const { rows } = await query('SELECT * FROM auth.usuarios WHERE email=$1', [email]);
    const usuario = rows[0];

    // Mismo mensaje para usuario inexistente y password incorrecta: no le
    // revelamos a un atacante que emails existen en el sistema.
    if (!usuario || !verifyPassword(password, usuario.password_hash)) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }

    res.json({
      token: signToken(usuario),
      usuario: { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol }
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/auth/yo -> valida el token y devuelve quien sos.
 * Sirve para demostrar que CUALQUIER replica valida el token sin consultar
 * ningun almacen de sesiones.
 */
app.get('/api/auth/yo', requireAuth(), (req, res) => {
  res.json({ usuario: req.usuario, validadoPor: process.env.HOSTNAME });
});

/** GET /api/auth/usuarios -> solo admin */
app.get('/api/auth/usuarios', requireAuth(['admin']), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, email, rol, nombre FROM auth.usuarios ORDER BY rol');
    res.json({ usuarios: rows });
  } catch (err) { next(err); }
});

app.use(errorHandler(NOMBRE));

(async () => {
  await waitForDb();
  await sembrarUsuarios();
  listen(app, NOMBRE);
})();