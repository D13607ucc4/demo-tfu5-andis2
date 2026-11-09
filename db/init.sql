-- ESQUEMA DE DATOS
-- 
-- Decision: UN SCHEMA POR COMPONENTE dentro de la misma instancia PostgreSQL.
-- Cada servicio solo lee/escribe su propio schema; NO hay foreign keys entre
-- schemas. Eso simula "base de datos por servicio" (los componentes quedan
-- desacoplados a nivel de datos) sin el costo de levantar 4 contenedores de
-- base para una demo. En produccion cada schema seria una instancia separada.
--
-- Los IDs de usuario son UUID fijos y conocidos, porque el servicio auth
-- siembra los mismos valores al arrancar. Asi la data de prueba "calza".
-- 

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS scheduling;
CREATE SCHEMA IF NOT EXISTS records;
CREATE SCHEMA IF NOT EXISTS pharmacy;

-- AUTH: usuarios y roles
CREATE TABLE auth.usuarios (
    id            UUID PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    rol           TEXT NOT NULL CHECK (rol IN ('paciente','medico','farmaceutico','admin')),
    nombre        TEXT NOT NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- SCHEDULING: especialidades, medicos, cupos de agenda y citas
CREATE TABLE scheduling.especialidades (
    id     SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL UNIQUE
);

CREATE TABLE scheduling.medicos (
    id              UUID PRIMARY KEY,          -- mismo UUID que su usuario en auth
    nombre          TEXT NOT NULL,
    especialidad_id INT NOT NULL REFERENCES scheduling.especialidades(id)
);

-- Un "slot" es un cupo de 30 minutos en la agenda de un medico.
CREATE TABLE scheduling.agenda_slots (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    medico_id UUID NOT NULL REFERENCES scheduling.medicos(id),
    inicio    TIMESTAMPTZ NOT NULL,
    estado    TEXT NOT NULL DEFAULT 'LIBRE' CHECK (estado IN ('LIBRE','RESERVADO')),
    -- CONSISTENCIA (la C de ACID): a nivel de motor es imposible que un medico
    -- tenga dos cupos en el mismo instante.
    UNIQUE (medico_id, inicio)
);

CREATE TABLE scheduling.citas (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- UNIQUE = ultima linea de defensa contra la doble reserva. Aunque fallara
    -- el bloqueo aplicativo, la base rechaza la segunda cita sobre el mismo cupo.
    slot_id    UUID NOT NULL UNIQUE REFERENCES scheduling.agenda_slots(id),
    paciente_id UUID NOT NULL,
    medico_id   UUID NOT NULL REFERENCES scheduling.medicos(id),
    estado      TEXT NOT NULL DEFAULT 'AGENDADA'
                CHECK (estado IN ('AGENDADA','EN_CURSO','FINALIZADA','CANCELADA')),
    creada_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_citas_paciente ON scheduling.citas(paciente_id);
CREATE INDEX idx_citas_medico   ON scheduling.citas(medico_id);
CREATE INDEX idx_slots_busqueda ON scheduling.agenda_slots(medico_id, estado, inicio);

-- ---------------------------------------------------------------------------
-- RECORDS: historia clinica, recetas y AUDITORIA (dato sensible)
-- ---------------------------------------------------------------------------
CREATE TABLE records.historias (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paciente_id UUID NOT NULL UNIQUE,
    creada_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE records.entradas (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    historia_id UUID NOT NULL REFERENCES records.historias(id),
    medico_id   UUID NOT NULL,
    motivo      TEXT NOT NULL,
    diagnostico TEXT NOT NULL,
    creada_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE records.recetas (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    historia_id UUID NOT NULL REFERENCES records.historias(id),
    paciente_id UUID NOT NULL,
    medico_id   UUID NOT NULL,
    medicamento TEXT NOT NULL,
    dosis       TEXT NOT NULL,
    estado      TEXT NOT NULL DEFAULT 'EMITIDA'
                CHECK (estado IN ('EMITIDA','EN_RETIRO','RETIRADA')),
    creada_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- TRAZABILIDAD: todo acceso a datos clinicos deja registro inmutable.
-- Requisito no funcional del dominio (informacion sensible).
CREATE TABLE records.auditoria (
    id          BIGSERIAL PRIMARY KEY,
    actor_id    UUID NOT NULL,
    actor_rol   TEXT NOT NULL,
    accion      TEXT NOT NULL,          -- LEER_HISTORIA, CREAR_ENTRADA, EMITIR_RECETA
    recurso     TEXT NOT NULL,
    paciente_id UUID,
    resultado   TEXT NOT NULL,          -- PERMITIDO / DENEGADO
    motivo      TEXT,
    creada_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auditoria_fecha ON records.auditoria(creada_en DESC);

-- PHARMACY: solicitudes de retiro
CREATE SEQUENCE pharmacy.ticket_seq START 1;

CREATE TABLE pharmacy.retiros (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- UNIQUE: no se puede pedir dos veces el retiro de la misma receta.
    receta_id   UUID NOT NULL UNIQUE,
    paciente_id UUID NOT NULL,
    ticket_code TEXT NOT NULL UNIQUE,
    estado      TEXT NOT NULL DEFAULT 'EN_COLA'
                CHECK (estado IN ('EN_COLA','ATENDIDO','CANCELADO')),
    creada_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===========================================================================
-- TFU5 - ARQUITECTURA BASADA EN EVENTOS
-- ===========================================================================

-- PATRON TRANSACTIONAL OUTBOX: los eventos se escriben aca, en la MISMA
-- transaccion que el cambio de negocio. El relay del servicio los publica en
-- el broker y recien entonces completa publicado_en.
CREATE TABLE records.outbox (
    id             UUID PRIMARY KEY,                  -- = id del evento (estable)
    topico         TEXT NOT NULL,
    tipo           TEXT NOT NULL,
    datos          JSONB NOT NULL,
    correlation_id TEXT,
    ocurrido_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    publicado_en   TIMESTAMPTZ,
    intentos       INT NOT NULL DEFAULT 0,
    ultimo_error   TEXT
);
CREATE INDEX idx_records_outbox_pend ON records.outbox(creado_en) WHERE publicado_en IS NULL;

CREATE TABLE pharmacy.outbox (LIKE records.outbox INCLUDING ALL);

-- PATRON IDEMPOTENT CONSUMER (inbox): ids de eventos ya aplicados. El INSERT va
-- en la misma transaccion que el efecto; un duplicado choca con la PK.
CREATE TABLE records.eventos_procesados (
    evento_id    TEXT NOT NULL,
    consumidor   TEXT NOT NULL,
    tipo         TEXT,
    procesado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumidor, evento_id)
);
CREATE TABLE pharmacy.eventos_procesados (LIKE records.eventos_procesados INCLUDING ALL);

-- EVENT-CARRIED STATE TRANSFER: replica LOCAL de las recetas en farmacia,
-- alimentada por el evento RecetaEmitida. Contiene solo lo que la farmacia
-- necesita (nada de dosis ni diagnostico: minimo dato sensible fuera de records).
CREATE TABLE pharmacy.recetas (
    receta_id      UUID PRIMARY KEY,
    paciente_id    UUID NOT NULL,
    medicamento    TEXT NOT NULL,
    estado         TEXT NOT NULL DEFAULT 'DISPONIBLE'
                   CHECK (estado IN ('DISPONIBLE','EN_RETIRO','RETIRADA')),
    actualizada_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pharmacy_recetas_paciente ON pharmacy.recetas(paciente_id);

-- DATOS DE PRUEBA
INSERT INTO scheduling.especialidades (nombre) VALUES
    ('Medicina General'), ('Pediatria'), ('Cardiologia');

INSERT INTO scheduling.medicos (id, nombre, especialidad_id) VALUES
    ('33333333-3333-3333-3333-333333333333', 'Dra. Lucia Fernandez', 1),
    ('44444444-4444-4444-4444-444444444444', 'Dr. Martin Rossi',    3);

-- Generamos cupos de 30 min, de 9:00 a 12:00, para los proximos 7 dias.
-- generate_series evita cargar cientos de INSERT a mano.
INSERT INTO scheduling.agenda_slots (medico_id, inicio)
SELECT m.id, dia + (hora - timestamp '2000-01-01 00:00:00')
FROM scheduling.medicos m
CROSS JOIN generate_series(
        date_trunc('day', now()),
        date_trunc('day', now()) + interval '6 days',
        interval '1 day') AS dia
CROSS JOIN generate_series(
        timestamp '2000-01-01 09:00:00',
        timestamp '2000-01-01 11:30:00',
        interval '30 minutes') AS hora;

-- Historias clinicas de los dos pacientes de prueba.
INSERT INTO records.historias (id, paciente_id) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111'),
    ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222');

INSERT INTO records.entradas (historia_id, medico_id, motivo, diagnostico) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001',
     '33333333-3333-3333-3333-333333333333',
     'Control anual', 'Paciente sana. Hipertension leve controlada.');

-- Una receta ya emitida para poder probar el retiro en farmacia enseguida.
INSERT INTO records.recetas (id, historia_id, paciente_id, medico_id, medicamento, dosis) VALUES
    ('bbbbbbbb-0000-0000-0000-000000000001',
     'aaaaaaaa-0000-0000-0000-000000000001',
     '11111111-1111-1111-1111-111111111111',
     '33333333-3333-3333-3333-333333333333',
     'Enalapril 10mg', '1 comprimido cada 12 horas');

-- TFU5: el evento de la receta semilla queda PENDIENTE en el outbox. Al
-- arrancar, el relay de records lo publica y pharmacy lo agrega a su replica.
-- Es la misma ruta que sigue cualquier receta real (no hay "atajo" de datos).
INSERT INTO records.outbox (id, topico, tipo, datos, correlation_id) VALUES
    ('cccccccc-0000-0000-0000-000000000001', 'eventos:recetas', 'RecetaEmitida',
     '{"recetaId":"bbbbbbbb-0000-0000-0000-000000000001","pacienteId":"11111111-1111-1111-1111-111111111111","medicoId":"33333333-3333-3333-3333-333333333333","medicamento":"Enalapril 10mg","dosis":"1 comprimido cada 12 horas"}',
     'seed');
