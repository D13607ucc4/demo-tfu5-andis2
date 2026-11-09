#!/usr/bin/env bash
# TFU5 - FALACIA "LA RED ES CONFIABLE": Transactional Outbox + Idempotent
# Consumer + Dead Letter Queue
#
# Que demuestra:
#   A) OUTBOX: con el BROKER DE EVENTOS CAIDO, el medico igual emite una receta
#      y el paciente igual pide el retiro (201). Los eventos quedan guardados en
#      la tabla outbox (misma transaccion que el dato). Cuando el broker vuelve,
#      el relay los publica y el sistema converge: la receta llega a farmacia y
#      el ticket aparece en la cola. 0 eventos perdidos.
#      (En la TFU4 el evento se publicaba "fire and forget" despues del COMMIT:
#      con Redis caido, el retiro quedaba grabado pero nunca entraba a la cola.)
#   B) IDEMPOTENCIA: re-inyectamos en el broker un RetiroSolicitado YA
#      procesado (mismo id). Ningun consumidor aplica el efecto dos veces: la
#      cola no crece, no hay notificacion repetida y la receta no cambia.
#   C) DLQ: un evento venenoso (RecetaEmitida sin recetaId) falla en el
#      consumidor; tras EVENT_MAX_INTENTOS reintentos va a eventos:dlq y deja de
#      reintentarse. El resto del flujo no se bloquea.
set -u
source "${LIB:-$(dirname "$0")/lib.sh}"

ANA_ID="11111111-1111-1111-1111-111111111111"
MAX_INTENTOS=${EVENT_MAX_INTENTOS:-3}

titulo "TFU5 - EVENTOS CONFIABLES: OUTBOX + IDEMPOTENT CONSUMER + DLQ"

paso "0) Login y una consulta en curso para poder recetar"
ANA=$(login ana@paciente.uy ana123)
LUCIA=$(login lucia@clinica.uy lucia123)
FARMA=$(login farma@clinica.uy farma123)
[ -n "$ANA" ] && [ -n "$LUCIA" ] && [ -n "$FARMA" ] || { echo "FALLO: login"; exit 1; }
LUCIA_ID=$(curl -s "$BASE/api/auth/yo" -H "Authorization: Bearer $LUCIA" | campo id)
SLOT=$(curl -s "$BASE/api/scheduling/slots?medico=$LUCIA_ID" -H "Authorization: Bearer $ANA" | campo id)
CITA=$(curl -s -X POST "$BASE/api/scheduling/citas" -H "Authorization: Bearer $ANA" \
       -H 'Content-Type: application/json' -d "{\"slotId\":\"$SLOT\"}" | campo id)
curl -s -X POST "$BASE/api/scheduling/citas/$CITA/iniciar" -H "Authorization: Bearer $LUCIA" >/dev/null
echo "  consulta $CITA en curso"

# ============================================================================
paso "A1) DETENGO EL BROKER DE EVENTOS"
docker compose stop broker >/dev/null 2>&1
sleep 1
echo "  broker detenido (los eventos NO pueden publicarse)"

paso "A2) Con el broker caido, Lucia emite una receta"
OUT=$(curl -s -w ' %{http_code}' -X POST "$BASE/api/records/recetas" \
  -H "Authorization: Bearer $LUCIA" -H 'Content-Type: application/json' \
  -d "{\"pacienteId\":\"$ANA_ID\",\"medicamento\":\"Losartan 50mg\",\"dosis\":\"1 por dia\"}")
CODE=$(echo "$OUT" | awk '{print $NF}')
RECETA=$(echo "$OUT" | grep -o '"receta":{"id":"[^"]*"' | grep -o '[0-9a-f-]\{36\}')
echo "  POST /api/records/recetas -> HTTP $CODE  receta=$RECETA"
criterio "records acepta la receta aunque el broker este caido" "201" "$CODE"
if [ -z "$RECETA" ]; then
  docker compose start broker >/dev/null 2>&1
  echo "  No se pudo emitir la receta: no tiene sentido seguir. Revisar 'docker compose logs records'."
  echo "  (Si el error es 'relation ... does not exist': docker compose down -v && docker compose up -d --build)"
  resumen; exit 1
