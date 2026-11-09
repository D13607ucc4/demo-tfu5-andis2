#!/usr/bin/env bash
# DEMO 4 - ACID
#
# Prueba 1 (AISLAMIENTO): dos pacientes reservan el MISMO cupo simultaneamente.
#            Debe haber exactamente un 201 y un 409.
# Prueba 2 (ATOMICIDAD): forzamos una falla despues del UPDATE del cupo.
#            El ROLLBACK debe dejar el cupo LIBRE otra vez.
set -e
source "$(dirname "$0")/lib.sh"

titulo "DEMO 4 - Transacciones ACID en scheduling-service"

ANA=$(login ana@paciente.uy ana123)
BETO=$(login beto@paciente.uy beto123)

MEDICO=$(curl -s "$BASE/api/scheduling/medicos" -H "Authorization: Bearer $ANA" | campo id)
SLOT=$(curl -s "$BASE/api/scheduling/slots?medico=$MEDICO" -H "Authorization: Bearer $ANA" | campo id)
echo "Cupo en disputa: $SLOT"

paso "PRUEBA 1 - Ana y Beto reservan el mismo cupo AL MISMO TIEMPO"
curl -s -o /tmp/ana.json  -w "Ana : HTTP %{http_code}\n" -X POST "$BASE/api/scheduling/citas" \
  -H "Authorization: Bearer $ANA"  -H 'Content-Type: application/json' -d "{\"slotId\":\"$SLOT\"}" &
curl -s -o /tmp/beto.json -w "Beto: HTTP %{http_code}\n" -X POST "$BASE/api/scheduling/citas" \
  -H "Authorization: Bearer $BETO" -H 'Content-Type: application/json' -d "{\"slotId\":\"$SLOT\"}" &
wait

echo; echo "Respuesta Ana : $(cat /tmp/ana.json)"
echo      "Respuesta Beto: $(cat /tmp/beto.json)"
echo
echo "Explicacion: el primero en llegar bloquea la fila con SELECT ... FOR UPDATE."
echo "El segundo queda ESPERANDO en esa misma linea; cuando el primero commitea,"
echo "despierta, lee estado='RESERVADO' y aborta con 409. Nunca hay doble reserva."

paso "Verificacion en la base: cuantas citas tiene ese cupo (debe ser 1)"
docker compose exec -T postgres psql -U clinicare -d clinicare -c \
  "SELECT count(*) AS citas_del_cupo FROM scheduling.citas WHERE slot_id='$SLOT';"

paso "PRUEBA 2 - ATOMICIDAD: forzamos un error despues del UPDATE"
SLOT2=$(curl -s "$BASE/api/scheduling/slots?medico=$MEDICO" -H "Authorization: Bearer $ANA" | campo id)
echo "Cupo de prueba: $SLOT2"

echo "Estado ANTES:"
docker compose exec -T postgres psql -U clinicare -d clinicare -c \
  "SELECT id, estado FROM scheduling.agenda_slots WHERE id='$SLOT2';"

echo "Reserva con forzarError=true (falla entre el UPDATE y el INSERT):"
curl -s -X POST "$BASE/api/scheduling/citas" \
  -H "Authorization: Bearer $ANA" -H 'Content-Type: application/json' \
  -d "{\"slotId\":\"$SLOT2\",\"forzarError\":true}"; echo

echo "Estado DESPUES (debe seguir LIBRE gracias al ROLLBACK):"
docker compose exec -T postgres psql -U clinicare -d clinicare -c \
  "SELECT id, estado FROM scheduling.agenda_slots WHERE id='$SLOT2';"

echo "Y no quedo ninguna cita huerfana:"
docker compose exec -T postgres psql -U clinicare -d clinicare -c \
  "SELECT count(*) AS citas FROM scheduling.citas WHERE slot_id='$SLOT2';"

echo
echo "A = todo o nada | C = UNIQUE impide estados invalidos"
echo "I = FOR UPDATE serializa | D = lo commiteado sobrevive"