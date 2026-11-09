'use strict';
/**
 * COMPONENTE: records-service   <<< CONFIDENCIALIDAD + TRAZABILIDAD >>>
 * 
 * Interfaz EXPUESTA : IHistoriaClinica (leer historia, crear entrada, recetar)
 * Interfaz CONSUMIDA: IRelacionClinica de scheduling-service (SOAP, sincrona)
 *
 * TFU5 - EVENTOS:
 *   PUBLICA  (via outbox) : RecetaEmitida            -> eventos:recetas
 *   CONSUME              : RetiroSolicitado, RetiroAtendido (eventos:retiros)
 *                          para mantener el estado de la receta.
 *   Ya NO expone la interfaz interna IRecetas (REST): pharmacy dejo de
 *   preguntarle por cada retiro. Ahora pharmacy tiene su propia replica de las
 *   recetas, alimentada por el evento RecetaEmitida. Si records se cae, la
 *   farmacia sigue entregando (ese es el atributo de calidad de la TFU5).
 *
 * Reglas de acceso al dato sensible:
 *  - un paciente ve UNICAMENTE su propia historia,
 *  - un medico ve la historia SOLO si tiene una consulta EN_CURSO con ese
 *    paciente (need-to-know / minimo privilegio),
 *  - TODO acceso, permitido o denegado, queda registrado en records.auditoria.
 */
const { createApp, listen, errorHandler } = require('../../shared/server');
const { query, withTransaction, waitForDb } = require('../../shared/db');
const { requireAuth } = require('../../shared/auth');
const { TOPICOS, suscribir } = require('../../shared/eventBus');
const { registrarEvento, arrancarRelay, snapshotOutbox } = require('../../shared/outbox');
const { procesarUnaVez } = require('../../shared/inbox');
const { consultarRelacionClinica } = require('./relacionClinicaSoap');

const NOMBRE = 'records-service';
const app = createApp(NOMBRE);
app.locals.estadoExtra = () => ({ outbox: snapshotOutbox() });