fi
sleep 1
PEND=$(sql "SELECT count(*) FROM records.outbox WHERE publicado_en IS NULL AND datos->>'recetaId'='$RECETA'")
INT=$(sql "SELECT intentos FROM records.outbox WHERE datos->>'recetaId'='$RECETA'")
echo "  records.outbox: RecetaEmitida pendiente=$PEND  intentos de publicacion=$INT"
criterio "el evento quedo guardado en el outbox (misma transaccion)" "1" "$PEND"

paso "A3) Para tener un retiro con el broker caido, la receta tiene que estar en"
echo "    farmacia: uso la receta semilla si esta disponible, si no, la de A2 llega en A4"
SEMILLA="bbbbbbbb-0000-0000-0000-000000000001"
EST_SEMILLA=$(sql "SELECT estado FROM pharmacy.recetas WHERE receta_id='$SEMILLA'")
if [ "$EST_SEMILLA" = "DISPONIBLE" ]; then
  OUT=$(curl -s -w ' %{http_code}' -X POST "$BASE/api/pharmacy/retiros" \
    -H "Authorization: Bearer $ANA" -H 'Content-Type: application/json' -d "{\"recetaId\":\"$SEMILLA\"}")
  CODE=$(echo "$OUT" | awk '{print $NF}'); TICKET_A=$(echo "$OUT" | campo ticket)
  echo "  POST /api/pharmacy/retiros (receta semilla) -> HTTP $CODE ticket=$TICKET_A"
  criterio "pharmacy acepta el retiro aunque el broker este caido" "201" "$CODE"
else
  TICKET_A=""
  echo "  (la receta semilla ya se uso en otra demo; salteo este paso)"
fi

paso "A4) LEVANTO EL BROKER: el relay publica lo pendiente"
docker compose start broker >/dev/null 2>&1
t0=$(date +%s%N); LLEGO=0
for _ in $(seq 1 100); do
  if curl -s "$BASE/api/pharmacy/recetas/mias" -H "Authorization: Bearer $ANA" | grep -q "$RECETA"; then LLEGO=1; break; fi
  sleep 0.2
done
t1=$(date +%s%N)
echo "  la receta emitida con el broker caido llego a farmacia $(( (t1 - t0) / 1000000 ))ms despues de levantarlo"
criterio "RecetaEmitida entregada tras la recuperacion (0 perdidos)" "1" "$LLEGO"
PEND=$(sql "SELECT count(*) FROM records.outbox WHERE publicado_en IS NULL")
criterio "records.outbox sin pendientes" "0" "$PEND"
if [ -n "$TICKET_A" ]; then
  EN_COLA=0
  for _ in $(seq 1 50); do
    curl -s "$BASE/api/queue/farmacia" -H "Authorization: Bearer $ANA" | grep -q "\"$TICKET_A\"" && { EN_COLA=1; break; }
    sleep 0.2
  done
  criterio "el ticket $TICKET_A (pedido con broker caido) aparece en la cola" "1" "$EN_COLA"
  PEND=$(sql "SELECT count(*) FROM pharmacy.outbox WHERE publicado_en IS NULL")
  criterio "pharmacy.outbox sin pendientes" "0" "$PEND"
fi

# ============================================================================
paso "B) IDEMPOTENCIA: re-inyecto un RetiroSolicitado ya procesado (mismo id)"
# Pido un retiro normal con la receta de A2 y espero a que todos lo procesen.
OUT=$(curl -s -X POST "$BASE/api/pharmacy/retiros" -H "Authorization: Bearer $ANA" \
      -H 'Content-Type: application/json' -d "{\"recetaId\":\"$RECETA\"}")
