#!/usr/bin/env bash
# ORQUESTADOR TFU5 (estilo basado en eventos).
#
# Corre los scripts 13, 14, 7 y 15 en orden y muestra una tabla resumen. Devuelve un
# codigo distinto de cero si alguno fallo, para poder encadenarlo en CI.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTADOS=/tmp/tfu5_resultados.txt
: > "$RESULTADOS"

TITULOS="13-soap 14-eventos-confiables 7-circuit-breaker 15-disponibilidad"

echo "=============================================================="
echo " TFU5 - EDA: SOAP, EVENTOS CONFIABLES, CIRCUIT BREAKER, DISPONIBILIDAD"
echo "=============================================================="

# PRECONDICION: la base tiene que haberse creado con el init.sql de la TFU5.
# PostgreSQL solo ejecuta init.sql cuando el volumen esta VACIO: si antes se
# levanto la TFU4, el volumen datos-pg conserva el esquema viejo (sin outbox,
# inbox ni replica de recetas) y los servicios fallan con error 500.
FALTAN=$(docker compose exec -T postgres psql -U clinicare -d clinicare -tAc \
  "SELECT count(*) FROM (VALUES ('records.outbox'),('pharmacy.outbox'),('pharmacy.recetas'),
     ('records.eventos_procesados'),('pharmacy.eventos_procesados')) t(n) WHERE to_regclass(n) IS NULL" 2>/dev/null | tr -d '\r ')
if [ "$FALTAN" != "0" ]; then
  echo
  echo "ERROR: la base de datos no tiene las tablas de la TFU5 (faltan: ${FALTAN:-?})."
  echo "Probablemente el volumen de PostgreSQL viene de una corrida de la TFU4."
  echo "Recrealo (BORRA los datos de la demo) y volve a correr este script:"
  echo
  echo "    docker compose down -v"
  echo "    docker compose up -d --build"
  echo
  exit 1
fi

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
echo " RESUMEN TFU5"
echo "=============================================================="
FALLOS=0
while read -r nombre estado; do
  printf "  %-26s %s\n" "$nombre" "$estado"
  [ "$estado" = "OK" ] || FALLOS=$((FALLOS + 1))
done < "$RESULTADOS"
echo "--------------------------------------------------------------"
if [ "$FALLOS" -eq 0 ]; then
  echo " RESULTADO: todos los scripts de la TFU5 pasaron"
else
  echo " RESULTADO: $FALLOS script(s) fallaron"
fi
exit "$FALLOS"
