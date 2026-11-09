#!/usr/bin/env bash
# PATRON 4 - QUEUE-BASED LOAD LEVELING (+ Competing Consumers)  -> atributo de
# calidad: PERFORMANCE / RESILIENCIA
#
# Que demuestra:
#   - Una rafaga de N retiros se ACEPTA rapido (201) porque pharmacy NO procesa
#     el trabajo en la request: solo lo ENCOLA como evento en un stream de Redis.
#   - Un consumidor deliberadamente LENTO (CONSUMER_DELAY_MS) drena la cola a su
#     ritmo. La latencia que ve el paciente NO depende de ese ritmo: la cola hace
#     de amortiguador (load leveling) y absorbe el pico.
#   - Con 2 replicas de queue-service (COMPETING CONSUMERS sobre el mismo consumer
#     group) cada evento lo procesa UNA sola replica: 0 duplicados, 0 perdidos.
#
# Por que N recetas: receta_id es UNIQUE en pharmacy.retiros, asi que cada retiro
# de la rafaga necesita su propia receta. Se crean siguiendo el flujo real.
set -u
source "$(dirname "$0")/lib.sh"

N=${N:-30}          # cantidad de retiros de la rafaga
P=${P:-20}          # paralelismo del productor
DELAY=${DELAY:-200} # ms que simula "trabajar" cada consumidor por mensaje

ANA_ID="11111111-1111-1111-1111-111111111111"

titulo "PATRON 4 - QUEUE-BASED LOAD LEVELING [performance / resiliencia]"

paso "1) Login"
ANA=$(login ana@paciente.uy ana123)
LUCIA=$(login lucia@clinica.uy lucia123)
MARTIN=$(login martin@clinica.uy martin123)
[ -n "$ANA" ] && [ -n "$LUCIA" ] && [ -n "$MARTIN" ] || { echo "FALLO: no se pudo loguear"; exit 1; }

paso "2) Creo las recetas de la rafaga (una por retiro)"
mkdir -p /tmp/qbll
RECETAS_FILE=/tmp/qbll/recetas.txt
: > "$RECETAS_FILE"
intentos=0
while [ "$(wc -l < "$RECETAS_FILE" | tr -d ' ')" -lt "$N" ] && [ "$intentos" -lt $((N * 3)) ]; do
  intentos=$((intentos + 1))
  # Alterno medicos para repartir el consumo de cupos entre las dos agendas.
  if [ $((intentos % 2)) -eq 0 ]; then TMED="$LUCIA"; else TMED="$MARTIN"; fi
  R=$(crear_receta "$ANA" "$ANA_ID" "$TMED" "Medicamento $intentos 10mg")
  [ -n "$R" ] && echo "$R" >> "$RECETAS_FILE"
done
REC=$(wc -l < "$RECETAS_FILE" | tr -d ' ')
echo "  recetas creadas: $REC (intentos: $intentos)"
if [ "$REC" -lt 5 ]; then echo "FALLO: no se pudieron crear suficientes recetas"; exit 1; fi
N="$REC"; echo "  uso N=$N para la demo."
RECETAS=()
while read -r r; do [ -n "$r" ] && RECETAS+=("$r"); done < "$RECETAS_FILE"

paso "3) Escalo queue a 2 replicas con consumidor lento (${DELAY}ms/mensaje)"
CONSUMER_DELAY_MS="$DELAY" docker compose up -d --scale queue=2 queue >/dev/null 2>&1
sleep 6
REPLICAS=$(docker compose ps -q queue | wc -l | tr -d ' ')
echo "  replicas de queue en ejecucion: $REPLICAS"

paso "4) Baseline de la cola antes de la rafaga"
RES0=$(curl -s "$BASE/api/queue/farmacia/resumen")
ESP0=$(echo "$RES0" | numero esperando)
TOT0=$(echo "$RES0" | numero totalEnStream)
echo "  esperando=$ESP0  totalEnStream=$TOT0"

# --- Productor: N retiros en paralelo. Mide latencia por request. ------------
retirar() {
  local receta="$1" out code t tk
  out=$(curl -s -D "/tmp/qbll/$receta.h" -o "/tmp/qbll/$receta.json" \
        -w '%{http_code} %{time_total}' -X POST "$BASE/api/pharmacy/retiros" \
        -H "Authorization: Bearer $ANA" -H 'Content-Type: application/json' \
        -d "{\"recetaId\":\"$receta\"}")
  code=$(echo "$out" | awk '{print $1}')
  t=$(echo "$out" | awk '{print $2}')
  tk=$(campo ticket < "/tmp/qbll/$receta.json")
  printf '%s %s %s %s\n' "$code" "$t" "$tk" "$receta"
}
export -f retirar campo
export BASE ANA

