# TFU5 - Arquitectura basada en eventos: guía técnica

Este documento describe la implementación de la rama `tfu5`. La justificación
del estilo, la comparación con la TFU4 y los resultados están en el informe de
la Parte 1. Los diagramas UML están en `docs/uml/` (fuentes `.puml` + PNG).

## 1. Qué cambió respecto de la TFU4

| Interacción | TFU4 (SOA síncrona) | TFU5 (EDA) |
|---|---|---|
| pharmacy valida una receta | `GET records/internal/recetas/:id` (REST) | Consulta local a `pharmacy.recetas` (réplica alimentada por `RecetaEmitida`) |
| receta pasa a EN_RETIRO | `POST records/internal/recetas/:id/estado` (REST) | records consume `RetiroSolicitado` |
| farmacéutico entrega | queue → `POST pharmacy/internal/retiros/:id/atendido` (REST) | queue publica `RetiroAtendido`; pharmacy y records lo consumen |
| avisos al paciente | Redis pub/sub (no durable) | Stream `eventos:turnos` con consumer group |
| retiro → cola | XADD "fire and forget" después del COMMIT | Transactional Outbox |
| relación clínica | `GET scheduling/internal/relacion` (REST/JSON) | SOAP 1.1 `ConsultarRelacionClinica` + WSDL |

Las interfaces REST internas de la TFU4 se eliminaron. La API pública (la
que usan pacientes, médicos y farmacéuticos a través del gateway) no cambia,
salvo que se agregó `GET /api/pharmacy/recetas/mias`.

## 2. Catálogo de eventos

Todos los eventos viajan con el mismo sobre (campos del mensaje del stream):

| Campo | Contenido |
|---|---|
| `id` | UUID generado por el productor. Es estable: si el outbox publica dos veces, ambos mensajes llevan el mismo id |
| `tipo` | Nombre del evento |
| `version` | Versión del esquema de `datos` (hoy `1`) |
| `origen` | Servicio que lo publicó |
| `ocurridoEn` | ISO-8601 |
| `correlationId` | Id de la request que lo originó (trazabilidad entre servicios) |
| `datos` | JSON con el payload |

| Tópico | Evento | Productor | `datos` | Consumer groups |
|---|---|---|---|---|
| `eventos:recetas` | `RecetaEmitida` | records (outbox) | `recetaId, pacienteId, medicoId, medicamento, dosis, emitidaEn` | `pharmacy` |
| `eventos:retiros` | `RetiroSolicitado` | pharmacy (outbox) | `retiroId, recetaId, pacienteId, ticketCode, medicamento, tipo` | `grupo-cola`, `records`, `notifications`, `pharmacy` (lo ignora) |
| `eventos:retiros` | `RetiroAtendido` | queue | `retiroId, recetaId, ticketCode, pacienteId` | `pharmacy`, `records` (los demás lo ignoran) |
| `eventos:turnos` | `TurnoProximo`, `TurnoLlamado` | queue | `pacienteId, titulo, mensaje` | `notifications` |
| `eventos:dlq` | (copia del evento fallido) | bus | `topicoOriginal, grupo, msgIdOriginal, motivo, campos, movidoEn` | — (inspección manual) |

## 3. Dónde está cada patrón

| Patrón | Archivo | Detalle |
|---|---|---|
| Bus de eventos (pub/sub + competing consumers) | `src/shared/eventBus.js` | `publicar()`, `suscribir()`. Una conexión para `XREADGROUP BLOCK` y otra para los reintentos |
| Retry + Dead Letter Queue | `src/shared/eventBus.js` | Pendientes sin ACK por más de `EVENT_RECLAIM_IDLE_MS` se reclaman (`XAUTOCLAIM`). Al llegar a `EVENT_MAX_INTENTOS` se mueven a `eventos:dlq`. Un mensaje corrupto (JSON inválido) va directo a la DLQ |
| Transactional Outbox | `src/shared/outbox.js`, tablas `records.outbox` y `pharmacy.outbox` | `registrarEvento(client, …)` dentro de la transacción. El relay usa `FOR UPDATE SKIP LOCKED`, publica y marca `publicado_en`. Si el broker falla, corta el lote para respetar el orden |
| Idempotent Consumer | `src/shared/inbox.js`, tablas `*.eventos_procesados` | `procesarUnaVez()` (PostgreSQL, misma transacción que el efecto) y `procesarUnaVezRedis()` (SET NX) |
| Event-Carried State Transfer | `src/services/pharmacy/index.js`, tabla `pharmacy.recetas` | Réplica con lo mínimo que necesita la farmacia (sin dosis ni diagnóstico) |
| Circuit Breaker genérico | `src/shared/httpClient.js` (`conCircuito`) | Mismo mapa de breakers que la TFU4. Ahora protege el cliente SOAP |
| Cliente SOAP | `src/services/records/relacionClinicaSoap.js` | Cliente generado del WSDL en tiempo de ejecución, timeout por llamada; un `soap:Client` fault no abre el circuito |
| Servicio SOAP | `src/services/scheduling/index.js` + `relacion-clinica.wsdl` | Montado en el mismo puerto 3000; exige `X-Internal-Token` en el POST |

