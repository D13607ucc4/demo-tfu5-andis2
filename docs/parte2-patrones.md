# Parte 2 - Patrones de arquitectura

En la parte 1 modelamos los componentes, las interfaces y el estilo general
(microservicios, contenedores, sin estado, ACID + BASE). En esta parte
atacamos los **atributos de calidad**: disponibilidad, performance y seguridad.
Aplicamos seis patrones y, para cada uno, un script que lo demuestra en vivo
(scripts 7 a 12). Los resultados se pueden enseñar corriendo
`./scripts/all-tfu4.sh`, que ejecuta todo y saca una tabla resumen.

Los tres atributos y los patrones que los cubren:

| Atributo | Patrones |
|---|---|
| Disponibilidad | Circuit Breaker (+ Retry), Rate Limiting |
| Performance | Cache-Aside, Queue-Based Load Leveling |
| Seguridad | Gatekeeper, Gateway Offloading |

---

## 1. Circuit Breaker (+ Retry) - disponibilidad

### Problema
`pharmacy-service` valida cada receta contra `records-service`. Si `records` se
cuelga, cada request a farmacia espera el timeout completo y, en una rafaga,
se agotan las conexiones del llamador: un componente lento arrastra a otro
(efecto cascada).

### Que implementamos
Un circuit breaker por **host destino**, en memoria del proceso, dentro del
unico punto por el que todos los componentes consumen a otros:
`callInternal`. Estados `CLOSED`, `OPEN` y `HALF_OPEN`. Cuenta **un fallo por
invocacion** (no uno por intento de retry), trata los `4xx` como "la
dependencia esta viva" (no cuentan) y solo reintenta metodos idempotentes
(`GET`), porque reintentar un `POST` podria duplicar una operacion.

Archivos tocados:
- `src/shared/httpClient.js`: breaker, retry con backoff + jitter,
  `circuitSnapshot()`.
- `src/shared/config.js`: bloque `circuitBreaker`.
- `src/shared/server.js`: `/healthz` de cada servicio expone el estado de sus
  circuitos.
- `src/services/pharmacy/index.js`: cuando el circuito esta `OPEN` responde
  `503` con header `Retry-After`.
- `docker-compose.yml`: variables `CB_*`.

Variables de entorno (con default):
`CB_FAILURE_THRESHOLD=5`, `CB_OPEN_MS=10000` (en `pharmacy` se baja a `5000`
para que la demo sea agil), `CB_RETRIES=2`, `CB_RETRY_BASE_MS=100`.

### Como correrlo
```
./scripts/7-circuit-breaker.sh
```
El script crea una receta real, pausa `records` (`docker compose pause`), y
dispara 12 retiros midiendo latencia.

### Que muestra
- Las primeras requests pagan el timeout de la dependencia (con 2 reintentos,
  porque la validacion es `GET`).
- Al llegar al umbral, las siguientes responden **al instante** (fail fast) con
  `circuit: "OPEN"` en el cuerpo y `Retry-After`.
- La falla queda aislada: `GET /api/queue/farmacia` sigue respondiendo `200`
  con `records` caido.
- Al despausar y pasar la ventana, el circuito reabre a `HALF_OPEN`, deja pasar
  una request de prueba y vuelve a `CLOSED`.

---

## 2. Rate Limiting - disponibilidad (anti-DoS)

### Problema
Una rafaga abusiva contra el sistema (sobre todo contra el login, que es el
endpoint de fuerza bruta) puede agotar conexiones y tumbar servicios que
estaban sanos.

### Que implementamos
Limite de tasa **en el borde** (nginx), por IP de origen. Dos zonas: trafico
general `/api/` a `20r/s` (burst 40) y login a `5r/s` (burst 5), mas un tope de
30 conexiones simultaneas por IP. Las respuestas rechazadas son `429` con un
JSON uniforme y `Retry-After`. `/healthz` queda siempre excluido.

Archivos tocados:
- `nginx/nginx.conf`: `limit_req_zone`, `limit_req`, `limit_conn_zone`,
  `error_page 429 = @limitado`.

Variables de entorno: **ninguna**. nginx no admite variables en directivas, asi
que los limites quedan como constantes documentadas en `nginx.conf` (ver
Desvios).

### Como correrlo
```
./scripts/8-rate-limiting.sh
```

### Que muestra
- De 100 logins concurrentes, la mayoria se rechaza con `429` y al menos uno
  entra (`200`).
- La respuesta rechazada trae el JSON del patron y `Retry-After`.
- Pasada la rafaga, el login normal vuelve a funcionar.
- `30/30` requests a `/healthz` responden `200` (el monitoreo nunca queda
  afuera).

