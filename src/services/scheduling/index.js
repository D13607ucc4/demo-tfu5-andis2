'use strict';
/**
 * COMPONENTE: scheduling-service      <<< AQUI SE DEMUESTRA ACID >>>
 * 
 * Interfaz EXPUESTA : IAgenda (especialidades, medicos, cupos, reservar cita)
 *                     IRelacionClinica (interna, SOAP + WSDL desde la TFU5;
 *                     la consume records-service)
 * Interfaces CONSUMIDAS: ninguna
 *
 * El problema real: dos pacientes tocan "reservar" sobre el MISMO cupo en el
 * mismo instante. Sin control, los dos reservan y el medico tiene doble agenda.
 * Solucion: transaccion con SELECT ... FOR UPDATE (bloqueo pesimista de fila).
 */
const { createApp, listen, errorHandler } = require('../../shared/server');
const { query, withTransaction, waitForDb } = require('../../shared/db');
const { requireAuth } = require('../../shared/auth');
const { getRedis, KEYS } = require('../../shared/redisClient');
const config = require('../../shared/config');
const fs = require('fs');
const path = require('path');
const soap = require('soap');

const NOMBRE = 'scheduling-service';
const app = createApp(NOMBRE);

// ---------------------------------------------------------------------------
// PATRON CACHE-ASIDE  -> atributo de calidad: PERFORMANCE
//
// Los catalogos (especialidades, medicos) y los cupos libres se leen MUCHO mas
// de lo que cambian. Cache-aside: la app consulta Redis primero; si hay HIT
// devuelve la copia, si hay MISS consulta PostgreSQL y guarda el resultado con
// TTL. La INVALIDACION es explicita (no esperamos el TTL) cuando se reserva una
// cita que cambia los cupos libres.
//
// Reglas de oro que se ven en el codigo:
//  - requireAuth corre ANTES del cache: nunca cacheamos algo que un rol no
//    puede ver (y ademas no mezclamos respuestas entre usuarios).
//  - El cache nunca puede tumbar el endpoint: cualquier error de Redis se
//    captura y se sigue contra PostgreSQL (X-Cache: BYPASS).
//  - Los errores de PostgreSQL NO se cachean (calcular() lanza y no se hace SET).
// ---------------------------------------------------------------------------

/** Corta una operacion contra Redis si se cuelga (no esperamos el timeout TCP). */
function conTimeout(promesa) {
  return Promise.race([
    promesa,
    new Promise((_, rechazar) =>
      setTimeout(() => rechazar(new Error('timeout de Redis')), config.cache.timeoutMs))
  ]);
}

/**
 * Aplica cache-aside. `calcular` produce el cuerpo a devolver/cachear.
 * Setea el header X-Cache y devuelve el cuerpo.
 */
async function cacheAside(res, clave, ttlSegundos, calcular) {
  if (!config.cache.enabled) {
    res.setHeader('X-Cache', 'BYPASS');
    return calcular();
  }

  let golpe = null;
  try {
    const redis = await getRedis();
    golpe = await conTimeout(redis.get(clave));
  } catch (err) {
    console.error(`[${NOMBRE}] cache GET fallo (${clave}): ${err.message}`);
    res.setHeader('X-Cache', 'BYPASS');
    return calcular();                        // degradacion a PostgreSQL
  }

  if (golpe) {
    res.setHeader('X-Cache', 'HIT');
    return JSON.parse(golpe);
  }

  const valor = await calcular();             // MISS: consultamos PostgreSQL
  try {
    const redis = await getRedis();
    await conTimeout(redis.set(clave, JSON.stringify(valor), { EX: ttlSegundos }));
    res.setHeader('X-Cache', 'MISS');
  } catch (err) {
    console.error(`[${NOMBRE}] cache SET fallo (${clave}): ${err.message}`);
    res.setHeader('X-Cache', 'BYPASS');
  }
  return valor;
}