/** Escribe el registro de auditoria. Nunca rompe la request principal. */
async function auditar({ actor, accion, recurso, pacienteId, resultado, motivo }) {
  try {
    await query(
      `INSERT INTO records.auditoria (actor_id, actor_rol, accion, recurso, paciente_id, resultado, motivo)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor.id, actor.rol, accion, recurso, pacienteId || null, resultado, motivo || null]
    );
  } catch (err) {
    console.error(`[${NOMBRE}] no se pudo auditar:`, err.message);
  }
}

/**
 * Politica de acceso centralizada.
 * Aca se ve la DEPENDENCIA ENTRE COMPONENTES: para decidir, records necesita
 * preguntarle a scheduling. No duplica la agenda: consume su interfaz.
 * TFU5: la consulta viaja por SOAP (XML, contrato WSDL). Es SINCRONA a
 * proposito: un permiso sobre datos clinicos no puede basarse en una copia
 * eventualmente consistente de la agenda.
 */
async function puedeVerHistoria(usuario, pacienteId, correlationId) {
  if (usuario.rol === 'paciente') {
    return usuario.id === pacienteId
      ? { permitido: true, motivo: 'Es su propia historia' }
      : { permitido: false, motivo: 'Un paciente solo accede a su propia historia' };
  }

  if (usuario.rol === 'medico') {
    const r = await consultarRelacionClinica(usuario.id, pacienteId, correlationId);
    // Si la dependencia no responde, NEGAMOS (fail-secure). Ante la duda con
    // datos clinicos, el default es denegar, no permitir.
    if (!r.ok) {
      return { permitido: false, motivo: r.circuitoAbierto
        ? 'No se pudo verificar la relacion clinica (circuito abierto hacia scheduling)'
        : `No se pudo verificar la relacion clinica (${r.motivo})` };
    }
    return r.consultaEnCurso
      ? { permitido: true, motivo: 'Consulta en curso con el paciente' }
      : { permitido: false, motivo: 'El medico no tiene consulta en curso con este paciente' };
  }

  // Ni el admin del sistema lee datos clinicos: solo administra la plataforma.
  return { permitido: false, motivo: `Rol '${usuario.rol}' no accede a datos clinicos` };
}

// --- HU4 y HU5: ver historia clinica ---------------------------------------
app.get('/api/records/pacientes/:pacienteId/historia', requireAuth(), async (req, res, next) => {
  const { pacienteId } = req.params;
  try {
    const decision = await puedeVerHistoria(req.usuario, pacienteId, req.correlationId);

    await auditar({
      actor: req.usuario, accion: 'LEER_HISTORIA',
      recurso: `historia:${pacienteId}`, pacienteId,
      resultado: decision.permitido ? 'PERMITIDO' : 'DENEGADO', motivo: decision.motivo
    });

    if (!decision.permitido) return res.status(403).json({ error: 'Acceso denegado', motivo: decision.motivo });

    const historia = (await query(
      'SELECT * FROM records.historias WHERE paciente_id=$1', [pacienteId])).rows[0];
    if (!historia) return res.status(404).json({ error: 'El paciente no tiene historia clinica' });

    const entradas = (await query(
      `SELECT id, medico_id, motivo, diagnostico, creada_en
       FROM records.entradas WHERE historia_id=$1 ORDER BY creada_en DESC`, [historia.id])).rows;

    const recetas = (await query(
      `SELECT id, medicamento, dosis, estado, creada_en
       FROM records.recetas WHERE historia_id=$1 ORDER BY creada_en DESC`, [historia.id])).rows;

    res.json({ historia: { id: historia.id, pacienteId }, entradas, recetas, accesoPor: decision.motivo });
  } catch (err) { next(err); }
});

/** POST entrada clinica (evolucion) - solo medico con consulta en curso. */
app.post('/api/records/pacientes/:pacienteId/entradas', requireAuth(['medico']), async (req, res, next) => {
  const { pacienteId } = req.params;
  const { motivo, diagnostico } = req.body || {};
  if (!motivo || !diagnostico) return res.status(400).json({ error: 'Faltan motivo y diagnostico' });

  try {
    const decision = await puedeVerHistoria(req.usuario, pacienteId, req.correlationId);
    await auditar({ actor: req.usuario, accion: 'CREAR_ENTRADA', recurso: `historia:${pacienteId}`,
                    pacienteId, resultado: decision.permitido ? 'PERMITIDO' : 'DENEGADO', motivo: decision.motivo });
    if (!decision.permitido) return res.status(403).json({ error: 'Acceso denegado', motivo: decision.motivo });

    const historia = (await query('SELECT id FROM records.historias WHERE paciente_id=$1', [pacienteId])).rows[0];
    if (!historia) return res.status(404).json({ error: 'Sin historia clinica' });

    const { rows } = await query(
      `INSERT INTO records.entradas (historia_id, medico_id, motivo, diagnostico)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [historia.id, req.usuario.id, motivo, diagnostico]);
    res.status(201).json({ entrada: rows[0] });
  } catch (err) { next(err); }
});

/**
 * HU6: POST /api/records/recetas  body: { pacienteId, medicamento, dosis }
 * Transaccion ACID: la receta y su registro de auditoria se graban juntos o no
 * se graban. Una receta sin rastro de quien la emitio seria inaceptable para el
 * requisito de trazabilidad.
 */
