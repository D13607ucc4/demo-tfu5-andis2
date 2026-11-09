#!/usr/bin/env bash
# DEMO 6 - HU3: notificacion cuando el turno esta por llegar
# 
# Muestra el flujo asincrono: queue-service PUBLICA en un canal y
# notifications-service, que es un componente distinto, CONSUME y entrega.
set -e
source "$(dirname "$0")/lib.sh"

titulo "DEMO 6 - Notificaciones (eventos entre componentes)"

ANA=$(login ana@paciente.uy ana123)
FARMA=$(login farma@clinica.uy farma123)

paso "Llenamos la cola con tickets presenciales para que Ana quede atras"
for i in 1 2 3; do
  curl -s -X POST "$BASE/api/queue/farmacia/presencial" \
    -H "Authorization: Bearer $FARMA" -H 'Content-Type: application/json' \
    -d "{\"nota\":\"Paciente presencial $i\"}" >/dev/null
done
curl -s "$BASE/api/queue/farmacia" -H "Authorization: Bearer $ANA"; echo

paso "Notificaciones de Ana ANTES"
curl -s "$BASE/api/notifications/mias" -H "Authorization: Bearer $ANA"; echo

paso "El farmaceutico va llamando turnos; la cola avanza"
for i in 1 2 3; do
  echo "--- llamada $i ---"
  curl -s -X POST "$BASE/api/queue/farmacia/siguiente" -H "Authorization: Bearer $FARMA"; echo
  sleep 0.5
done

paso "Notificaciones de Ana DESPUES"
curl -s "$BASE/api/notifications/mias" -H "Authorization: Bearer $ANA"; echo

echo
echo "queue-service publico TurnoProximo/TurnoLlamado en el topico 'eventos:turnos'"
echo "del broker sin saber quien escucha (TFU5: stream durable, ya no pub/sub)."
echo "notifications-service, un componente independiente, entrego el aviso."
echo "Agregar SMS o push manana = crear otro consumer group sobre el mismo topico,"
echo "sin tocar queue-service (facilidad de modificacion)."
echo "Nota: si Ana no tiene un ticket en la cola (correr antes el script 1), no"
echo "recibe avisos: los presenciales no tienen app."