/** Invalida copias de cupos. Nunca rompe la request que ya commiteo. */
async function invalidarSlots(medicoId, fecha) {
  if (!config.cache.enabled) return;
  const claves = [KEYS.cacheSlots(medicoId, fecha), KEYS.cacheSlots(medicoId, 'all')];
  try {
    const redis = await getRedis();
    await conTimeout(redis.del(claves));
  } catch (err) {
    console.error(`[${NOMBRE}] cache DEL fallo: ${err.message}`);
  }
}

// --- HU1: reservar citas segun especialidad, doctor, dia y hora -------------

app.get('/api/scheduling/especialidades', requireAuth(), async (req, res, next) => {
  try {
    const cuerpo = await cacheAside(res, KEYS.cacheEspecialidades, config.cache.ttlCatalogo, async () => {
      const { rows } = await query('SELECT * FROM scheduling.especialidades ORDER BY nombre');
      return { especialidades: rows };
    });
    res.json(cuerpo);
  } catch (err) { next(err); }
});

app.get('/api/scheduling/medicos', requireAuth(), async (req, res, next) => {
  try {
    const { especialidad } = req.query;
    const clave = KEYS.cacheMedicos(especialidad);
    const cuerpo = await cacheAside(res, clave, config.cache.ttlCatalogo, async () => {
      const { rows } = await query(
        `SELECT m.id, m.nombre, e.nombre AS especialidad
         FROM scheduling.medicos m
         JOIN scheduling.especialidades e ON e.id = m.especialidad_id
         WHERE ($1::int IS NULL OR e.id = $1::int)
         ORDER BY m.nombre`,
        [especialidad || null]
      );
      return { medicos: rows };
    });
    res.json(cuerpo);
  } catch (err) { next(err); }
});

/** GET /api/scheduling/slots?medico=<uuid>&fecha=YYYY-MM-DD -> cupos libres */
app.get('/api/scheduling/slots', requireAuth(), async (req, res, next) => {
  try {
    const { medico, fecha } = req.query;
    if (!medico) return res.status(400).json({ error: 'Falta el parametro medico' });

    const clave = KEYS.cacheSlots(medico, fecha);
    // TTL corto: los cupos cambian seguido; ademas los invalidamos al reservar.
    const cuerpo = await cacheAside(res, clave, config.cache.ttlSlots, async () => {
      const { rows } = await query(
        `SELECT id, inicio, estado
         FROM scheduling.agenda_slots
         WHERE medico_id = $1
           AND estado = 'LIBRE'
           AND ($2::date IS NULL OR inicio::date = $2::date)
         ORDER BY inicio
         LIMIT 50`,
        [medico, fecha || null]
      );
      return { cantidad: rows.length, slots: rows };
    });
    res.json(cuerpo);
  } catch (err) { next(err); }
});

/**
 * POST /api/scheduling/citas   body: { slotId, forzarError? }
 * 
 * *** NUCLEO DE LA DEMO ACID ***
 *
 * Paso a paso de lo que garantiza cada propiedad:
 *  1) BEGIN
 *  2) SELECT ... FOR UPDATE  -> AISLAMIENTO. La fila del cupo queda bloqueada.
 *     Si otra transaccion intenta lo mismo, se QUEDA ESPERANDO en esta linea
 *     hasta que la primera haga COMMIT. Cuando despierta, lee el estado ya
 *     actualizado ('RESERVADO') y aborta con 409. Nunca hay doble reserva.
 *  3) UPDATE del cupo + INSERT de la cita -> ATOMICIDAD: si el INSERT falla, el
 *     UPDATE tambien se deshace y el cupo vuelve a quedar LIBRE.
 *  4) COMMIT -> DURABILIDAD.
 *
 * El flag forzarError=true simula una falla despues del UPDATE para mostrar en
 * vivo el ROLLBACK (script 04).
 */
