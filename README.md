# ClíniCare - Red de clinicas de atencion primaria (ADA2)

Demo de arquitectura que evoluciona por unidad: componentes e interfaces,
escalabilidad, ACID + BASE (TFU3), patrones de atributos de calidad (TFU4) y,
en esta rama, **cambio de estilo a Arquitectura Basada en Eventos (TFU5)**.

## TFU5 - Arquitectura basada en eventos

En la TFU4 los componentes se integraban por **REST sincrono** (pharmacy le
preguntaba a records por cada receta, queue le avisaba a pharmacy cada
entrega). En la TFU5 se integran por **eventos** sobre un broker propio
(`broker`: Redis Streams con AOF):

| Evento | Productor | Consumidores |
|---|---|---|
| `RecetaEmitida` (`eventos:recetas`) | records (outbox) | pharmacy (replica local de recetas) |
| `RetiroSolicitado` (`eventos:retiros`) | pharmacy (outbox) | queue (ticket), records (receta EN_RETIRO), notifications (acuse) |
| `RetiroAtendido` (`eventos:retiros`) | queue | pharmacy (retiro ATENDIDO), records (receta RETIRADA) |
| `TurnoProximo` / `TurnoLlamado` (`eventos:turnos`) | queue | notifications |

La unica llamada sincrona que queda es **SOAP**: `ConsultarRelacionClinica`
(scheduling, contrato en `src/services/scheduling/relacion-clinica.wsdl`),
que consume records para decidir el acceso a la historia clinica.

Patrones nuevos: **Transactional Outbox**, **Idempotent Consumer** (inbox),
**Dead Letter Queue**, **Event-Carried State Transfer**; el **Circuit Breaker**
se mueve a la llamada SOAP. Detalle en [docs/tfu5-eda.md](docs/tfu5-eda.md).

### Demos TFU5

    ./scripts/all-tfu5.sh                 # corre 13, 14, 7 y 15
    ./scripts/13-soap.sh                  # REST -> SOAP: WSDL, XML, faults, consumo desde records
    ./scripts/14-eventos-confiables.sh    # broker caido: outbox; duplicados: idempotencia; DLQ
    ./scripts/7-circuit-breaker.sh        # breaker sobre SOAP records -> scheduling (fail-secure)
    ./scripts/15-disponibilidad.sh        # ATRIBUTO DE CALIDAD: retiro con records caido

Comparacion con la arquitectura anterior (el script 15 corre igual en las dos ramas):

    git checkout tfu4 && docker compose down -v && docker compose up -d --build
    git show tfu5:scripts/15-disponibilidad.sh > /tmp/15.sh && LIB=scripts/lib.sh bash /tmp/15.sh
    git checkout tfu5 && docker compose down -v && docker compose up -d --build
    ./scripts/15-disponibilidad.sh

Las tablas quedan en `resultados/disponibilidad-<rama>.txt`.

## Como levantar

    ./scripts/gen-certs.sh          # genero el certificado TLS autofirmado (una vez)
    docker compose up -d --build
    docker compose ps

Todo se accede por el gateway: http://localhost:8080 (HTTP) o
https://localhost:8443 (HTTPS con TLS terminado en el borde, certificado
autofirmado: usar `curl -k`).

Toda la API pasa por el **gatekeeper**, que centraliza autenticacion,
autorizacion por rol, saneamiento de headers y control de tamano.

## Usuarios de prueba

| Email                | Password   | Rol           |
|----------------------|------------|---------------|
| ana@paciente.uy      | ana123     | paciente      |
| beto@paciente.uy     | beto123    | paciente      |
| lucia@clinica.uy     | lucia123   | medico        |
| martin@clinica.uy    | martin123  | medico        |
| farma@clinica.uy     | farma123   | farmaceutico  |
| admin@clinica.uy     | admin123   | admin         |

## Demos parte 1 (en este orden)

    chmod +x scripts/*.sh
    ./scripts/0-smoke.sh            # todo arriba
    ./scripts/1-flujoCompleto.sh   # componentes e interfaces
    ./scripts/2-sinEstado.sh       # servicios sin estado
    ./scripts/3-escalabilidad.sh    # escalabilidad horizontal
    ./scripts/4-acid.sh             # transacciones ACID
    ./scripts/5-base.sh             # consistencia eventual (BASE)
    ./scripts/6-notificaciones.sh   # pub/sub entre componentes

## Demos parte 2: patrones de arquitectura

Seis patrones, un script por patron. Todo se puede correr de una:

    ./scripts/all-tfu4.sh

o de a uno:

    ./scripts/7-circuit-breaker.sh      # disponibilidad
    ./scripts/8-rate-limiting.sh        # disponibilidad (anti-DoS)
    ./scripts/9-cache-aside.sh          # performance
    ./scripts/10-load-leveling.sh       # performance / resiliencia
    ./scripts/11-gatekeeper.sh          # seguridad
    ./scripts/12-gateway-offloading.sh  # seguridad / performance

Cada script imprime `OK`/`FALLO` por criterio y termina con codigo distinto de
cero si algo fallo. El detalle de cada patron (archivos, variables de entorno,
que muestra) esta en [docs/parte2-patrones.md](docs/parte2-patrones.md).

## Escalar a mano

    docker compose up -d --scale queue=3

## Ejemplo con curl

    TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/login \
      -H 'Content-Type: application/json' \
      -d '{"email":"ana@paciente.uy","password":"ana123"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

    curl -s http://localhost:8080/api/queue/farmacia -H "Authorization: Bearer $TOKEN"

## Endpoints

### auth-service
- POST /api/auth/login
- GET  /api/auth/yo
- GET  /api/auth/usuarios (admin)

### scheduling-service
- GET  /api/scheduling/especialidades
- GET  /api/scheduling/medicos?especialidad=
- GET  /api/scheduling/slots?medico=&fecha=
- POST /api/scheduling/citas            (paciente)
- GET  /api/scheduling/citas/mias       (paciente)
- GET  /api/scheduling/citas/agenda     (medico)
- POST /api/scheduling/citas/:id/iniciar (medico)

### records-service
- GET  /api/records/pacientes/:id/historia  (consume SOAP IRelacionClinica)
- POST /api/records/pacientes/:id/entradas (medico)
- POST /api/records/recetas               (medico)
- GET  /api/records/recetas/mias          (paciente)
- GET  /api/records/auditoria             (admin)

### pharmacy-service
- POST /api/pharmacy/retiros              (paciente)
- GET  /api/pharmacy/retiros/mios         (paciente)
- GET  /api/pharmacy/retiros/pendientes   (farmaceutico)
- GET  /api/pharmacy/recetas/mias         (paciente, replica local - TFU5)

### scheduling-service (interno, SOAP - TFU5)
- POST /soap/relacion-clinica             (ConsultarRelacionClinica)
- GET  /soap/relacion-clinica?wsdl        (contrato)

### queue-service
- GET  /api/queue/farmacia
- GET  /api/queue/farmacia/resumen        (estado del stream: pendientes y total)
- GET  /api/queue/mi-turno                (paciente)
- POST /api/queue/farmacia/presencial     (farmaceutico)
- POST /api/queue/farmacia/siguiente      (farmaceutico)

### notifications-service
- GET  /api/notifications/mias            (paciente)