---

## 3. Cache-Aside - performance

### Problema
Los catalogos (especialidades, medicos) y los cupos libres se leen mucho mas de
lo que cambian. Pegarle siempre a PostgreSQL es caro al pedo.

### Que implementamos
Cache-aside sobre Redis. La app consulta Redis primero: `HIT` devuelve la
copia, `MISS` va a PostgreSQL y guarda con TTL. La respuesta lleva el header
`X-Cache` (`HIT`/`MISS`/`BYPASS`). Reglas que nos pusimos:
- `requireAuth` corre **antes** del cache: no cacheamos algo que un rol no
  puede ver ni mezclamos respuestas entre usuarios.
- El cache no puede tumbar el endpoint: cualquier error de Redis degrada a
  PostgreSQL con `X-Cache: BYPASS`.
- `Promise.race` con timeout corto corta el `get`/`set` si Redis se cuelga.
- La invalidacion es **explicita** al reservar una cita, y recien **despues del
  commit** (si la transaccion hace rollback, no hay nada que propagar).

Archivos tocados:
- `src/shared/redisClient.js`: claves `cache:sch:*`.
- `src/services/scheduling/index.js`: `cacheAside`, `conTimeout`,
  `invalidarSlots`.
- `src/shared/config.js`: bloque `cache`.
- `docker-compose.yml`: variables `CACHE_*`.

Variables de entorno: `CACHE_ENABLED=true`, `CACHE_TTL_CATALOGO=300`,
`CACHE_TTL_SLOTS=30`, `CACHE_TIMEOUT_MS=200`.

### Como correrlo
```
./scripts/9-cache-aside.sh
```

### Que muestra
- Una rafaga en frio da `MISS` y calienta el cache; despues, hit ratio > 90%.
- **Performance medida de verdad**: contamos los accesos a la tabla
  `scheduling.agenda_slots` (`pg_stat_user_tables`). Con el cache caliente, la
  rafaga de 200 requests hace **0 accesos** a PostgreSQL; sin cache
  (`CACHE_ENABLED=false`), cada request pega a la tabla (~N accesos). La base
  queda libre para las escrituras: eso es lo que sostiene el rendimiento cuando
  la carga crece. Medir solo el tiempo de pared no sirve aca, porque la consulta
  es muy barata y el ruido de curl/nginx tapa la diferencia.
- Al reservar un cupo, el cache se invalida: el siguiente `GET` es `MISS` y el
  cupo reservado ya no aparece entre los libres.
- Con Redis caido, el endpoint sigue respondiendo `200` con `BYPASS`.

---

## 4. Queue-Based Load Leveling (+ Competing Consumers) - performance y resiliencia

### Problema
Farmacia recibe una rafaga de solicitudes de retiro. Procesarlas dentro de la
request ata la latencia del paciente al ritmo de procesamiento del sistema.

### Que implementamos
`pharmacy` graba el retiro en PostgreSQL (ACID) y recien despues **publica un
evento** en un stream de Redis, respondiendo `201` enseguida. La cola hace de
amortiguador: absorbe el pico y el trabajo se hace a un ritmo controlado. Los
eventos los consume un **consumer group** de Redis Streams: aunque haya N
replicas de `queue-service`, cada evento lo procesa **una sola** (competing
consumers), sin duplicar tickets. El stream se recorta con `MAXLEN ~` para
acotar la memoria de Redis, y `XAUTOCLAIM` recupera los mensajes que quedaron
pendientes si una replica se cae (at-least-once).

Archivos tocados:
- `src/services/pharmacy/index.js`: `xAdd` con `TRIM`.
- `src/services/queue/index.js`: consumer group, `procesarEvento` idempotente,
  `CONSUMER_DELAY_MS`, `XAUTOCLAIM` cada 30s, y `resumen` ampliado con
  `pendientesEnStream`/`totalEnStream`.
- `src/shared/config.js`: `streamMaxlen`, `consumerDelayMs`.
- `docker-compose.yml`: `STREAM_MAXLEN`, `CONSUMER_DELAY_MS`.

Variables de entorno: `STREAM_MAXLEN=10000`, `CONSUMER_DELAY_MS=0` (el script lo
sube a `200` para hacer visible el desacople).

### Como correrlo
```
./scripts/10-load-leveling.sh
```
Crea N recetas reales, escala `queue` a 2 replicas con consumidor lento y
dispara N retiros en paralelo.

### Que muestra
- El productor responde en milisegundos (p95 < 1s) aunque el consumidor sea
  lento: la latencia del paciente **no** depende del ritmo de drenaje.