## 4. Contrato SOAP

WSDL: `GET http://scheduling:3000/soap/relacion-clinica?wsdl` (dentro de la red
`clinicare`). Ejemplo de pedido:

```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:rc="urn:clinicare:scheduling:relacion-clinica:v1">
  <soap:Body>
    <rc:ConsultarRelacionClinicaRequest>
      <rc:medicoId>33333333-3333-3333-3333-333333333333</rc:medicoId>
      <rc:pacienteId>11111111-1111-1111-1111-111111111111</rc:pacienteId>
    </rc:ConsultarRelacionClinicaRequest>
  </soap:Body>
</soap:Envelope>
```

La respuesta trae `consultaEnCurso` (boolean), `citaId` (opcional) y
`consultadoEn`. Si los ids no son UUID, el servicio responde un `soap:Fault`
con `faultcode` `soap:Client`; si no viene el token interno, responde 403.

## 5. Configuración nueva (`docker-compose.yml`)

| Variable | Default | Uso |
|---|---|---|
| `BROKER_URL` | `redis://broker:6379` | Broker de eventos (contenedor `broker`, Redis con AOF) |
| `EVENT_MAX_INTENTOS` | 3 | Intentos antes de la DLQ |
| `EVENT_RECLAIM_IDLE_MS` | 3000 | Tiempo sin ACK para considerar un mensaje colgado |
| `EVENT_RECLAIM_CADA_MS` | 2000 | Frecuencia del ciclo de reintentos |
| `OUTBOX_POLL_MS` | 200 | Frecuencia del relay del outbox |
| `SOAP_TIMEOUT_MS` | 3000 | Timeout de la llamada SOAP |
| `CB_OPEN_MS` (records) | 5000 | Ventana del circuito abierto hacia scheduling |

## 6. Cómo observarlo

```bash
# Eventos en cada tópico y estado de los grupos
docker compose exec broker redis-cli XLEN eventos:retiros
docker compose exec broker redis-cli XINFO GROUPS eventos:retiros
docker compose exec broker redis-cli XRANGE eventos:dlq - +

# Outbox pendiente e idempotencia
docker compose exec postgres psql -U clinicare -d clinicare -c \
  "SELECT tipo, publicado_en IS NOT NULL AS publicado, intentos FROM pharmacy.outbox ORDER BY creado_en DESC LIMIT 5"
docker compose exec postgres psql -U clinicare -d clinicare -c \
  "SELECT consumidor, count(*) FROM records.eventos_procesados GROUP BY 1"

# Contadores de eventos, outbox y circuitos de un servicio
docker compose exec pharmacy wget -qO- http://localhost:3000/healthz
```

## 7. Limitaciones conocidas

- La durabilidad del broker es la de Redis AOF con `fsync` cada segundo: ante un
  corte de energía se puede perder hasta ~1 s de eventos ya confirmados. Un
  broker dedicado (RabbitMQ con colas quorum, Kafka) daría replicación.
- En queue y notifications la marca de idempotencia no está en la misma
  transacción que el efecto: en el caso límite de una caída entre ambos, se
  podría repetir un aviso.
- El orden de los eventos se respeta por productor y por tópico, no entre
  tópicos distintos. Por eso records solo deja avanzar el estado de una receta
  (EMITIDA → EN_RETIRO → RETIRADA) y nunca lo hace retroceder.
- `POST /api/queue/farmacia/siguiente` necesita el broker: si no está,
  responde 503 en vez de perder el evento `RetiroAtendido`.
