#!/usr/bin/env bash
# TFU5 - VALIDACION DEL ATRIBUTO DE CALIDAD: DISPONIBILIDAD
#
# ESCENARIO: "records-service (historia clinica) queda fuera de servicio en
# horario de farmacia. Los pacientes siguen pidiendo el retiro de recetas que
# ya les fueron emitidas."
#
# ESTIMULO: N solicitudes POST /api/pharmacy/retiros con records PAUSADO
#           (docker compose pause: el proceso se cuelga, no rechaza conexiones,
#           que es el peor caso para un llamador sincrono).
# MEDIDA:   % de solicitudes aceptadas (201), latencia p50/p95/max, y si el
#           sistema CONVERGE cuando records vuelve (las recetas quedan EN_RETIRO
#           en records sin intervencion manual).
# LINEA DE BASE: las mismas N solicitudes con records funcionando.
#
# COMPARACION CON LA ARQUITECTURA ANTERIOR: el script no depende de la rama.
# Para correrlo contra la TFU4 (SOA sincrona):
#     git checkout tfu4 && docker compose up -d --build
#     git show tfu5:scripts/15-disponibilidad.sh > /tmp/15.sh
#     LIB=scripts/lib.sh bash /tmp/15.sh
# y despues en tfu5:  ./scripts/15-disponibilidad.sh
# Cada corrida deja su tabla en resultados/disponibilidad-<rama>.txt
set -u
source "${LIB:-$(dirname "$0")/lib.sh}"

# En la rama tfu4 el lib.sh no tiene estos helpers: los definimos si faltan.
type sql >/dev/null 2>&1 || sql() { docker compose exec -T postgres psql -U clinicare -d clinicare -tAc "$1" | tr -d '\r'; }
type esperar_receta_en_farmacia >/dev/null 2>&1 || esperar_receta_en_farmacia() { return 0; }

N=${N:-10}
SVC=${SVC:-records}
ANA_ID="11111111-1111-1111-1111-111111111111"
RAMA=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo desconocida)
OUTDIR="${OUTDIR:-resultados}"; mkdir -p "$OUTDIR"
TMP=$(mktemp -d)

titulo "TFU5 - ATRIBUTO DE CALIDAD: DISPONIBILIDAD  (rama: $RAMA)"

paso "1) Preparo $((2 * N)) recetas reales (flujo cita -> consulta -> receta)"
ANA=$(login ana@paciente.uy ana123)
LUCIA=$(login lucia@clinica.uy lucia123)
MARTIN=$(login martin@clinica.uy martin123)
[ -n "$ANA" ] && [ -n "$LUCIA" ] && [ -n "$MARTIN" ] || { echo "FALLO: login"; exit 1; }
: > "$TMP/recetas"
i=0
while [ "$(wc -l < "$TMP/recetas" | tr -d ' ')" -lt $((2 * N)) ] && [ "$i" -lt $((6 * N)) ]; do
  i=$((i + 1))
  if [ $((i % 2)) -eq 0 ]; then T="$LUCIA"; else T="$MARTIN"; fi
  R=$(crear_receta "$ANA" "$ANA_ID" "$T" "Disponibilidad $i 5mg")
  if [ -n "$R" ]; then
    echo "$R" >> "$TMP/recetas"
  else
    # Lo mas comun es un 429 del rate limiting del gateway: esperamos a que
    # se recargue el cupo de pedidos por segundo antes de reintentar.
    sleep 2
  fi
  # Ritmo de preparacion por debajo del limite del gateway (20 req/s por IP).
  sleep 0.3
done
RECETAS=()
while read -r r; do [ -n "$r" ] && RECETAS+=("$r"); done < "$TMP/recetas"   # (sin mapfile: bash 3 de macOS)
if [ "${#RECETAS[@]}" -lt $((2 * N)) ]; then
  echo "FALLO: solo se crearon ${#RECETAS[@]} recetas."
  echo "  Causas posibles: no quedan cupos en la agenda (docker compose down -v && docker compose up -d --build)"
  echo "  o el gateway esta devolviendo 429 (docker compose logs gateway | grep ' 429 ')."; exit 1
fi
# Por las dudas en tfu5: que todas esten replicadas en farmacia antes de medir.
for r in "${RECETAS[@]}"; do QUIET_ESPERA=1 esperar_receta_en_farmacia "$ANA" "$r" >/dev/null; sleep 0.2; done
echo "  ${#RECETAS[@]} recetas listas"

# El gateway aplica RATE LIMITING (20 req/s por IP, rafaga 40). Para que el
# 429 del limitador no se confunda con una falla de disponibilidad, cada fase
# arranca con el cupo recargado y los retiros se envian a un ritmo realista
# (PAUSA entre pedidos; por defecto ~6 por segundo).
PAUSA=${PAUSA:-0.15}
recargar_cupo() { sleep 3; }

# retirar <receta> -> imprime "<http_code> <segundos>"
retirar() {
  curl -s -o /dev/null -w '%{http_code} %{time_total}\n' -m 30 -X POST "$BASE/api/pharmacy/retiros" \
    -H "Authorization: Bearer $ANA" -H 'Content-Type: application/json' -d "{\"recetaId\":\"$1\"}"
}