- El productor responde **antes** de que el consumidor termine el trabajo real
  de ese mensaje (p95 < `CONSUMER_DELAY_MS`): eso es lo que amortigua el pico.
- **0 perdidos** y **0 duplicados**: los N tickets quedan en la cola y cada uno
  aparece una sola vez (los competing consumers reparten el trabajo).
- Al terminar no quedan mensajes pendientes de ACK y el stream crecio N.

---

## 5. Gatekeeper - seguridad (defensa en profundidad)

### Problema
Las decisiones transversales de seguridad (autenticacion, autorizacion por rol,
saneamiento de headers, control de tamano) tienden a repetirse —y
desincronizarse— en cada servicio.

### Que implementamos
Un componente `gatekeeper` por el que pasa **toda** la API. Es una
**allow-list**: lo que no esta listado devuelve `404`, no se proxea nada "por
defecto". Resuelve `401` (falta token / token invalido) y `403` (rol) **antes**
de tocar el servicio, y **sanea** los headers: borra todo `X-User-*` y
`X-Internal-Token` del cliente, inyecta el sello `X-Gatekeeper-Token` y deriva
la identidad (`X-User-Id`, `X-User-Rol`) del JWT, nunca de un header entrante.
Defensa en profundidad: ademas, los servicios exigen ver el sello del
gatekeeper (`requireAuth` en `src/shared/auth.js`, flag `GATEKEEPER_ONLY`), asi
que quien llegue **directo** a la red interna tampoco opera. El gatekeeper es
el unico contenedor en las dos redes (`edge` y `clinicare`).

Archivos tocados:
- `src/services/gatekeeper/index.js` (nuevo): tabla de politicas + proxy.
- `src/shared/auth.js`: chequeo `GATEKEEPER_ONLY` en `requireAuth`.
- `src/shared/config.js`: `gatekeeperToken`, `gatekeeperOnly`,
  `gatekeeperMaxBody`.
- `docker-compose.yml`: servicio `gatekeeper`, redes `edge`/`clinicare`,
  variables `GATEKEEPER_*`.
- `nginx/nginx.conf`: todo `/api/` se proxea al gatekeeper.
- `package.json`: se agrega `http-proxy-middleware`.

Variables de entorno: `GATEKEEPER_ONLY=true`,
`GATEKEEPER_TOKEN=gatekeeper-dev-token`, `GATEKEEPER_MAX_BODY=100kb`.

### Como correrlo
```
./scripts/11-gatekeeper.sh
```

### Que muestra
- Sin token y con token falso: `401`.
- Paciente pidiendo la agenda del medico: `403`, y el pedido denegado **no
  llega** al servicio (se verifica con un `X-Correlation-Id` unico que no
  aparece en los logs de `scheduling`).
- Header forjado `X-User-Rol: admin`: se descarta, sigue `403`.
- Acceso directo a la red interna (bypass del gateway): `403`
  "Acceso directo no permitido".
- Cuerpo de 150k: `413` del gatekeeper; de 300k: `413` del borde (nginx).
- Ruta fuera de la allow-list: `404`.
- Camino feliz con token: `200`.

---

## 6. Gateway Offloading - seguridad y performance

### Problema
TLS, cabeceras de seguridad, compresion y limite de cuerpo son preocupaciones
transversales que no deberia cargar cada servicio.

