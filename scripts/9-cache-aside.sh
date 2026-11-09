#!/usr/bin/env bash
# PATRON 3 - CACHE-ASIDE  ->  atributo de calidad: PERFORMANCE
#
# Que demuestra:
#   - Los catalogos y cupos se leen de Redis (HIT) en vez de pegarle siempre a
#     PostgreSQL. La rafaga en frio da MISS y calienta el cache; despues, HIT.
#   - PERFORMANCE: medimos cuantas veces cada request toca la tabla
#     scheduling.agenda_slots (pg_stat_user_tables). Con cache, la rafaga
#     caliente no consulta la base; sin cache, consulta una vez por request.
#     La base queda libre para las escrituras: eso es lo que mejora el
#     rendimiento cuando la carga crece.
#     (Ojo: la latencia de pared no es un buen indicador en local, porque la
#     consulta es muy barata y el ruido de curl/nginx tapa la diferencia.)
#   - Consistencia: al reservar una cita se INVALIDA el cache de cupos, asi que
#     el slot reservado desaparece de inmediato (no se sirve dato viejo).
#   - Resiliencia: con Redis caido el endpoint sigue vivo (X-Cache: BYPASS).
set -u
source "$(dirname "$0")/lib.sh"

N=${N:-200}
P=${P:-20}

# Cuenta los accesos (seq_scan + idx_scan) a la tabla de cupos. Nos sirve para
# probar que con cache la rafaga no toca PostgreSQL.
scans_slots() {
  local v
  v=$(docker compose exec -T postgres psql -U clinicare -d clinicare -tAc \
        "SELECT COALESCE(seq_scan,0)+COALESCE(idx_scan,0) FROM pg_stat_user_tables \
         WHERE schemaname='scheduling' AND relname='agenda_slots'" 2>/dev/null | tr -d '\r ')
  echo "${v:-0}"
}

# Borra las claves de cache de scheduling para forzar un MISS.
enfriar_cache() {
  local claves
  claves=$(docker compose exec -T redis redis-cli --scan --pattern 'cache:sch:*' | tr -d '\r')
  if [ -n "$claves" ]; then docker compose exec -T redis redis-cli DEL $claves >/dev/null; fi
  return 0
}

titulo "PATRON 3 - CACHE-ASIDE [performance]"

paso "1) Login y datos de prueba (medico + cupos)"
ANA=$(login ana@paciente.uy ana123)
MEDICO=$(curl -s "$BASE/api/scheduling/medicos" -H "Authorization: Bearer $ANA" | campo id)
URL="$BASE/api/scheduling/slots?medico=$MEDICO"
echo "  medico=$MEDICO"

paso "2) Enfriamos el cache (borramos cache:sch:*)"
enfriar_cache
echo "  cache de scheduling vaciado."

paso "3) Ronda A CON cache: primer GET (frio) + $N GET en paralelo (-P $P)"
COLD=$(curl -s -D - -o /dev/null "$URL" -H "Authorization: Bearer $ANA" | grep -i '^x-cache:' | tr -d '\r')
echo "  primer GET (frio): $COLD"
S0=$(scans_slots)
INICIO=$(date +%s%N)
HDRS=$(seq 1 "$N" | xargs -P "$P" -I{} curl -s -D - -o /dev/null "$URL" \
        -H "Authorization: Bearer $ANA" | grep -i '^x-cache:' | tr -d '\r')
FIN=$(date +%s%N)
MS_CACHE=$(( (FIN - INICIO) / 1000000 ))
sleep 2
SCANS_CACHE=$(( $(scans_slots) - S0 ))
HIT=$(printf '%s\n' "$HDRS" | grep -c 'HIT' || true)
MISS=$(printf '%s\n' "$HDRS" | grep -c 'MISS' || true)
TOTAL=$((HIT + MISS)); [ "$TOTAL" -gt 0 ] || TOTAL=1
RATIO=$(( HIT * 100 / TOTAL ))
echo "  HIT=$HIT  MISS=$MISS  tiempo_total=${MS_CACHE}ms  accesos_a_agenda_slots=$SCANS_CACHE"
criterio_ok "hit ratio > 90% (fue ${RATIO}%)" "$([ "$RATIO" -gt 90 ] && echo 0 || echo 1)"
criterio_ok "el cache evita consultar PostgreSQL (<= 5 accesos, fueron $SCANS_CACHE)" \
  "$([ "$SCANS_CACHE" -le 5 ] && echo 0 || echo 1)"

paso "4) Misma carga SIN cache (CACHE_ENABLED=false)"
CACHE_ENABLED=false docker compose up -d scheduling >/dev/null 2>&1
sleep 6
S2=$(scans_slots)
INICIO=$(date +%s%N)
seq 1 "$N" | xargs -P "$P" -I{} curl -s -o /dev/null "$URL" -H "Authorization: Bearer $ANA"
FIN=$(date +%s%N)
MS_NOCACHE=$(( (FIN - INICIO) / 1000000 ))
sleep 2
SCANS_NOCACHE=$(( $(scans_slots) - S2 ))
docker compose up -d scheduling >/dev/null 2>&1   # restauramos cache
sleep 6
echo "  CON cache: $SCANS_CACHE accesos a agenda_slots, ${MS_CACHE}ms"
echo "  SIN cache: $SCANS_NOCACHE accesos a agenda_slots, ${MS_NOCACHE}ms"
criterio_ok "SIN cache cada request consulta la base (>= $((N/2)) accesos, fueron $SCANS_NOCACHE)" \
  "$([ "$SCANS_NOCACHE" -ge $((N/2)) ] && echo 0 || echo 1)"

paso "5) Consistencia: reservo un cupo y verifico la invalidacion"
SLOT=$(curl -s "$URL" -H "Authorization: Bearer $ANA" | campo id)
echo "  slot a reservar: $SLOT"
curl -s -X POST "$BASE/api/scheduling/citas" -H "Authorization: Bearer $ANA" \
  -H 'Content-Type: application/json' -d "{\"slotId\":\"$SLOT\"}" >/dev/null
RESP=$(curl -s -D /tmp/cache_h.txt "$URL" -H "Authorization: Bearer $ANA")
XC=$(grep -i '^x-cache:' /tmp/cache_h.txt | tr -d '\r' | awk '{print $2}')
APARECE=$(printf '%s' "$RESP" | grep -c "$SLOT" || true); [ -n "$APARECE" ] || APARECE=0
echo "  X-Cache tras reservar: $XC ; el slot reservado sigue apareciendo? $APARECE"
criterio "el GET posterior a la reserva es MISS (se invalido)" "MISS" "$XC"
criterio "el cupo reservado ya no aparece en los libres" "0" "$APARECE"

paso "6) Resiliencia: Redis caido, el endpoint sigue vivo"
docker compose stop redis >/dev/null 2>&1
sleep 2
CODE=$(curl -s -o /dev/null -D /tmp/cache_h2.txt -w '%{http_code}' "$URL" -H "Authorization: Bearer $ANA")
XC=$(grep -i '^x-cache:' /tmp/cache_h2.txt | tr -d '\r' | awk '{print $2}')
echo "  HTTP $CODE  X-Cache=$XC"
criterio "GET /slots con Redis caido responde 200" "200" "$CODE"
criterio "con Redis caido el cache se saltea (BYPASS)" "BYPASS" "$XC"
docker compose start redis >/dev/null 2>&1
sleep 5

resumen
exit $?