# estadisticas <archivo> -> "ok total disp% p50ms p95ms maxms"  (awk/sort POSIX)
estadisticas() {
  local ok n p50 p95 max disp
  ok=$(awk '$1==201' "$1" | wc -l | tr -d ' ')
  n=$(wc -l < "$1" | tr -d ' ')
  awk '{ printf "%d\n", $2 * 1000 }' "$1" | sort -n > "$1.lat"
  p50=$(sed -n "$(( (n + 1) / 2 ))p" "$1.lat")
  p95=$(sed -n "$(( (n * 95 + 99) / 100 ))p" "$1.lat")
  max=$(tail -1 "$1.lat")
  disp=$(awk -v a="$ok" -v b="$n" 'BEGIN { printf "%.1f", 100 * a / b }')
  echo "$ok $n $disp $p50 $p95 $max"
}

paso "2) LINEA DE BASE: $N retiros con $SVC funcionando"
recargar_cupo
for k in $(seq 0 $((N - 1))); do retirar "${RECETAS[$k]}"; sleep "$PAUSA"; done > "$TMP/base"
read -r B_OK B_N B_DISP B_P50 B_P95 B_MAX < <(estadisticas "$TMP/base")
echo "  aceptados $B_OK/$B_N ($B_DISP%)  p50=${B_P50}ms  p95=${B_P95}ms  max=${B_MAX}ms"

paso "3) FALLA: pauso $SVC y repito $N retiros (recetas distintas)"
recargar_cupo
docker compose pause "$SVC" >/dev/null 2>&1
for k in $(seq "$N" $((2 * N - 1))); do
  L=$(retirar "${RECETAS[$k]}"); echo "$L"; echo "    retiro $((k - N + 1)): HTTP ${L% *}  t=${L#* }s" >&2
  sleep "$PAUSA"
done > "$TMP/caida"
# El resto del sistema durante la caida (aislamiento de la falla).
COLA_CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$BASE/api/queue/farmacia" -H "Authorization: Bearer $ANA")
read -r C_OK C_N C_DISP C_P50 C_P95 C_MAX < <(estadisticas "$TMP/caida")
echo "  aceptados $C_OK/$C_N ($C_DISP%)  p50=${C_P50}ms  p95=${C_P95}ms  max=${C_MAX}ms"
echo "  GET /api/queue/farmacia durante la caida -> HTTP $COLA_CODE"

paso "4) RECUPERACION: reanudo $SVC y verifico convergencia"
docker compose unpause "$SVC" >/dev/null 2>&1
IDS=$(printf "'%s'," "${RECETAS[@]:$N:$N}"); IDS=${IDS%,}
t0=$(date +%s%N); CONV=0
for _ in $(seq 1 100); do
  CONV=$(sql "SELECT count(*) FROM records.recetas WHERE id IN ($IDS) AND estado='EN_RETIRO'")
  [ "$CONV" -ge "$C_OK" ] && break
  sleep 0.2
done
t1=$(date +%s%N)
CONV_MS=$(( (t1 - t0) / 1000000 ))
echo "  recetas EN_RETIRO en records (de las pedidas durante la caida): $CONV/$C_OK  (en ${CONV_MS}ms)"

paso "5) Resultados"
{
  echo "rama=$RAMA  servicio_caido=$SVC  N=$N  fecha=$(date -Iseconds)"
  printf "%-26s %10s %8s %8s %8s %8s\n" "fase" "aceptados" "disp%" "p50ms" "p95ms" "maxms"
  printf "%-26s %10s %8s %8s %8s %8s\n" "linea de base" "$B_OK/$B_N" "$B_DISP" "$B_P50" "$B_P95" "$B_MAX"
  printf "%-26s %10s %8s %8s %8s %8s\n" "$SVC caido" "$C_OK/$C_N" "$C_DISP" "$C_P50" "$C_P95" "$C_MAX"
  echo "cola durante la caida: HTTP $COLA_CODE"
  echo "convergencia en records tras recuperar: $CONV/$C_OK recetas EN_RETIRO en ${CONV_MS}ms"
  echo "codigos durante la caida: $(awk '{print $1}' "$TMP/caida" | sort | uniq -c | awk '{printf "%sx%s ", $1, $2}')"
  echo "ritmo: un retiro cada ${PAUSA}s (por debajo del rate limiting del gateway)"
} | tee "$OUTDIR/disponibilidad-$RAMA.txt"

paso "6) Criterios (hipotesis de la TFU5)"
criterio "disponibilidad del retiro con $SVC caido = 100%" "$N" "$C_OK"
menor "$C_P95" 1000; criterio_ok "p95 con $SVC caido < 1000ms (no se pagan timeouts)" $?
criterio "la cola sigue respondiendo durante la caida" "200" "$COLA_CODE"
criterio "records converge sola al recuperarse" "$C_OK" "$CONV"
if [ "$C_OK" -lt "$N" ]; then
  echo
  echo "  NOTA: en la rama tfu4 estos criterios FALLAN a proposito: pharmacy valida"
  echo "  cada receta contra records de forma sincrona; el Circuit Breaker hace que"
  echo "  falle RAPIDO (503), pero falla. Ese es el punto de la comparacion."
fi
rm -rf "$TMP"
resumen
