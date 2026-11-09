#!/usr/bin/env bash
# DEMO 1 - COMPONENTES E INTERFACES
# 
# Recorre el flujo de negocio completo y muestra como CADA paso atraviesa
# distintos componentes, consumiendo las interfaces publicadas por otros.
set -e
source "$(dirname "$0")/lib.sh"

titulo "DEMO 1 - Componentes e interfaces (flujo end-to-end)"

paso "1) auth-service: login de la paciente Ana [IAutenticacion]"
ANA=$(login ana@paciente.uy ana123)
echo "Token de Ana obtenido."

paso "2) scheduling-service: especialidades y medicos [IAgenda]"
curl -s "$BASE/api/scheduling/especialidades" -H "Authorization: Bearer $ANA"; echo
MEDICOS=$(curl -s "$BASE/api/scheduling/medicos?especialidad=1" -H "Authorization: Bearer $ANA")
echo "$MEDICOS"
MEDICO=$(echo "$MEDICOS" | campo id)

paso "3) scheduling-service: cupos libres del medico $MEDICO"
SLOTS=$(curl -s "$BASE/api/scheduling/slots?medico=$MEDICO" -H "Authorization: Bearer $ANA")
SLOT=$(echo "$SLOTS" | campo id)
echo "Primer cupo libre: $SLOT"

paso "4) HU1 - Ana reserva la cita (transaccion ACID)"
CITA=$(curl -s -X POST "$BASE/api/scheduling/citas" \
  -H "Authorization: Bearer $ANA" -H 'Content-Type: application/json' \
  -d "{\"slotId\":\"$SLOT\"}")
echo "$CITA"
CITA_ID=$(echo "$CITA" | campo id)

paso "5) HU5 - La medica intenta ver la historia SIN consulta iniciada"
LUCIA=$(login lucia@clinica.uy lucia123)
curl -s "$BASE/api/records/pacientes/11111111-1111-1111-1111-111111111111/historia" \
  -H "Authorization: Bearer $LUCIA"; echo
echo "^ Denegado: records-service consulto a scheduling-service y no hay consulta en curso."

paso "6) La medica inicia la consulta"
curl -s -X POST "$BASE/api/scheduling/citas/$CITA_ID/iniciar" -H "Authorization: Bearer $LUCIA"; echo

paso "7) HU5 - Ahora SI accede a la historia clinica"
curl -s "$BASE/api/records/pacientes/11111111-1111-1111-1111-111111111111/historia" \
  -H "Authorization: Bearer $LUCIA"; echo

paso "8) HU6 - La medica receta un medicamento [IHistoriaClinica]"
RECETA=$(curl -s -X POST "$BASE/api/records/recetas" \
  -H "Authorization: Bearer $LUCIA" -H 'Content-Type: application/json' \
  -d '{"pacienteId":"11111111-1111-1111-1111-111111111111","medicamento":"Amoxicilina 500mg","dosis":"1 cada 8hs por 7 dias"}')
echo "$RECETA"
RECETA_ID=$(echo "$RECETA" | grep -o '"receta":{"id":"[^"]*"' | grep -o '[0-9a-f-]\{36\}')

paso "8b) TFU5 - El evento RecetaEmitida llega a la replica local de farmacia"
esperar_receta_en_farmacia "$ANA" "$RECETA_ID"

paso "9) HU2 - Ana solicita el retiro y entra a la cola VIRTUAL [IFarmacia]"
RETIRO=$(curl -s -X POST "$BASE/api/pharmacy/retiros" \
  -H "Authorization: Bearer $ANA" -H 'Content-Type: application/json' \
  -d "{\"recetaId\":\"$RECETA_ID\"}")
echo "$RETIRO"

sleep 1   # damos tiempo a que el evento llegue a queue-service

paso "10) queue-service: estado de la cola [ICola]"
curl -s "$BASE/api/queue/farmacia" -H "Authorization: Bearer $ANA"; echo

paso "11) Ana consulta su turno desde el celular (no espera en la sala)"
curl -s "$BASE/api/queue/mi-turno" -H "Authorization: Bearer $ANA"; echo

paso "12) HU7 - El farmaceutico llama al siguiente"
FARMA=$(login farma@clinica.uy farma123)
curl -s -X POST "$BASE/api/queue/farmacia/siguiente" -H "Authorization: Bearer $FARMA"; echo

paso "13) HU3 - Notificaciones recibidas por Ana"
curl -s "$BASE/api/notifications/mias" -H "Authorization: Bearer $ANA"; echo

paso "14) TRAZABILIDAD - el admin revisa la auditoria de accesos clinicos"
ADMIN=$(login admin@clinica.uy admin123)
curl -s "$BASE/api/records/auditoria" -H "Authorization: Bearer $ADMIN"; echo

echo; echo "Se atravesaron 6 componentes, cada uno con su interfaz publicada."