### Que implementamos
Un borde (nginx) que **termina** TLS, aplica cabeceras de seguridad (HSTS,
`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, CSP), comprime
con gzip, corta cuerpos grandes y genera/propaga el id de trazabilidad. Adentro
se habla HTTP plano. Los servicios internos **no publican puertos** al host:
solo el gateway expone `8080` (HTTP, por compatibilidad con los scripts 0-6) y
`8443` (HTTPS). Se cerro tambien el puerto de PostgreSQL.

Archivos tocados:
- `nginx/nginx.conf`: dos servidores (80 / 443 ssl), headers de seguridad,
  `gzip`, `client_max_body_size 200k`, `X-Request-Id`/`X-Correlation-Id`.
- `docker-compose.yml`: puertos del gateway, servicios sin `ports`, red `edge`.
- `scripts/gen-certs.sh` (nuevo): genera el certificado autofirmado.
- `.gitignore`: ignora `nginx/certs/`.

Variables de entorno: ninguna; el material TLS llega por volumen.

### Como correrlo
```
./scripts/gen-certs.sh          # una vez
./scripts/12-gateway-offloading.sh
```

### Que muestra
- `https://localhost:8443` responde con HSTS, `nosniff`, `X-Frame-Options: DENY`,
  CSP y `Referrer-Policy`.
- El TLS es real: sin `-k`, curl rechaza el certificado autofirmado.
- Solo el gateway publica puertos al host; el resto no.
- La respuesta de un endpoint JSON viene comprimida (`Content-Encoding: gzip`).
- Un cuerpo mayor a 200k se corta con `413` en el borde.
- El `X-Correlation-Id` que manda el cliente aparece en los logs del servicio.

---

## Como correr toda la parte 2

```
docker compose down -v
./scripts/gen-certs.sh
docker compose up -d --build
./scripts/all-tfu4.sh
```

`all-tfu4.sh` corre los scripts 7 a 12 en orden, imprime una tabla resumen y
devuelve un codigo distinto de cero si alguno falla (para poder encadenarlo en
CI). Los scripts 0 a 6 siguen funcionando igual: todo entra por
`http://localhost:8080`.

---

## Desvios

Cosas donde nos apartamos de lo que habiamos pensado al principio, o donde una
restriccion tecnica nos obligo a decidir distinto. Las dejamos explicitas:

1. **Limites de rate limiting sin variables de entorno.** nginx no admite
   variables en sus directivas, asi que `RATE_API`, `RATE_LOGIN`, `BURST_*`,
   `MAX_CONN` y `MAX_BODY` quedan como constantes documentadas arriba del
   archivo `nginx/nginx.conf`, en vez de venir del entorno como el resto de la
   configuracion.

2. **`/api/queue/farmacia/resumen` y `/api/scheduling/slots` exentos del rate
   limit general.** Los scripts 3 y 9 disparan 200 requests a `-P 20` para
   medir la cola y el cache. Si los limitaramos, la medicion seria de nginx
   (`429`) y no del patron que queremos mostrar. Siguen detras del gatekeeper y
   no son rutas de negocio criticas, asi que la exposicion es acotada.

3. **El limite de cuerpo del gatekeeper (`100kb`) es menor que el del borde
   (`200k`) a proposito.** Asi se puede demostrar el `413` en los dos niveles:
   150k lo corta el gatekeeper y 300k lo corta nginx.

4. **El circuit breaker es en memoria del proceso (no compartido entre
   replicas).** Es una optimizacion local para proteger el pool de cada
   instancia, no un dato de negocio. Que dos replicas tengan vision distinta
   del estado de una dependencia es aceptable.

5. **Los reintentos solo aplican a `GET`.** Reintentar un `POST` (por ejemplo,
   un retiro) podria duplicar la operacion. El patron retry se aplica solo
   donde es seguro.

6. **Se dejo publico el resumen de cola en el gatekeeper.** Los scripts 0 a 6
   lo consultan sin token a proposito (miden la cola sin autenticarse). Para no
   romperlos, esa ruta queda como `publico` en la tabla de politicas.

7. **PostgreSQL ya no publica `5432` al host.** Lo cerramos como parte del
   borde. Para inspeccionar la base con un cliente externo durante la demo hay
   que descomentar el bloque `ports` en `docker-compose.yml`.

8. **Certificado autofirmado.** No hay una CA real en la demo, asi que el TLS
   se prueba con `curl -k`. En produccion iria un certificado valido y el
   cliente no necesitaria `-k`.

9. **Una sola dependencia nueva.** Salvo `http-proxy-middleware` (que usa el
   gatekeeper para el proxy), no se agrego ninguna libreria: el circuit breaker,
   el rate limiting del lado de la app, el cache-aside y el consumo de streams
   se resolvieron con lo que ya estaba (`redis`, `pg`, `jsonwebtoken`, `express`).

10. **El cache-aside se mide por accesos a la base, no por tiempo de pared.**
    La consulta de cupos es muy barata en local y el ruido de `curl`/`nginx`
    tapa cualquier diferencia de latencia (en las pruebas el tiempo salia igual
    con y sin cache). Como el beneficio real del cache es **desacoplar** la base,
    medimos cuantas veces cada rafaga toca la tabla `agenda_slots`
    (`pg_stat_user_tables`): 0 con cache caliente contra ~N sin cache. Es un
    numero estable y prueba el punto.

11. **El criterio de load leveling compara latencia contra el delay del
    consumidor.** Antes comparabamos el tiempo de drenaje contra la respuesta,
    pero si el consumidor termina durante la rafaga esa medicion queda en ~0 y
    el criterio fallaba por timing. Lo cambiamos por algo robusto: la p95 del
    productor tiene que ser menor que `CONSUMER_DELAY_MS` (el request vuelve
    antes de que el consumidor haga el trabajo real).
