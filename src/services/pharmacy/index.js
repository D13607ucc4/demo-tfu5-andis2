'use strict';
/**
 * COMPONENTE: pharmacy-service        <<< PRODUCTOR Y CONSUMIDOR DE EVENTOS >>>
 *
 * Interfaz EXPUESTA : IFarmacia (solicitar retiro, ver mis retiros, ver mis
 *                     recetas disponibles, ver pendientes)
 * Interfaces CONSUMIDAS: NINGUNA sincrona (TFU5). Solo eventos.
 *
 * TFU5 - CAMBIO DE ESTILO (de SOA sincrono a EDA):
 *   En la TFU4, por cada retiro pharmacy le preguntaba a records por REST si la
 *   receta existia (GET /internal/recetas/:id) y despues le avisaba el cambio
 *   de estado (POST /internal/recetas/:id/estado). Si records estaba caido, la
 *   farmacia no podia entregar nada (el Circuit Breaker solo hacia que fallara
 *   RAPIDO, pero fallaba).
 *
 *   Ahora pharmacy mantiene su PROPIA REPLICA de las recetas
 *   (pharmacy.recetas), alimentada por el evento RecetaEmitida que publica
 *   records (patron Event-Carried State Transfer). La validacion del retiro es
 *   LOCAL: no hay ningun salto de red en el camino del paciente.
 *
 *   PUBLICA  (via outbox): RetiroSolicitado            -> eventos:retiros
 *   CONSUME              : RecetaEmitida   (eventos:recetas)  -> replica local
 *                          RetiroAtendido  (eventos:retiros)  -> cierra el retiro
 *
 * Trade-off aceptado: CONSISTENCIA EVENTUAL. Una receta recien emitida tarda
 * unos cientos de milisegundos en aparecer en la farmacia. Si el paciente
 * pide el retiro en ese instante recibe 404 con Retry-After. A cambio, la
 * farmacia sigue operando con records caido.
 */
const { createApp, listen, errorHandler } = require('../../shared/server');
const { query, withTransaction, waitForDb } = require('../../shared/db');
const { requireAuth } = require('../../shared/auth');
const { TOPICOS, suscribir } = require('../../shared/eventBus');
const { registrarEvento, arrancarRelay, snapshotOutbox } = require('../../shared/outbox');
const { procesarUnaVez } = require('../../shared/inbox');

const NOMBRE = 'pharmacy-service';
const app = createApp(NOMBRE);
app.locals.estadoExtra = () => ({ outbox: snapshotOutbox() });

/**
 * POST /api/pharmacy/retiros   body: { recetaId }
 * Devuelve el ticket INMEDIATAMENTE. Todo ocurre en UNA transaccion local:
 *   1) bloquea la receta en la replica local (FOR UPDATE)
 *   2) valida duenio y estado
 *   3) crea el retiro y marca la receta EN_RETIRO
 *   4) registra el evento RetiroSolicitado en el OUTBOX
 * Nada de esto toca la red. El relay publica el evento despues del COMMIT.
 */
app.post('/api/pharmacy/retiros', requireAuth(['paciente']), async (req, res, next) => {
  const { recetaId } = req.body || {};
  if (!recetaId) return res.status(400).json({ error: 'Falta recetaId' });

  try {
    const resultado = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT receta_id, paciente_id, medicamento, estado
         FROM pharmacy.recetas WHERE receta_id = $1 FOR UPDATE`, [recetaId]);
      const receta = rows[0];
      if (!receta) return { status: 404 };
      if (receta.paciente_id !== req.usuario.id) return { status: 403 };
      if (receta.estado !== 'DISPONIBLE') return { status: 409, estado: receta.estado };

      const nro = (await client.query("SELECT nextval('pharmacy.ticket_seq') AS n")).rows[0].n;
      const ticket = `F-${String(nro).padStart(3, '0')}`;
      const retiro = (await client.query(
        `INSERT INTO pharmacy.retiros (receta_id, paciente_id, ticket_code)
         VALUES ($1,$2,$3) RETURNING *`,
        [recetaId, req.usuario.id, ticket])).rows[0];

      await client.query(
        `UPDATE pharmacy.recetas SET estado='EN_RETIRO', actualizada_en=now() WHERE receta_id=$1`,
        [recetaId]);

      // PATRON TRANSACTIONAL OUTBOX: el evento queda atado al COMMIT.
      await registrarEvento(client, 'pharmacy', {
        topico: TOPICOS.retiros,
        tipo: 'RetiroSolicitado',
        correlationId: req.correlationId,
        datos: {
          retiroId: retiro.id, recetaId, pacienteId: retiro.paciente_id,
          ticketCode: retiro.ticket_code, medicamento: receta.medicamento, tipo: 'VIRTUAL'
        }
      });
      return { status: 201, retiro };
    });

    if (resultado.status === 404) {
      // Consistencia eventual: puede ser una receta recien emitida que todavia
      // no llego por el evento. Le decimos al cliente que reintente en 1s.
      res.setHeader('Retry-After', '1');
      return res.status(404).json({
        error: 'Receta no disponible en farmacia',
        detalle: 'Si se acaba de emitir, puede tardar unos instantes en llegar (consistencia eventual).'
      });
    }
    if (resultado.status === 403) {
      return res.status(403).json({ error: 'La receta no pertenece al paciente autenticado' });
    }
    if (resultado.status === 409) {
      return res.status(409).json({ error: 'La receta ya fue retirada o esta en retiro', estado: resultado.estado });
    }

    const { retiro } = resultado;
    res.status(201).json({
      mensaje: 'Retiro solicitado. Ya estas en la cola virtual, no hace falta esperar en la sala.',
      ticket: retiro.ticket_code,
      retiroId: retiro.id,
      nota: 'La cola puede tardar unos milisegundos en reflejarlo (consistencia eventual).'
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un retiro para esa receta' });
    next(err);
  }
});

app.get('/api/pharmacy/retiros/mios', requireAuth(['paciente']), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, ticket_code, estado, creada_en FROM pharmacy.retiros
       WHERE paciente_id=$1 ORDER BY creada_en DESC`, [req.usuario.id]);
    res.json({ retiros: rows });
  } catch (err) { next(err); }
});

