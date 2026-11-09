#!/usr/bin/env bash
# PATRON 1 - CIRCUIT BREAKER  ->  atributo de calidad: DISPONIBILIDAD
#
# TFU5: el breaker CAMBIO DE LUGAR. En la TFU4 protegia pharmacy -> records
# (validacion REST de la receta). Esa llamada ya no existe: pharmacy valida
# contra su replica local alimentada por eventos (ver script 15). La UNICA
# dependencia sincrona que queda es records -> scheduling por SOAP
# (ConsultarRelacionClinica), y es ahi donde el breaker sigue haciendo falta.
#
# Que demuestra:
#   - Cuando scheduling se CUELGA, records paga el timeout SOAP las primeras
#     veces y, al llegar al umbral, deja de llamar: responde AL INSTANTE.
#   - FAIL-SECURE: sin poder verificar la relacion clinica, el acceso a la
#     historia se NIEGA (403), nunca se concede "por las dudas".
#   - La falla queda AISLADA: farmacia y cola siguen funcionando.
#   - Al recuperarse scheduling, el breaker cierra solo (HALF_OPEN -> CLOSED).
set -u
source "${LIB:-$(dirname "$0")/lib.sh}"

ANA_ID="11111111-1111-1111-1111-111111111111"
UMBRAL=${CB_FAILURE_THRESHOLD:-5}
OPEN_MS=${CB_OPEN_MS:-5000}
TOTAL=12

titulo "PATRON 1 - CIRCUIT BREAKER sobre la llamada SOAP records -> scheduling"

paso "1) Lucia abre una consulta con Ana (necesita la relacion clinica)"
ANA=$(login ana@paciente.uy ana123)
LUCIA=$(login lucia@clinica.uy lucia123)
[ -n "$ANA" ] && [ -n "$LUCIA" ] || { echo "FALLO: login"; exit 1; }
LUCIA_ID=$(curl -s "$BASE/api/auth/yo" -H "Authorization: Bearer $LUCIA" | campo id)
SLOT=$(curl -s "$BASE/api/scheduling/slots?medico=$LUCIA_ID" -H "Authorization: Bearer $ANA" | campo id)
CITA=$(curl -s -X POST "$BASE/api/scheduling/citas" -H "Authorization: Bearer $ANA" \
       -H 'Content-Type: application/json' -d "{\"slotId\":\"$SLOT\"}" | campo id)
curl -s -X POST "$BASE/api/scheduling/citas/$CITA/iniciar" -H "Authorization: Bearer $LUCIA" >/dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/records/pacientes/$ANA_ID/historia" -H "Authorization: Bearer $LUCIA")
criterio "con scheduling sano, Lucia accede a la historia" "200" "$CODE"

paso "2) Pauso scheduling (se CUELGA, no rechaza la conexion)"
docker compose pause scheduling >/dev/null 2>&1

paso "3) $TOTAL x GET historia clinica midiendo latencia"
slow_ok=0; fast_ok=0; open_ok=0; deny_ok=0
for i in $(seq 1 $TOTAL); do
  OUT=$(curl -s -o "/tmp/cb_b_$i.json" -w '%{time_total} %{http_code}' -m 30 \
        "$BASE/api/records/pacientes/$ANA_ID/historia" -H "Authorization: Bearer $LUCIA")
  T=$(echo "$OUT" | awk '{print $1}'); C=$(echo "$OUT" | awk '{print $2}')
  OPEN=$(grep -c 'circuito abierto' "/tmp/cb_b_$i.json" 2>/dev/null || true); [ -n "$OPEN" ] || OPEN=0
  echo "  req $i: HTTP $C  t=${T}s  circuito abierto? $OPEN"
  [ "$C" = "403" ] && deny_ok=$((deny_ok + 1))
  if [ "$i" -le "$UMBRAL" ]; then
    mayor_igual "$T" 2.5 && slow_ok=$((slow_ok + 1))
  else
    menor "$T" 0.2 && fast_ok=$((fast_ok + 1))
    [ "$OPEN" -ge 1 ] && open_ok=$((open_ok + 1))
  fi
done

paso "4) Criterios del circuit breaker"
criterio "las primeras $UMBRAL pagan el timeout SOAP (>= 2.5s)" "$UMBRAL" "$slow_ok"
criterio "las $((TOTAL - UMBRAL)) siguientes responden al instante (< 0.2s)" "$((TOTAL - UMBRAL))" "$fast_ok"
criterio "en circuito abierto el motivo lo informa" "$((TOTAL - UMBRAL))" "$open_ok"
criterio "FAIL-SECURE: todas las respuestas niegan el acceso (403)" "$TOTAL" "$deny_ok"

paso "5) Aislamiento de falla: farmacia y cola siguen vivas"
QCODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/queue/farmacia" -H "Authorization: Bearer $ANA")
PCODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/pharmacy/recetas/mias" -H "Authorization: Bearer $ANA")
criterio "GET /api/queue/farmacia con scheduling caido" "200" "$QCODE"
criterio "GET /api/pharmacy/recetas/mias con scheduling caido" "200" "$PCODE"

paso "6) Despauso scheduling y espero la ventana del circuito (${OPEN_MS}ms + 1s)"
docker compose unpause scheduling >/dev/null 2>&1
sleep $((OPEN_MS / 1000 + 1))
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/records/pacientes/$ANA_ID/historia" -H "Authorization: Bearer $LUCIA")
echo "  respuesta post-recuperacion: HTTP $CODE"
criterio "HALF_OPEN -> CLOSED: el acceso vuelve a funcionar" "200" "$CODE"

paso "7) Estado de los circuitos expuesto en records /healthz"
docker compose exec -T records node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log('ERR',e.message))"

sql "UPDATE scheduling.citas SET estado='FINALIZADA' WHERE id='$CITA'" >/dev/null
resumen
exit $?
