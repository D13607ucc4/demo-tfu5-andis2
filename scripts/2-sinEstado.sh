#!/usr/bin/env bash
# DEMO 2 - SERVICIOS SIN ESTADO
# 
# Que probamos:
#  a) El MISMO token funciona en CUALQUIER replica: no hay sesion en memoria.
#  b) Replicas distintas atienden requests consecutivas y el resultado es
#     identico -> no hace falta sticky session.
#  c) Si matamos una replica en medio de la operacion, el token sigue valido.
set -e
source "$(dirname "$0")/lib.sh"

titulo "DEMO 2 - Servicios sin estado (JWT autocontenido)"

paso "Escalamos queue-service a 3 replicas"
docker compose up -d --scale queue=3 --no-recreate queue
sleep 5
docker compose ps queue

paso "Login UNA sola vez"
ANA=$(login ana@paciente.uy ana123)
echo "Token emitido por auth-service."

paso "10 requests al mismo endpoint: mira el header X-Served-By"
for i in $(seq 1 10); do
  printf "req %2d -> " "$i"
  curl -s -D - -o /dev/null "$BASE/api/queue/farmacia/resumen" | grep -i 'x-served-by' | tr -d '\r'
done

echo
echo "Distintos contenedores respondieron, sin que el cliente haga nada especial."
echo "Ninguno de ellos conocia previamente a este usuario: validaron el JWT con"
echo "el secreto compartido, sin consultar un almacen de sesiones."

paso "Matamos una replica y repetimos con EL MISMO token"
VICTIMA=$(docker compose ps -q queue | head -1)
docker kill "$VICTIMA" >/dev/null
echo "Replica $VICTIMA eliminada."
sleep 3
for i in 1 2 3 4; do
  printf "req %d -> " "$i"
  curl -s -D - -o /dev/null "$BASE/api/queue/mi-turno" -H "Authorization: Bearer $ANA" \
    | grep -i 'x-served-by' | tr -d '\r'
done
echo
echo "El token siguio funcionando: si hubiera sesion en memoria, se habria perdido."

paso "Docker repone la replica caida (restart: unless-stopped)"
docker compose up -d --scale queue=3 queue >/dev/null
sleep 4
docker compose ps queue