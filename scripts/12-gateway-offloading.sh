#!/usr/bin/env bash
# PATRON 6 - GATEWAY OFFLOADING  -> atributo de calidad: SEGURIDAD / PERFORMANCE
#
# Que demuestra:
#   - El borde (nginx) resuelve las preocupaciones transversales: TLS, cabeceras
#     de seguridad (HSTS, nosniff, X-Frame-Options, CSP), compresion gzip y
#     limite de tamano de cuerpo.
#   - Los servicios internos NO cargan con eso: hablan HTTP plano, no publican
#     puertos al host y no repiten cabeceras de seguridad.
#   - Trazabilidad: el borde inyecta un request-id y propaga el correlation-id
#     hasta el servicio, para seguir una operacion de punta a punta.
set -u
source "$(dirname "$0")/lib.sh"

titulo "PATRON 6 - GATEWAY OFFLOADING [seguridad / performance]"

paso "1) TLS + cabeceras de seguridad en el borde (HTTPS 8443)"
ANA=$(login ana@paciente.uy ana123)
HDR=$(curl -sk -D - -o /dev/null "$HTTPS_BASE/healthz" | tr -d '\r')
printf '%s\n' "$HDR" | grep -iE 'strict-transport-security|x-content-type-options|x-frame-options|content-security-policy|referrer-policy' | sed 's/^/    /'
HSTS=$(printf '%s' "$HDR" | grep -ic 'strict-transport-security' || true)
NOSNIFF=$(printf '%s' "$HDR" | grep -ic 'x-content-type-options: nosniff' || true)
FRAME=$(printf '%s' "$HDR" | grep -ic 'x-frame-options: deny' || true)
CSP=$(printf '%s' "$HDR" | grep -ic 'content-security-policy' || true)
criterio_ok "presenta HSTS" "$([ "$HSTS" -ge 1 ] && echo 0 || echo 1)"
criterio_ok "presenta X-Content-Type-Options: nosniff" "$([ "$NOSNIFF" -ge 1 ] && echo 0 || echo 1)"
criterio_ok "presenta X-Frame-Options: DENY" "$([ "$FRAME" -ge 1 ] && echo 0 || echo 1)"
criterio_ok "presenta Content-Security-Policy" "$([ "$CSP" -ge 1 ] && echo 0 || echo 1)"

paso "2) El TLS es real: sin -k el certificado autofirmado se rechaza"
CODE=0
curl -s -o /dev/null "$HTTPS_BASE/healthz" >/dev/null 2>&1 || CODE=$?
echo "  curl sin -k devolvio codigo de error: $CODE"
criterio_ok "falla la verificacion del certificado (no es TLS simulado)" "$([ "$CODE" -ne 0 ] && echo 0 || echo 1)"

paso "3) Los servicios internos NO publican puertos al host"
LINEAS=$(docker ps --format '{{.Names}}|{{.Ports}}' | grep 'clinicare-tfu' || true)
TOTAL_PUB=$(printf '%s\n' "$LINEAS" | grep -c '\->' || true)
OTROS_PUB=$(printf '%s\n' "$LINEAS" | grep '\->' | grep -vc 'gateway' || true)
printf '%s\n' "$LINEAS" | sed 's/^/    /'
criterio "ningun servicio salvo el gateway publica puertos" "0" "$OTROS_PUB"
criterio_ok "el gateway si publica (8080/8443)" "$([ "$TOTAL_PUB" -ge 1 ] && echo 0 || echo 1)"

paso "4) Compresion gzip resuelta en el borde"
HDR=$(curl -s -D - -o /dev/null --compressed "$BASE/api/scheduling/especialidades" \
       -H "Authorization: Bearer $ANA" | tr -d '\r')
ENC=$(printf '%s' "$HDR" | grep -i '^content-encoding:' | awk '{print $2}')
echo "  Content-Encoding: ${ENC:-<ninguno>}"
criterio "la respuesta viene comprimida (gzip)" "gzip" "$ENC"

paso "5) Limite de tamano de cuerpo en el borde"
head -c 300000 /dev/zero | tr '\0' 'a' > /tmp/go_big.txt
C=$(curl -s -D /tmp/go_big.h -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
     -H 'Content-Type: application/json' --data-binary @/tmp/go_big.txt)
CT=$(grep -i '^content-type:' /tmp/go_big.h | tr -d '\r' | awk '{print $2}')
echo "  cuerpo 300k -> HTTP $C (content-type: $CT)"
criterio "cuerpo mayor a 200k => 413" "413" "$C"

paso "6) Trazabilidad: el correlation-id del cliente llega al servicio"
CID="go-$(date +%s)-$$"
curl -s -o /dev/null "$BASE/api/scheduling/especialidades" \
  -H "Authorization: Bearer $ANA" -H "X-Correlation-Id: $CID"
sleep 1
TRAZA=$(docker compose logs scheduling 2>/dev/null | grep -c "$CID" || true)
echo "  cid=$CID encontrado en logs de scheduling: $TRAZA vez/veces"
criterio_ok "el servicio registra el cid enviado por el cliente" "$([ "$TRAZA" -ge 1 ] && echo 0 || echo 1)"

paso "7) El borde genera un request-id cuando el cliente no manda ninguno"
RID=$(curl -s -D - -o /dev/null "$BASE/healthz" | tr -d '\r' | grep -i '^x-request-id:' | awk '{print $2}')
XC=$(curl -s -D - -o /dev/null "$BASE/healthz" | tr -d '\r' | grep -i '^x-correlation-id:' | awk '{print $2}')
echo "  X-Request-Id: ${RID:-<ninguno>}   X-Correlation-Id: ${XC:-<ninguno>}"
criterio_ok "la respuesta trae X-Request-Id generado por nginx" "$([ -n "$RID" ] && echo 0 || echo 1)"

resumen
exit $?
