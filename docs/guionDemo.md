# Guion para la demo — TFU UT3 (ClinicCare)
 
> Duración estimada: 15-20 min. Cada bloque tiene: qué decir, qué comando correr, qué señalar.
 
## Antes de empezar (chequeo previo)
 
```bash
docker compose ps          # todo "Up (healthy)"
curl.exe -s http://localhost:8080/healthz  # {"ok":true...}
chmod +x scripts/*.sh
./scripts/1-flujo-completo.sh > /dev/null   # correr una vez ANTES, en silencio,
                                              # para que ya haya datos de prueba cargados
```
 
 
## 1. Introducción (1 min)

> "Vamos a mostrar una demo de arquitectura para una red de clínicas con farmacia integrada. El sistema tiene 6 componentes de negocio, un API Gateway, y dos motores de persistencia distintos. Vamos a demostrar 5 conceptos: componentes e interfaces, escalabilidad horizontal, contenedores, ACID + BASE, y servicios sin estado."
 
**Mostrar:** el diagrama de componentes (UML de la Parte 1), pantalla completa.

 
## 2. Arranque del sistema (1 min)

> "Todo el sistema está desplegado en Docker. Son 9 contenedores: 6 componentes de negocio en Node, el gateway nginx, y dos motores de datos, Postgres y Redis."
 
**Hacer:**
```bash
docker compose ps
```
 
**Señalar:**
- Columna `STATUS`: todos `Up`.
- Columna `PORTS`: solo el gateway (8080) y Postgres (5432, para inspección) están expuestos. Los 6 servicios de negocio no tienen puerto público — todo pasa por el gateway.
 
---
 
## 3. CONCEPTO 1 — Componentes e interfaces (4-5 min)

> "Vamos a recorrer el flujo completo de un paciente: reserva una cita, la médica accede a su historia clínica, le receta un medicamento, y el paciente lo retira haciendo la cola virtual. En cada paso van a ver cómo un componente consume la interfaz que expone otro."
 
**Hacer:**
```bash
& "C:\Program Files\Git\bin\bash.exe" ./scripts/1-flujoCompleto.sh
```
 
**Ir señalando cada bloque de la salida:**
 
| Paso del script | Qué decir |
|---|---|
| Login de Ana | auth-service expone `IAutenticacion`. Emite un JWT, no una sesión — se retoma en el punto de servicios sin estado. |
| Especialidades/médicos/slots | scheduling-service expone `IAgenda`. |
| Reserva de la cita | Acá se ejecuta una transacción ACID, se ve en detalle más adelante. |
| Médica intenta ver historia SIN consulta iniciada → 403 | **Punto más importante de interfaces.** records-service no confía en nada: le pregunta a scheduling-service, por una interfaz interna, si hay consulta en curso. Como no la hay, deniega el acceso. |
| Inicia consulta → ahora SÍ accede | Mismo mecanismo; ahora la relación existe y el acceso se permite. Todo queda auditado. |
| Receta | records-service expone `IHistoriaClinica`; acá se emite la receta. |
| Retiro → cola virtual | pharmacy-service consume la interfaz de records para validar la receta, y publica un evento que consume queue-service. |
| Estado de la cola / mi turno | queue-service expone `ICola`. El paciente ve su posición sin estar físicamente ahí (HU2 y HU3). |
| Farmacéutico llama al siguiente | HU7. Automáticamente pharmacy-service marca la receta como retirada. |
| Notificaciones de Ana | notifications-service solo escucha eventos, no sabe nada del resto del sistema — bajo acoplamiento. |
| Auditoría del admin | `records.auditoria` — trazabilidad total sobre datos sensibles, requisito del dominio. |
 
**Cerrar:**
> "Recorrimos 8 historias de usuario atravesando 6 componentes, cada uno con su interfaz publicada, ninguno accediendo directo a la base de datos de otro."
 
---
 
## 4. CONCEPTO 2 — Contenedores (2 min)
 
> "El despliegue es 100% en Docker. Elegimos contenedores en vez de máquinas virtuales por tres motivos: arrancan en segundos, lo que permite escalar en caliente ante picos de demanda; son inmutables, la misma imagen corre igual en cualquier ambiente; y son livianos, corremos 9 procesos aislados en una sola máquina."
 
**Mostrar:**
```bash
cat Dockerfile | select -first 20
```

> "Es una sola imagen para todos los componentes de negocio — cambia solo el comando de arranque. Está justificado en el documento de la Parte 1, junto con el análisis de qué pasaría si tuviéramos que usar máquinas virtuales."

 
## 5. CONCEPTO 3 — Servicios sin estado (3 min)

> "Vamos a demostrar que queue-service no guarda ningún estado en memoria. Todo lo que necesita vive afuera, en Redis, y la autenticación es vía JWT autocontenido — así que cualquier instancia puede atender cualquier request."
 
**Hacer:**
```bash
& "C:\Program Files\Git\bin\bash.exe" ./scripts/2-sinEstado.sh  
```
 
**Señalar durante la ejecución:**
- Bloque de las 10 requests con header `X-Served-By`: cambia el nombre de la instancia en cada request — contenedores distintos, ninguno conocía al usuario de antemano.
- Bloque donde se mata una réplica: se elimina un contenedor en medio de la operación y el mismo JWT sigue funcionando contra las réplicas restantes. Si hubiera sesión en memoria, se habría perdido.
 
