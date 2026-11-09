#!/usr/bin/env bash
# PATRON 2 - RATE LIMITING  ->  atributo de calidad: DISPONIBILIDAD (anti-DoS)
#
# Que demuestra:
#   - nginx limita por IP de origen. El login tiene una zona propia y estricta
#     (5r/s) porque es el endpoint que un atacante usa para fuerza bruta.
#   - Una rafaga de logins concurrentes se rechaza con 429 (y un JSON claro),
#     protegiendo a PostgreSQL/auth-service.
#   - Pasada la rafaga, el servicio vuelve a atender (no queda bloqueado).
#   - /healthz NO se limita: el monitoreo nunca debe quedar afuera.
set -u
source "$(dirname "$0")/lib.sh"

N=${N:-100}     # cantidad de logins de la rafaga
P=${P:-20}      # paralelismo

titulo "PATRON 2 - RATE LIMITING [disponibilidad / anti-DoS]"

paso "1) $N POST /api/auth/login en paralelo (-P $P)"
CODES=$(seq 1 "$N" | xargs -P "$P" -I{} curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"ana@paciente.uy","password":"ana123"}')

C200=$(printf '%s\n' "$CODES" | grep -c '^200$' || true)
C429=$(printf '%s\n' "$CODES" | grep -c '^429$' || true)

paso "2) Criterios de la rafaga"
criterio_ok "al menos 50% rechazadas con 429 (>= $((N / 2)))" "$([ $((C429 * 2)) -ge "$N" ] && echo 0 || echo 1)"
criterio_ok "al menos 1 login efectivo (200)" "$([ "$C200" -ge 1 ] && echo 0 || echo 1)"

paso "3) Cuerpo de una respuesta rechazada (patron rate-limiting)"
seq 1 12 | xargs -P 12 -I{} curl -s -o /dev/null -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"email":"ana@paciente.uy","password":"ana123"}'
curl -s -D /tmp/rl_h.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"email":"ana@paciente.uy","password":"ana123"}'; echo
grep -i 'retry-after' /tmp/rl_h.txt | tr -d '\r' || true

paso "4) Tras 3s el login normal vuelve a funcionar"
sleep 3
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"email":"ana@paciente.uy","password":"ana123"}')
criterio "login normal despues de la rafaga" "200" "$CODE"

paso "5) /healthz queda excluido del limite"
OK_HZ=0
for i in $(seq 1 30); do
  HC=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")
  [ "$HC" = "200" ] && OK_HZ=$((OK_HZ + 1))
done
criterio "30/30 GET /healthz responden 200" "30" "$OK_HZ"

paso "6) Tabla de resultados"
printf "  total=%s  200=%s  429=%s\n" "$N" "$C200" "$C429"

resumen
exit $?