TICKET_B=$(echo "$OUT" | campo ticket)
echo "  retiro normal -> ticket $TICKET_B"
[ -n "$TICKET_B" ]; criterio_ok "se obtuvo un ticket para la prueba de idempotencia" $?
sleep 2
COLA0=$(cache_cli LLEN cola:farmacia)
PROC0=$(sql "SELECT count(*) FROM records.eventos_procesados WHERE consumidor='records-retiros'")
echo "  antes:   cola=$COLA0  records.eventos_procesados=$PROC0"

# Copio TAL CUAL el ultimo RetiroSolicitado del stream y lo vuelvo a publicar 2 veces.
DUP=$(node_en queue "
  const { createClient } = require('redis');
  (async () => {
    const c = createClient({ url: process.env.BROKER_URL }); await c.connect();
    const msgs = await c.xRevRange('eventos:retiros', '+', '-', { COUNT: 50 });
    const m = msgs.find(x => x.message.tipo === 'RetiroSolicitado' && x.message.datos.includes('$TICKET_B'));
    if (!m) { console.log('NO-ENCONTRADO'); process.exit(0); }
    await c.xAdd('eventos:retiros', '*', m.message);
    await c.xAdd('eventos:retiros', '*', m.message);
    console.log(m.message.id); await c.quit();
  })();")
echo "  evento duplicado 2 veces: id=$DUP"
# (la bandeja guarda el id del evento que origino cada aviso: contamos por id,
#  porque la bandeja esta acotada a 20 y un LLEN no sirve)
sleep 3
COLA1=$(cache_cli LLEN cola:farmacia)
NOTIF1=$(cache_cli LRANGE "notif:$ANA_ID" 0 -1 | grep -c "$DUP" || true)
PROC1=$(sql "SELECT count(*) FROM records.eventos_procesados WHERE consumidor='records-retiros'")
echo "  despues: cola=$COLA1  records.eventos_procesados=$PROC1  avisos de ese evento en la bandeja de Ana=$NOTIF1"
criterio "queue no duplica el ticket" "$COLA0" "$COLA1"
criterio "notifications genero UN solo aviso para ese evento" "1" "$NOTIF1"
criterio "records no reaplica el evento" "$PROC0" "$PROC1"
OCURR=$(cache_cli LRANGE cola:farmacia 0 -1 | grep -c "^${TICKET_B}$")
criterio "el ticket $TICKET_B aparece UNA vez en la cola" "1" "$OCURR"

# ============================================================================
paso "C) DLQ: publico un RecetaEmitida venenoso (sin recetaId)"
DLQ0=$(broker_cli XLEN eventos:dlq)
node_en queue "
  const { createClient } = require('redis');
  (async () => {
    const c = createClient({ url: process.env.BROKER_URL }); await c.connect();
    await c.xAdd('eventos:recetas', '*', { id: require('crypto').randomUUID(), tipo: 'RecetaEmitida',
      version: '1', origen: 'script-14', ocurridoEn: new Date().toISOString(), correlationId: 'veneno',
      datos: JSON.stringify({ medicamento: 'sin id' }) });
    await c.quit();
  })();"
echo "  esperando $MAX_INTENTOS intentos de pharmacy y el pase a la DLQ..."
DLQ1=$DLQ0
for _ in $(seq 1 60); do
  DLQ1=$(broker_cli XLEN eventos:dlq)
  [ "$DLQ1" -gt "$DLQ0" ] && break
  sleep 0.5
done
echo "  eventos:dlq: $DLQ0 -> $DLQ1"
criterio "el evento venenoso termino en la DLQ" "$((DLQ0 + 1))" "$DLQ1"
echo "  ultima entrada de la DLQ:"
broker_cli XREVRANGE eventos:dlq + - COUNT 1 | sed -n '2,11p' | paste - - | sed 's/^/    /' | cut -c1-140
sleep 1
PEND=$(broker_cli XPENDING eventos:recetas pharmacy | head -1)
criterio "no quedan mensajes pendientes en el grupo pharmacy" "0" "$PEND"

# Cierro la consulta abierta para no afectar a otras demos.
sql "UPDATE scheduling.citas SET estado='FINALIZADA' WHERE id='$CITA'" >/dev/null

resumen