**Cerrar:**
> "Esto es lo que hace posible escalar horizontalmente sin coordinación extra — el próximo punto."
 
---
 
## 6. CONCEPTO 4 — Escalabilidad horizontal (3 min)

> "La historia de usuario 8 pide tiempos de respuesta estables durante picos de demanda. Vamos a comparar el mismo volumen de tráfico con 1 réplica y con 3 réplicas de queue-service."
 
**Hacer:**
```bash
& "C:\Program Files\Git\bin\bash.exe" ./scripts/3-escalabilidad.sh
```
 
**Señalar:**
- Los dos tiempos totales (1 réplica vs 3 réplicas).
- El reparto real del tráfico al final (`sort | uniq -c` por instancia): nginx resuelve el DNS interno de Docker en cada request y reparte round-robin entre las réplicas vivas en ese momento.
 
**Mencionar (sin correr, por tiempo):**
> "El documento también analiza el otro lado: la base de datos no se escala así, se escala verticalmente, dándole más CPU y memoria — está en `docker-compose.yml`, en `deploy.resources.limits` de postgres."
 
---
 
## 7. CONCEPTO 5 — ACID (3 min)

> "Acá está el núcleo de la consistencia fuerte del sistema: reservar una cita no puede permitir que dos pacientes se queden con el mismo cupo. Vamos a forzar esa condición de carrera a propósito."
 
**Hacer:**
```bash
& "C:\Program Files\Git\bin\bash.exe" ./scripts/4-acid.sh
```
 
**Señalar:**
- **Prueba 1:** dos pacientes piden el mismo cupo al mismo tiempo. Uno recibe 201, el otro 409 — nunca los dos 201. Lo garantiza `SELECT ... FOR UPDATE`, que bloquea la fila hasta que la primera transacción termina.
- Verificación en la base (`SELECT count(*)`): confirma que quedó exactamente una cita para ese cupo.
- **Prueba 2 (rollback forzado):** se fuerza un error a propósito, después de marcar el cupo como ocupado pero antes de crear la cita. El cupo vuelve a quedar LIBRE — eso es atomicidad: se aplican todos los cambios o ninguno.
 
---
 
## 8. CONCEPTO 5 (cont.) — BASE (3 min)

> "La cola de farmacia usa un modelo distinto, a propósito: no necesita consistencia fuerte, necesita estar siempre disponible. Vamos a ver la ventana de consistencia eventual."
 
**Hacer:**
```bash
& "C:\Program Files\Git\bin\bash.exe" ./scripts/5-base.sh
```
 
**Señalar:**
- El retiro se graba en Postgres (dato maestro, ACID) y publica un evento.
- La lectura inmediata de la cola puede no reflejarlo todavía — ahí está la inconsistencia temporal, dura milisegundos.
- Muestreo cada 100ms: se ve cómo converge.
- Bloque donde se apaga Postgres y la cola sigue respondiendo: es "Basically Available" — la cola no depende de que la base relacional esté arriba.
 
**Cerrar ACID + BASE:**
> "Usamos el motor correcto para cada dato: transacciones fuertes donde el negocio no tolera error — citas, recetas, auditoría — y consistencia eventual donde sí se tolera, y donde a cambio ganamos disponibilidad — la cola."
 
---
 
## 9. Cierre (1 min)
 
> "Recapitulando: mostramos 6 componentes con interfaces bien definidas, todo desplegado en contenedores Docker, con servicios de negocio sin estado que permiten escalar horizontalmente sin coordinación, y dos modelos de consistencia de datos elegidos a propósito según la criticidad de cada dato: ACID para lo transaccional, BASE para lo que prioriza disponibilidad. Todo está documentado en la Parte 1, con la justificación de la partición y el análisis de las alternativas que no usamos."
 
---
 
## Preguntas típicas (repaso rápido)
 
| Pregunta | Respuesta corta |
|---|---|
| ¿Por qué no una base por componente? | Para la demo, un schema por componente en la misma instancia simula el aislamiento sin el costo de 4 Postgres. En producción serían instancias separadas. |
| ¿Qué pasa si Redis se cae? | La cola deja de funcionar, pero los datos maestros (retiro, receta) siguen intactos en Postgres — se reconstruye. |
| ¿Por qué JWT y no sesiones? | Las sesiones en memoria rompen la escalabilidad horizontal sin sticky sessions o un store externo. |
| ¿Cómo evitan que dos farmacéuticos llamen al mismo ticket? | `lPop` de Redis es atómico — exclusión mutua sin bloqueos aplicativos. |
| ¿Por qué contenedores y no VMs? | Arranque en segundos para reaccionar a picos, inmutabilidad, densidad. Análisis del trade-off en el documento. |
 
---
 
## Tip de timing
 
Si queda corto el tiempo, **no saltear**:
- Punto 3 (interfaces — el 403/permitido de records es el más ilustrativo)
- Punto 7 (ACID con rollback en vivo)
- Punto 5 (sin estado, con el kill de contenedor)
 
Los puntos 6 (escalabilidad) y 8 (BASE) se pueden resumir más rápido si hace falta.
 
