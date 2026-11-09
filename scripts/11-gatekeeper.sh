#!/usr/bin/env bash
# PATRON 5 - GATEKEEPER  -> atributo de calidad: SEGURIDAD (defensa en profundidad)
#
# Que demuestra:
#   - TODA la API pasa por el gatekeeper. Es una ALLOW-LIST: lo que no esta
#     listado devuelve 404, no se proxea nada "por defecto".
#   - Autenticacion (401) y autorizacion por rol (403) se resuelven ANTES de
#     tocar el servicio de negocio: la peticion denegada ni siquiera llega.
#   - Saneamiento de headers: un cliente no puede inyectar X-User-Rol ni saltar
#     la identidad derivada del JWT.
#   - Defensa en profundidad: aunque alguien evite el gateway y llegue a la red
#     interna, los servicios exigen ver el sello del gatekeeper (403).
#   - Control de tamano de cuerpo en el gatekeeper (413) y en el borde (nginx).
set -u
source "$(dirname "$0")/lib.sh"

M=${M:-50}   # cantidad de requests para medir el sobrecosto del gatekeeper

titulo "PATRON 5 - GATEKEEPER [seguridad / defensa en profundidad]"

paso "1) Login de los usuarios de prueba"
ANA=$(login ana@paciente.uy ana123)
ADMIN=$(login admin@clinica.uy admin123)
[ -n "$ANA" ] && [ -n "$ADMIN" ] || { echo "FALLO: no se pudo loguear"; exit 1; }
echo "  ana(paciente) y admin obtenidos."

paso "2) Autenticacion: sin token y con token falso => 401"
C1=$(curl -s -o /tmp/gk_sin.json -w '%{http_code}' "$BASE/api/auth/yo")
FAKE="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbmEiLCJyb2wiOiJhZG1pbiJ9.firmafalsa"
C2=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/auth/yo" -H "Authorization: Bearer $FAKE")
echo "  sin token: $C1   token falso: $C2"
criterio "sin token => 401" "401" "$C1"
criterio "JWT armado a mano => 401" "401" "$C2"

paso "3) Autorizacion: paciente pidiendo la agenda del medico => 403"
CID="gk-paciente-$$"
C=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/scheduling/citas/agenda" \
    -H "Authorization: Bearer $ANA" -H "X-Correlation-Id: $CID")
echo "  paciente -> /api/scheduling/citas/agenda: $C"
criterio "paciente => 403 (la ruta es solo para medico)" "403" "$C"

paso "4) La peticion denegada NO llega al servicio de negocio"
sleep 1
TRAZA=$(docker compose logs scheduling 2>/dev/null | grep -c "$CID" || true)
echo "  busco el cid $CID en los logs de scheduling: $TRAZA coincidencia(s)"
criterio "el gatekeeper corto antes de scheduling (cid ausente)" "0" "$TRAZA"

paso "5) Saneamiento: header forjado X-User-Rol: admin se descarta"
C=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/auth/usuarios" \
    -H "Authorization: Bearer $ANA" -H "X-User-Rol: admin")
echo "  paciente + X-User-Rol: admin -> /api/auth/usuarios: $C"
criterio "el rol sale del JWT, no del header => 403" "403" "$C"

paso "6) Defensa en profundidad: acceso directo a la red interna => 403"
JS="fetch('http://records:3000/api/records/auditoria',{headers:{Authorization:'Bearer $ADMIN'}}).then(r=>r.text().then(b=>console.log(r.status+' '+b.slice(0,120)))).catch(e=>console.log('ERR '+e.message))"
OUT=$(docker compose exec -T queue node -e "$JS" 2>/dev/null | tr -d '\r' | grep -v '^\[+' | tail -1)
BY=$(printf '%s' "$OUT" | grep -o '^403' | head -1)
MSG=$(printf '%s' "$OUT" | grep -c 'Acceso directo no permitido' || true)
echo "  records directo (con JWT admin, sin sello): $OUT"
criterio "without gatekeeper => 403" "403" "$BY"
criterio_ok "el servicio responde 'Acceso directo no permitido'" "$([ "$MSG" -ge 1 ] && echo 0 || echo 1)"

paso "7) Limite de cuerpo: 150k lo corta el gatekeeper, 300k lo corta nginx"
head -c 150000 /dev/zero | tr '\0' 'a' > /tmp/gk_big150.txt
head -c 300000 /dev/zero | tr '\0' 'a' > /tmp/gk_big300.txt
C150=$(curl -s -o /tmp/gk_b150.json -w '%{http_code}' -X POST "$BASE/api/auth/login" \
        -H 'Content-Type: application/json' --data-binary @/tmp/gk_big150.txt)
C300=$(curl -s -o /tmp/gk_b300.txt -w '%{http_code}' -X POST "$BASE/api/auth/login" \
        -H 'Content-Type: application/json' --data-binary @/tmp/gk_big300.txt)
ES_GK=$(grep -c 'demasiado grande' /tmp/gk_b150.json || true)
echo "  150k -> $C150 (JSON del gatekeeper? $ES_GK)   300k -> $C300 (nginx, en el borde)"
criterio "150k => 413 en el gatekeeper" "413" "$C150"
criterio_ok "el 413 de 150k trae el JSON del gatekeeper" "$([ "$ES_GK" -ge 1 ] && echo 0 || echo 1)"
criterio "300k => 413 en el borde (nginx)" "413" "$C300"

paso "8) Allow-list: una ruta no listada => 404"
C=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/secret" -H "Authorization: Bearer $ADMIN")
echo "  GET /api/admin/secret: $C"
criterio "ruta fuera de la allow-list => 404" "404" "$C"

paso "9) Camino feliz: con token valido el gatekeeper deja pasar"
C=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/scheduling/especialidades" -H "Authorization: Bearer $ANA")
criterio "GET especialidades con token => 200" "200" "$C"

paso "10) Sobrecosto del gatekeeper: $M GET /api/queue/farmacia (espaciados)"
SUMA=0
for i in $(seq 1 "$M"); do
  T=$(curl -s -o /dev/null -w '%{time_total}' "$BASE/api/queue/farmacia" -H "Authorization: Bearer $ANA")
  SUMA=$(awk -v a="$SUMA" -v b="$T" 'BEGIN{print a+b}')
  sleep 0.06
done
PROM_MS=$(awk -v s="$SUMA" -v m="$M" 'BEGIN{printf "%d", (s/m)*1000}')
echo "  promedio por request: ${PROM_MS}ms (el salto a traves del gatekeeper es barato)"
criterio_ok "promedio <= 150ms" "$([ "$PROM_MS" -le 150 ] && echo 0 || echo 1)"

resumen
exit $?
