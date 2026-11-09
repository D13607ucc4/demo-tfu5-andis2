#!/usr/bin/env bash
# ORQUESTADOR DE LA PARTE 2 (patrones de arquitectura).
#
# Corre los scripts 7 a 12 en orden y muestra una tabla resumen. Devuelve un
# codigo distinto de cero si alguno fallo, para poder encadenarlo en CI.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTADOS=/tmp/tfu4_resultados.txt
: > "$RESULTADOS"

TITULOS="7-circuit-breaker 8-rate-limiting 9-cache-aside 10-load-leveling 11-gatekeeper 12-gateway-offloading"

echo "=============================================================="
echo " PARTE 2 - PATRONES DE ARQUITECTURA (scripts 7 a 12)"
echo "=============================================================="

for s in $TITULOS; do
  echo
  echo "############ scripts/$s.sh ############"
  if bash "$DIR/$s.sh"; then
    echo "$s OK" >> "$RESULTADOS"
  else
    echo "$s FALLO" >> "$RESULTADOS"
  fi
done

echo
echo "=============================================================="
echo " RESUMEN PARTE 2"
echo "=============================================================="
FALLOS=0
while read -r nombre estado; do
  printf "  %-26s %s\n" "$nombre" "$estado"
  [ "$estado" = "OK" ] || FALLOS=$((FALLOS + 1))
done < "$RESULTADOS"
echo "--------------------------------------------------------------"
if [ "$FALLOS" -eq 0 ]; then
  echo " RESULTADO: todos los scripts de la parte 2 pasaron"
else
  echo " RESULTADO: $FALLOS script(s) fallaron"
fi
exit "$FALLOS"