paso "5) Disparo $N POST /api/pharmacy/retiros en paralelo (-P $P) y mido latencia"
INICIO=$(date +%s%N)
printf '%s\n' "${RECETAS[@]}" | xargs -P "$P" -I{} bash -c 'retirar "{}"' > /tmp/qbll/res.txt 2>/tmp/qbll/err.txt
FIN=$(date +%s%N)
BURST_MS=$(( (FIN - INICIO) / 1000000 ))

OK201=$(awk '$1==201' /tmp/qbll/res.txt | wc -l | tr -d ' ')
TICKETS=$(awk '$1==201{print $3}' /tmp/qbll/res.txt)
P95=$(awk '{print $2}' /tmp/qbll/res.txt | sort -g | awk -v n="$N" 'BEGIN{i=int(0.95*n); if(i<1)i=1} NR==i{print; exit}')
P95_MS=$(awk -v t="$P95" 'BEGIN{printf "%d", t*1000}')
echo "  rafaga completa en ${BURST_MS}ms   aceptadas 201: $OK201/$N   p95 latencia: ${P95_MS}ms"

# Snapshot inmediato: la cola todavia tiene trabajo pendiente aunque el POST ya respondio.
RES1=$(curl -s "$BASE/api/queue/farmacia/resumen")
echo "  snapshot inmediato -> esperando=$(echo "$RES1" | numero esperando)  totalEnStream=$(echo "$RES1" | numero totalEnStream)  pendientes=$(echo "$RES1" | numero pendientesEnStream)"

paso "6) El consumidor drena a su ritmo; espero a que la cola converja"
objetivo=$((ESP0 + N))
t0=$(date +%s%N)
esp=0; pend=-1
for i in $(seq 1 240); do
  RES=$(curl -s "$BASE/api/queue/farmacia/resumen")
  esp=$(echo "$RES" | numero esperando)
  pend=$(echo "$RES" | numero pendientesEnStream)
  [ "$esp" -ge "$objetivo" ] && [ "$pend" -eq 0 ] && break
  sleep 0.5
done
t1=$(date +%s%N)
DRAIN_MS=$(( (t1 - t0) / 1000000 ))
TOT1=$(echo "$RES" | numero totalEnStream)
echo "  drenaje completo en ${DRAIN_MS}ms -> esperando=$esp (objetivo=$objetivo)  pendientes=$pend"

paso "7) Verifico 0 duplicados y 0 perdidos en la lista FIFO"
LISTA=$(docker compose exec -T redis redis-cli LRANGE cola:farmacia 0 -1 | tr -d '\r')
PERDIDOS=0; TOTAL_OC=0
while read -r tk; do
  [ -n "$tk" ] || continue
  oc=$(printf '%s\n' "$LISTA" | grep -c "^${tk}$" || true)
  [ "$oc" = "0" ] && PERDIDOS=$((PERDIDOS + 1))
  TOTAL_OC=$((TOTAL_OC + oc))
done <<< "$TICKETS"
DUP=$((TOTAL_OC - N))
echo "  tickets de la rafaga presentes: $((N - PERDIDOS))/$N   ocurrencias totales: $TOTAL_OC (esperado $N)"

paso "8) Criterios de queue-based load leveling"
criterio "todos los retiros aceptados con 201" "$N" "$OK201"
criterio_ok "p95 de latencia del productor < 1000ms (fue ${P95_MS}ms)" "$([ "$P95_MS" -lt 1000 ] && echo 0 || echo 1)"
# Load leveling: el request vuelve ANTES de que el consumidor termine el trabajo
# real de ese mensaje (DELAY ms). Eso es lo que amortigua el pico.
criterio_ok "el productor responde antes de procesar el mensaje (p95 ${P95_MS}ms < ${DELAY}ms de trabajo)" \
  "$([ "$P95_MS" -lt "$DELAY" ] && echo 0 || echo 1)"
criterio "0 eventos perdidos (los $N tickets quedaron en la cola)" "0" "$PERDIDOS"
criterio "0 eventos duplicados (competing consumers reparten el trabajo)" "0" "$DUP"
criterio "sin mensajes pendientes de ACK al terminar" "0" "$pend"
criterio_ok "el stream crecio al menos $N eventos" "$([ $((TOT1 - TOT0)) -ge "$N" ] && echo 0 || echo 1)"
criterio "2 replicas de queue-servicio" "2" "$REPLICAS"

paso "9) Restauro queue a 1 replica sin delay"
docker compose up -d --scale queue=1 queue >/dev/null 2>&1
sleep 5
echo "  queue restaurado ($(docker compose ps -q queue | wc -l | tr -d ' ') replica)."

resumen
exit $?
