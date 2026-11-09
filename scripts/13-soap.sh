#!/usr/bin/env bash
# TFU5 - MIGRACION REST -> SOAP  (IRelacionClinica de scheduling-service)
#
# Que demuestra:
#   1) El contrato WSDL esta publicado por scheduling (GET ?wsdl).
#   2) La operacion ConsultarRelacionClinica responde mensajes XML SOAP 1.1
#      (se invoca "a mano" con un sobre SOAP desde la red interna).
#   3) La funcionalidad se conserva: false sin consulta en curso, true con
#      consulta EN_CURSO (misma regla que el REST de la TFU4).
#   4) Errores tipados: UUID invalido => soap:Fault (soap:Client); sin token de
#      red interna => 403.
#   5) El endpoint REST viejo ya no existe.
#   6) OTRO COMPONENTE lo consume: records-service decide el acceso a la
#      historia clinica llamando al servicio SOAP (cliente generado del WSDL).
set -u
source "${LIB:-$(dirname "$0")/lib.sh}"

ANA_ID="11111111-1111-1111-1111-111111111111"
LUCIA_ID="33333333-3333-3333-3333-333333333333"

titulo "TFU5 - MIGRACION REST -> SOAP (IRelacionClinica)"

# Cliente SOAP minimo (fetch) que corre DENTRO de la red interna, en el
# contenedor de records. Imprime: <status>\n<xml>
soap_call() {   # soap_call <medicoId> <pacienteId> <conToken:1|0>
  node_en records "
    const sobre = '<?xml version=\"1.0\" encoding=\"utf-8\"?>' +
      '<soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\" ' +
      'xmlns:rc=\"urn:clinicare:scheduling:relacion-clinica:v1\"><soap:Body>' +
      '<rc:ConsultarRelacionClinicaRequest><rc:medicoId>$1</rc:medicoId>' +
      '<rc:pacienteId>$2</rc:pacienteId></rc:ConsultarRelacionClinicaRequest>' +
      '</soap:Body></soap:Envelope>';
    const h = { 'Content-Type': 'text/xml; charset=utf-8',
                SOAPAction: 'urn:clinicare:scheduling:relacion-clinica:v1#ConsultarRelacionClinica' };
    if ('$3' === '1') h['X-Internal-Token'] = process.env.INTERNAL_TOKEN;
    fetch('$SCHED_INTERNO/soap/relacion-clinica', { method: 'POST', headers: h, body: sobre })
      .then(async r => { console.log(r.status); console.log(await r.text()); })
      .catch(e => { console.log('ERR'); console.log(e.message); });"
}

paso "1) Contrato WSDL publicado por scheduling"
WSDL=$(node_en records "fetch('$SCHED_INTERNO/soap/relacion-clinica?wsdl').then(r=>r.text()).then(t=>console.log(t))")
echo "$WSDL" | grep -E "operation name|soap:address|element name=\"Consultar" | sed 's/^ */  /' | head -6
echo "$WSDL" | grep -q 'name="ConsultarRelacionClinica"'; criterio_ok "el WSDL declara la operacion ConsultarRelacionClinica" $?
echo "$WSDL" | grep -q 'style="document"'; criterio_ok "binding SOAP document/literal" $?

paso "2) Invocacion SOAP directa (sobre XML) SIN consulta en curso"
# Partimos de un estado conocido: ninguna consulta EN_CURSO entre Lucia y Ana
# (las demos anteriores pueden haber dejado una abierta).
sql "UPDATE scheduling.citas SET estado='FINALIZADA' WHERE medico_id='$LUCIA_ID' AND paciente_id='$ANA_ID' AND estado='EN_CURSO'" >/dev/null
R=$(soap_call "$LUCIA_ID" "$ANA_ID" 1)
ST=$(echo "$R" | head -1); XML=$(echo "$R" | tail -n +2)
echo "  HTTP $ST"; echo "$XML" | sed 's/></>\n</g' | sed 's/^/    /' | head -12
criterio "HTTP 200" "200" "$ST"
echo "$XML" | grep -q "consultaEnCurso>false<"; criterio_ok "respuesta XML con consultaEnCurso=false" $?

