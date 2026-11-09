#!/usr/bin/env bash
# DEMO 5 - BASE (consistencia eventual en la cola)
# 
# Mostramos la VENTANA de inconsistencia: el retiro ya existe en PostgreSQL
# (dato maestro, ACID) pero la cola en Redis todavia no lo refleja. Milisegundos
# despues converge. Ese es el trade-off que elegimos conscientemente.
set -e
source "$(dirname "$0")/lib.sh"

titulo "DEMO 5 - BASE: consistencia eventual en la cola hibrida"

ANA=$(login ana@paciente.uy ana123)
LUCIA=$(login lucia@clinica.uy lucia123)

paso "Preparacion: la medica emite una receta nueva para Ana"
# (se asume que hay una consulta en curso; si no, correr primero el script 01)
RECETA=$(curl -s -X POST "$BASE/api/records/recetas" \
  -H "Authorization: Bearer $LUCIA" -H 'Content-Type: application/json' \
  -d '{"pacienteId":"11111111-1111-1111-1111-111111111111","medicamento":"Ibuprofeno 400mg","dosis":"1 cada 8hs"}')
RECETA_ID=$(echo "$RECETA" | grep -o '"receta":{"id":"[^"]*"' | grep -o '[0-9a-f-]\{36\}')
if [ -z "$RECETA_ID" ]; then
  echo "No se pudo emitir receta. Corre primero: ./scripts/01-flujo-completo.sh"; exit 1
fi
echo "Receta: $RECETA_ID"

paso "TFU5: primera ventana de consistencia eventual (records -> farmacia)"
esperar_receta_en_farmacia "$ANA" "$RECETA_ID"

paso "Estado de la cola ANTES"
curl -s "$BASE/api/queue/farmacia" -H "Authorization: Bearer $ANA" | numero esperando | xargs echo "esperando ="

paso "Ana solicita el retiro (escritura ACID en pharmacy + evento en el outbox)"
curl -s -X POST "$BASE/api/pharmacy/retiros" \
  -H "Authorization: Bearer $ANA" -H 'Content-Type: application/json' \
  -d "{\"recetaId\":\"$RECETA_ID\"}"; echo

paso "Lectura INMEDIATA de la cola (aqui suele verse la inconsistencia)"
curl -s "$BASE/api/queue/farmacia" -H "Authorization: Bearer $ANA"; echo

paso "Muestreo cada 100ms hasta que converja"
for i in $(seq 1 10); do
  N=$(curl -s "$BASE/api/queue/farmacia" -H "Authorization: Bearer $ANA" | numero esperando)
  echo "t=$((i*100))ms  esperando=$N"
  sleep 0.1
done

paso "El dato MAESTRO siempre estuvo consistente en PostgreSQL"
docker compose exec -T postgres psql -U clinicare -d clinicare -c \
  "SELECT ticket_code, estado, creada_en FROM pharmacy.retiros ORDER BY creada_en DESC LIMIT 3;"

paso "Cola HIBRIDA: agregamos un ticket PRESENCIAL a la misma fila"
FARMA=$(login farma@clinica.uy farma123)
curl -s -X POST "$BASE/api/queue/farmacia/presencial" \
  -H "Authorization: Bearer $FARMA" -H 'Content-Type: application/json' \
  -d '{"nota":"Paciente sin app, llego al mostrador"}'; echo
curl -s "$BASE/api/queue/farmacia" -H "Authorization: Bearer $ANA"; echo

paso "Disponibilidad: la cola funciona aunque PostgreSQL este caido"
docker compose stop postgres >/dev/null
sleep 2
echo "PostgreSQL detenido. Consultando la cola:"
curl -s "$BASE/api/queue/farmacia" -H "Authorization: Bearer $ANA"; echo
echo "^ Respondio igual: la cola vive en Redis (Basically Available)."
docker compose start postgres >/dev/null
sleep 5
echo "PostgreSQL restablecido."

echo
echo "B = disponible aun con parte del sistema degradado"
echo "A = soft state (la cola es efimera, se reconstruye desde PostgreSQL)"
echo "E = consistencia eventual (la cola converge en milisegundos)"