/**
 * TFU5: GET /api/pharmacy/recetas/mias
 * Lo que la FARMACIA sabe de las recetas del paciente (su replica local). Sirve
 * para ver la consistencia eventual: una receta recien emitida aparece aca
 * unos milisegundos despues de aparecer en records.
 */
app.get('/api/pharmacy/recetas/mias', requireAuth(['paciente']), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT receta_id AS id, medicamento, estado, actualizada_en
       FROM pharmacy.recetas WHERE paciente_id=$1 ORDER BY actualizada_en DESC`, [req.usuario.id]);
    res.json({ recetas: rows });
  } catch (err) { next(err); }
});

/** HU7: el farmaceutico ve los retiros pendientes segun el registro maestro. */
app.get('/api/pharmacy/retiros/pendientes', requireAuth(['farmaceutico']), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, ticket_code, paciente_id, creada_en FROM pharmacy.retiros
       WHERE estado='EN_COLA' ORDER BY creada_en`);
    res.json({ cantidad: rows.length, retiros: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// CONSUMIDORES DE EVENTOS (idempotentes)
// ---------------------------------------------------------------------------

/** RecetaEmitida -> alta en la replica local. */
async function onEventoReceta(evento) {
  if (evento.tipo !== 'RecetaEmitida') return;
  const d = evento.datos || {};
  if (!d.recetaId || !d.pacienteId) throw new Error('RecetaEmitida sin recetaId/pacienteId');
  await procesarUnaVez('pharmacy', 'pharmacy-recetas', evento, (client) =>
    client.query(
      `INSERT INTO pharmacy.recetas (receta_id, paciente_id, medicamento, estado)
       VALUES ($1,$2,$3,'DISPONIBLE') ON CONFLICT (receta_id) DO NOTHING`,
      [d.recetaId, d.pacienteId, d.medicamento || '']));
}

/**
 * RetiroAtendido (lo publica queue-service cuando el farmaceutico entrega) ->
 * cierra el retiro. Reemplaza al POST /internal/retiros/:id/atendido de la TFU4.
 */
async function onEventoRetiro(evento) {
  if (evento.tipo !== 'RetiroAtendido') return;
  const d = evento.datos || {};
  await procesarUnaVez('pharmacy', 'pharmacy-retiros', evento, async (client) => {
    const { rows } = await client.query(
      `UPDATE pharmacy.retiros SET estado='ATENDIDO'
       WHERE id=$1 AND estado='EN_COLA' RETURNING receta_id`, [d.retiroId]);
    if (rows[0]) {
      await client.query(
        `UPDATE pharmacy.recetas SET estado='RETIRADA', actualizada_en=now() WHERE receta_id=$1`,
        [rows[0].receta_id]);
    }
  });
}

app.use(errorHandler(NOMBRE));

(async () => {
  await waitForDb();
  listen(app, NOMBRE);
  arrancarRelay('pharmacy');
  // desde '0': al crear el grupo por primera vez se procesa TODA la historia
  // del topico. Asi la replica local se reconstruye sola desde los eventos.
  suscribir({ topico: TOPICOS.recetas, grupo: 'pharmacy', handler: onEventoReceta })
    .catch((err) => console.error(`[${NOMBRE}] suscripcion recetas:`, err.message));
  suscribir({ topico: TOPICOS.retiros, grupo: 'pharmacy', handler: onEventoRetiro })
    .catch((err) => console.error(`[${NOMBRE}] suscripcion retiros:`, err.message));
})();