paso "3) Creo una consulta EN_CURSO (Ana con Lucia) y vuelvo a consultar"
ANA=$(login ana@paciente.uy ana123)
LUCIA=$(login lucia@clinica.uy lucia123)
SLOT=$(curl -s "$BASE/api/scheduling/slots?medico=$LUCIA_ID" -H "Authorization: Bearer $ANA" | campo id)
CITA=$(curl -s -X POST "$BASE/api/scheduling/citas" -H "Authorization: Bearer $ANA" \
       -H 'Content-Type: application/json' -d "{\"slotId\":\"$SLOT\"}" | campo id)
curl -s -X POST "$BASE/api/scheduling/citas/$CITA/iniciar" -H "Authorization: Bearer $LUCIA" >/dev/null
R=$(soap_call "$LUCIA_ID" "$ANA_ID" 1)
XML=$(echo "$R" | tail -n +2)
echo "$XML" | grep -o '<[a-zA-Z:]*consultaEnCurso>[^<]*<\|<[a-zA-Z:]*citaId>[^<]*<' | sed 's/^/    /'
echo "$XML" | grep -q "consultaEnCurso>true<"; criterio_ok "con consulta EN_CURSO => consultaEnCurso=true" $?
echo "$XML" | grep -q "$CITA"; criterio_ok "la respuesta incluye el citaId de la consulta" $?

paso "4) Errores tipados del contrato"
R=$(soap_call "no-es-un-uuid" "$ANA_ID" 1)
ST=$(echo "$R" | head -1); XML=$(echo "$R" | tail -n +2)
echo "  UUID invalido -> HTTP $ST  $(echo "$XML" | grep -o '<faultstring>[^<]*' | sed 's/<faultstring>//')"
echo "$XML" | grep -q "Fault"; criterio_ok "UUID invalido => soap:Fault" $?
R=$(soap_call "$LUCIA_ID" "$ANA_ID" 0)
ST=$(echo "$R" | head -1)
echo "  sin X-Internal-Token -> HTTP $ST"
criterio "sin token de red interna => 403" "403" "$ST"

paso "5) El endpoint REST de la TFU4 ya no existe"
ST=$(node_en records "fetch('$SCHED_INTERNO/api/scheduling/internal/relacion?medicoId=$LUCIA_ID&pacienteId=$ANA_ID',{headers:{'X-Internal-Token':process.env.INTERNAL_TOKEN}}).then(r=>console.log(r.status))")
echo "  GET /api/scheduling/internal/relacion -> HTTP $ST"
criterio "REST viejo retirado" "404" "$ST"

paso "6) OTRO COMPONENTE consume el SOAP: records decide el acceso a la historia"
OUT=$(curl -s -w ' HTTP%{http_code}' "$BASE/api/records/pacientes/$ANA_ID/historia" -H "Authorization: Bearer $LUCIA")
echo "  $(echo "$OUT" | cut -c1-110)... $(echo "$OUT" | grep -o 'HTTP[0-9]*')"
echo "$OUT" | grep -q "Consulta en curso con el paciente"; criterio_ok "records concede el acceso segun la respuesta SOAP" $?
BETO_ID="22222222-2222-2222-2222-222222222222"
OUT=$(curl -s "$BASE/api/records/pacientes/$BETO_ID/historia" -H "Authorization: Bearer $LUCIA")
echo "  historia de Beto (sin consulta): $OUT"
echo "$OUT" | grep -q "no tiene consulta en curso"; criterio_ok "records niega el acceso segun la respuesta SOAP" $?

# Cierro la consulta para no dejar estado colgado en otras demos.
sql "UPDATE scheduling.citas SET estado='FINALIZADA' WHERE id='$CITA'" >/dev/null

resumen