app.post('/api/scheduling/citas', requireAuth(['paciente']), async (req, res, next) => {
  const { slotId, forzarError } = req.body || {};
  if (!slotId) return res.status(400).json({ error: 'Falta slotId' });

  try {
    const cita = await withTransaction(async (client) => {
      // (2) BLOQUEO PESIMISTA de la fila del cupo.
      const { rows } = await client.query(
        `SELECT id, medico_id, inicio, estado
         FROM scheduling.agenda_slots
         WHERE id = $1
         FOR UPDATE`,
        [slotId]
      );

      const slot = rows[0];
      if (!slot) {
        const e = new Error('El cupo no existe'); e.status = 404; throw e;
      }
      // Quien llega segundo ve el estado ya actualizado por el primero.
      if (slot.estado !== 'LIBRE') {
        const e = new Error('El cupo ya fue reservado por otro paciente'); e.status = 409; throw e;
      }

      // (3a) Marcamos el cupo como ocupado.
      await client.query(
        `UPDATE scheduling.agenda_slots SET estado='RESERVADO' WHERE id=$1`, [slotId]
      );

      // Simulacion de falla para demostrar el ROLLBACK.
      if (forzarError) {
        throw new Error('FALLA SIMULADA despues del UPDATE: el cupo debe volver a LIBRE');
      }

      // (3b) Creamos la cita. Si esto explota, el UPDATE de arriba se revierte.
      const ins = await client.query(
        `INSERT INTO scheduling.citas (slot_id, paciente_id, medico_id)
         VALUES ($1,$2,$3)
         RETURNING id, slot_id, paciente_id, medico_id, estado, creada_en`,
        [slotId, req.usuario.id, slot.medico_id]
      );

      return { ...ins.rows[0], inicio: slot.inicio };
    });

    // PATRON CACHE-ASIDE: recien DESPUES del commit invalidamos las copias de
    // cupos. Si la transaccion hizo ROLLBACK llegamos aca por el catch y NO se
    // invalida (no hubo cambio que propagar). Se borran la clave del dia del
    // slot y la clave "all" (la consulta sin filtro de fecha).
    const fechaSlot = cita.inicio instanceof Date
      ? cita.inicio.toISOString().slice(0, 10)
      : String(cita.inicio).slice(0, 10);
    await invalidarSlots(cita.medico_id, fechaSlot);

    res.status(201).json({ mensaje: 'Cita reservada', cita });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    // 23505 = violacion de UNIQUE: la red de seguridad del motor actuo.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Cupo ya reservado (constraint UNIQUE)' });
    }
    next(err);
  }
});

app.get('/api/scheduling/citas/mias', requireAuth(['paciente']), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.estado, s.inicio, m.nombre AS medico
       FROM scheduling.citas c
       JOIN scheduling.agenda_slots s ON s.id = c.slot_id
       JOIN scheduling.medicos m      ON m.id = c.medico_id
       WHERE c.paciente_id = $1
       ORDER BY s.inicio`,
      [req.usuario.id]
    );
    res.json({ citas: rows });
  } catch (err) { next(err); }
});

/** Agenda del medico logueado (HU5: saber a quien esta atendiendo). */
app.get('/api/scheduling/citas/agenda', requireAuth(['medico']), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.paciente_id, c.estado, s.inicio
       FROM scheduling.citas c
       JOIN scheduling.agenda_slots s ON s.id = c.slot_id
       WHERE c.medico_id = $1 AND c.estado IN ('AGENDADA','EN_CURSO')
       ORDER BY s.inicio`,
      [req.usuario.id]
    );
    res.json({ citas: rows });
  } catch (err) { next(err); }
});

/**
 * POST /api/scheduling/citas/:id/iniciar
 * Marca la consulta como EN_CURSO. Esto es lo que HABILITA al medico a leer la
 * historia clinica: sin consulta en curso, records-service le niega el acceso.
 */