app.post('/api/records/recetas', requireAuth(['medico']), async (req, res, next) => {
  const { pacienteId, medicamento, dosis } = req.body || {};
  if (!pacienteId || !medicamento || !dosis) {
    return res.status(400).json({ error: 'Faltan pacienteId, medicamento o dosis' });
  }
  try {
    const decision = await puedeVerHistoria(req.usuario, pacienteId, req.correlationId);
    if (!decision.permitido) {
      await auditar({ actor: req.usuario, accion: 'EMITIR_RECETA', recurso: `paciente:${pacienteId}`,
                      pacienteId, resultado: 'DENEGADO', motivo: decision.motivo });
      return res.status(403).json({ error: 'Acceso denegado', motivo: decision.motivo });
    }

    const receta = await withTransaction(async (client) => {
      const historia = (await client.query(
        'SELECT id FROM records.historias WHERE paciente_id=$1', [pacienteId])).rows[0];
      if (!historia) { const e = new Error('Sin historia clinica'); e.status = 404; throw e; }

      const ins = await client.query(
        `INSERT INTO records.recetas (historia_id, paciente_id, medico_id, medicamento, dosis)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [historia.id, pacienteId, req.usuario.id, medicamento, dosis]);

      // Auditoria DENTRO de la misma transaccion: atomicidad receta+rastro.
      await client.query(
        `INSERT INTO records.auditoria (actor_id, actor_rol, accion, recurso, paciente_id, resultado, motivo)
         VALUES ($1,$2,'EMITIR_RECETA',$3,$4,'PERMITIDO',$5)`,
        [req.usuario.id, req.usuario.rol, `receta:${ins.rows[0].id}`, pacienteId, decision.motivo]);

      // TFU5 - TRANSACTIONAL OUTBOX: el evento RecetaEmitida se graba en la
      // MISMA transaccion. receta + auditoria + evento: los tres o ninguno.
      // No llamamos al broker aca; lo hace el relay despues del COMMIT.
      const r = ins.rows[0];
      await registrarEvento(client, 'records', {
        topico: TOPICOS.recetas,
        tipo: 'RecetaEmitida',
        correlationId: req.correlationId,
        datos: {
          recetaId: r.id, pacienteId: r.paciente_id, medicoId: r.medico_id,
          medicamento: r.medicamento, dosis: r.dosis, emitidaEn: r.creada_en
        }
      });

      return r;
    });

    res.status(201).json({ mensaje: 'Receta emitida', receta });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** El paciente ve sus recetas (para despues pedir el retiro en farmacia). */
app.get('/api/records/recetas/mias', requireAuth(['paciente']), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, medicamento, dosis, estado, creada_en
       FROM records.recetas WHERE paciente_id=$1 ORDER BY creada_en DESC`, [req.usuario.id]);
    res.json({ recetas: rows });
  } catch (err) { next(err); }
});

/** Trazabilidad: el admin audita accesos, pero NO ve contenido clinico. */
app.get('/api/records/auditoria', requireAuth(['admin']), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT actor_id, actor_rol, accion, recurso, resultado, motivo, creada_en
       FROM records.auditoria ORDER BY creada_en DESC LIMIT 30`);
    res.json({ registros: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// TFU5 - CONSUMIDOR DE EVENTOS (reemplaza la interfaz interna REST IRecetas)
//
// Antes pharmacy llamaba POST /internal/recetas/:id/estado. Ahora records
// REACCIONA a los hechos que publica la farmacia y la cola:
//   RetiroSolicitado -> la receta pasa a EN_RETIRO
//   RetiroAtendido   -> la receta pasa a RETIRADA
// Idempotente (inbox): el mismo evento dos veces no cambia nada. Las
// transiciones solo avanzan (EMITIDA -> EN_RETIRO -> RETIRADA): si llegan
// desordenadas, un evento "viejo" no hace retroceder el estado.
// ---------------------------------------------------------------------------
const ORDEN_ESTADO = { EMITIDA: 0, EN_RETIRO: 1, RETIRADA: 2 };

async function avanzarEstadoReceta(client, recetaId, nuevo) {
  if (!recetaId) return;
  await client.query(
    `UPDATE records.recetas SET estado = $2
     WHERE id = $1 AND (CASE estado WHEN 'EMITIDA' THEN 0 WHEN 'EN_RETIRO' THEN 1 ELSE 2 END) < $3`,
    [recetaId, nuevo, ORDEN_ESTADO[nuevo]]);
}

async function onEventoRetiro(evento) {
  const nuevo = { RetiroSolicitado: 'EN_RETIRO', RetiroAtendido: 'RETIRADA' }[evento.tipo];
  if (!nuevo) return;                                  // no nos interesa: ACK y listo
  await procesarUnaVez('records', 'records-retiros', evento, (client) =>
    avanzarEstadoReceta(client, evento.datos.recetaId, nuevo));
}

app.use(errorHandler(NOMBRE));

(async () => {
  await waitForDb();
  listen(app, NOMBRE);
  arrancarRelay('records');                                   // outbox -> broker
  suscribir({ topico: TOPICOS.retiros, grupo: 'records', handler: onEventoRetiro })
    .catch((err) => console.error(`[${NOMBRE}] no se pudo suscribir:`, err.message));
})();