app.post('/api/scheduling/citas/:id/iniciar', requireAuth(['medico']), async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE scheduling.citas SET estado='EN_CURSO'
       WHERE id=$1 AND medico_id=$2 AND estado='AGENDADA'
       RETURNING id, paciente_id, estado`,
      [req.params.id, req.usuario.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Cita no encontrada o no agendada' });
    res.json({ mensaje: 'Consulta iniciada', cita: rows[0] });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// INTERFAZ INTERNA: IRelacionClinica  (la consume records-service)
//
// TFU5 - MIGRACION REST -> SOAP
// Antes: GET /api/scheduling/internal/relacion?medicoId&pacienteId -> JSON.
// Ahora: servicio SOAP 1.1 document/literal en /soap/relacion-clinica, con
// contrato WSDL en ./relacion-clinica.wsdl (GET /soap/relacion-clinica?wsdl).
// La funcionalidad es EXACTAMENTE la misma (misma consulta SQL); cambia el
// contrato (tipado, validable) y el formato (XML).
//
// En la arquitectura de eventos esta es la unica dependencia SINCRONA que
// dejamos a proposito: es una decision de autorizacion sobre datos clinicos y
// necesita el estado ACTUAL de la consulta, no una replica eventual.
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Error en formato SOAP Fault (el cliente lo recibe como <soap:Fault>). */
function soapFault(codigo, mensaje) {
  return { Fault: { faultcode: codigo, faultstring: mensaje, statusCode: codigo === 'soap:Client' ? 400 : 500 } };
}

const servicioRelacionClinica = {
  RelacionClinicaService: {
    RelacionClinicaPort: {
      ConsultarRelacionClinica: async (args) => {
        const medicoId = String((args && args.medicoId) || '');
        const pacienteId = String((args && args.pacienteId) || '');
        if (!UUID_RE.test(medicoId) || !UUID_RE.test(pacienteId)) {
          throw soapFault('soap:Client', 'medicoId y pacienteId deben ser UUID');
        }
        let rows;
        try {
          ({ rows } = await query(
            `SELECT id FROM scheduling.citas
             WHERE medico_id=$1 AND paciente_id=$2 AND estado='EN_CURSO' LIMIT 1`,
            [medicoId, pacienteId]));
        } catch (err) {
          throw soapFault('soap:Server', `Error consultando la agenda: ${err.message}`);
        }
        const consultadoEn = new Date().toISOString();
        // El orden de las claves respeta el xsd:sequence del WSDL.
        return rows[0]
          ? { consultaEnCurso: true, citaId: rows[0].id, consultadoEn }
          : { consultaEnCurso: false, consultadoEn };
      }
    }
  }
};

const WSDL = fs.readFileSync(path.join(__dirname, 'relacion-clinica.wsdl'), 'utf8');

app.use(errorHandler(NOMBRE));

(async () => {
  await waitForDb();
  const server = listen(app, NOMBRE);
  // El servicio SOAP se monta sobre el MISMO servidor HTTP (puerto 3000).
  const soapServer = soap.listen(server, '/soap/relacion-clinica', servicioRelacionClinica, WSDL);
  // Interfaz interna: exige el token de red interna (como las REST internas de
  // la TFU4). El WSDL (GET ?wsdl) es publico dentro de la red: es el contrato.
  // Ojo: soap.listen sobre un http.Server evalua este hook para TODAS las
  // requests del puerto (tambien las REST); por eso filtramos por ruta.
  soapServer.authorizeConnection = (req, res) => {
    if (!String(req.url).startsWith('/soap/')) return true;
    if (req.method === 'GET') return true;
    if (req.headers['x-internal-token'] === config.internalToken) return true;
    res.statusCode = 403;
    return false;
  };
  soapServer.log = (tipo, datos) => {
    if (tipo === 'error') console.error(`[${NOMBRE}][soap] ${datos && datos.message ? datos.message : datos}`);
  };
  console.log(`[${NOMBRE}] SOAP IRelacionClinica en /soap/relacion-clinica (WSDL: ?wsdl)`);
})();