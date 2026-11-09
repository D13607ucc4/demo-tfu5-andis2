#!/usr/bin/env bash
# Funciones compartidas por todos los scripts de demo.
# Evitamos depender de 'jq' para que corra en cualquier maquina.

BASE="${BASE:-http://localhost:8080}"
HTTPS_BASE="${HTTPS_BASE:-https://localhost:8443}"

# Extrae un campo string de un JSON plano. Uso: echo "$json" | campo token
campo() {
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*"[[:space:]]*:[[:space:]]*"//; s/"$//'
}

# Extrae un campo numerico. Uso: echo "$json" | numero posicion
numero() {
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*[0-9]*" | head -1 | grep -o '[0-9]*$'
}

# Hace login y devuelve el token.
login() {
  curl -s -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" | campo token
}

titulo() { echo; echo "=============================================================="; echo " $1"; echo "=============================================================="; }
paso()   { echo; echo "--> $1"; }

# --- Helpers para los scripts de patrones (7 a 12) --------------------------
# Cada script acumula FALLOS y termina con 'resumen' (exit != 0 si algo fallo).

FALLOS=0

# criterio <descripcion> <esperado> <obtenido>
criterio() {
  if [ "$2" = "$3" ]; then
    echo "  [OK]    $1 (=$3)"
  else
    echo "  [FALLO] $1 (esperado=$2, obtenido=$3)"
    FALLOS=$((FALLOS + 1))
  fi
  return 0
}

# criterio_ok <descripcion> <condicion: 0 = se cumple>
criterio_ok() {
  if [ "$2" -eq 0 ]; then
    echo "  [OK]    $1"
  else
    echo "  [FALLO] $1"
    FALLOS=$((FALLOS + 1))
  fi
  return 0
}

# Comparaciones numericas con decimales (para latencias de curl).
mayor_igual() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a>=b)}'; }
menor()       { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a<b)}'; }

# Crea una receta siguiendo el flujo real (el "camino feliz" del script 1):
# reserva un cupo del medico, inicia la consulta y emite la receta.
# Uso: crear_receta <token_paciente> <paciente_id> <token_medico> [medicamento]
# Devuelve el UUID de la receta (vacio si fallo).
crear_receta() {
  local t_pac="$1" pac_id="$2" t_med="$3" med="${4:-Ibuprofeno 400mg}"
  local med_id slot cita cita_id receta
  med_id=$(curl -s "$BASE/api/auth/yo" -H "Authorization: Bearer $t_med" | campo id)
  [ -n "$med_id" ] || { echo ""; return 1; }
  slot=$(curl -s "$BASE/api/scheduling/slots?medico=$med_id" \
           -H "Authorization: Bearer $t_pac" | campo id)
  [ -n "$slot" ] || { echo ""; return 1; }
  cita=$(curl -s -X POST "$BASE/api/scheduling/citas" \
           -H "Authorization: Bearer $t_pac" -H 'Content-Type: application/json' \
           -d "{\"slotId\":\"$slot\"}")
  cita_id=$(echo "$cita" | campo id)
  [ -n "$cita_id" ] || { echo ""; return 1; }
  curl -s -X POST "$BASE/api/scheduling/citas/$cita_id/iniciar" \
    -H "Authorization: Bearer $t_med" >/dev/null
  receta=$(curl -s -X POST "$BASE/api/records/recetas" \
             -H "Authorization: Bearer $t_med" -H 'Content-Type: application/json' \
             -d "{\"pacienteId\":\"$pac_id\",\"medicamento\":\"$med\",\"dosis\":\"1 cada 8hs\"}")
  receta=$(echo "$receta" | grep -o '"receta":{"id":"[^"]*"' | grep -o '[0-9a-f-]\{36\}')
  # TFU5: esperamos a que el evento RecetaEmitida llegue a farmacia.
  [ -n "$receta" ] && QUIET_ESPERA=1 esperar_receta_en_farmacia "$t_pac" "$receta" >/dev/null
  echo "$receta"
}

# TFU5 - CONSISTENCIA EVENTUAL: la farmacia conoce una receta recien cuando le
# llega el evento RecetaEmitida (outbox de records -> broker -> pharmacy).
# Espera hasta que la receta aparezca en la replica local de farmacia.
# Uso: esperar_receta_en_farmacia <token_paciente> <receta_id> [timeout_s]
# Si el endpoint no existe (rama tfu4), no espera.
esperar_receta_en_farmacia() {
  local t_pac="$1" receta="$2" max="${3:-10}" code t0 t1
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/pharmacy/recetas/mias" -H "Authorization: Bearer $t_pac")
  [ "$code" = "200" ] || return 0
  # Sondeo cada 200 ms (5 req/s): el gateway limita a 20 req/s por IP
  # (PATRON RATE LIMITING de la TFU4) y un sondeo mas agresivo se come el
  # cupo de los demas pedidos del script, que reciben 429.
  t0=$(date +%s%N)
  for _ in $(seq 1 $((max * 5))); do
    if curl -s "$BASE/api/pharmacy/recetas/mias" -H "Authorization: Bearer $t_pac" | grep -q "$receta"; then
      t1=$(date +%s%N)
      [ -n "${QUIET_ESPERA:-}" ] || echo "  receta $receta replicada en farmacia en $(( (t1 - t0) / 1000000 ))ms"
      return 0
    fi
    sleep 0.2
  done
  echo "  (la receta $receta no llego a farmacia en ${max}s)"
  return 1
}

# Imprime el resumen final y devuelve 1 si algun criterio fallo.
resumen() {
  echo
  if [ "$FALLOS" -eq 0 ]; then
    echo "=============================================================="
    echo " RESULTADO: todos los criterios OK"
    echo "=============================================================="
    return 0
  fi
  echo "=============================================================="
  echo " RESULTADO: $FALLOS criterio(s) FALLARON"
  echo "=============================================================="
  return 1
}

# --- Helpers TFU5 -------------------------------------------------------------
# Ejecuta un snippet de Node DENTRO de la red interna (en el contenedor del
# servicio indicado). Las variables de entorno del contenedor (BROKER_URL,
# INTERNAL_TOKEN, ...) estan disponibles en process.env.
# Uso: node_en <servicio> '<codigo js>'
node_en() {
  docker compose exec -T "$1" node -e "$2"
}

# URL interna de scheduling (vista desde dentro de la red clinicare).
SCHED_INTERNO="${SCHED_INTERNO:-http://scheduling:3000}"

# redis-cli contra el broker de eventos / contra el redis de cache-cola.
broker_cli() { docker compose exec -T broker redis-cli "$@" | tr -d '\r'; }
cache_cli()  { docker compose exec -T redis  redis-cli "$@" | tr -d '\r'; }

# psql contra la base (salida "pelada": sin encabezados ni alineacion).
sql() { docker compose exec -T postgres psql -U clinicare -d clinicare -tAc "$1" | tr -d '\r'; }
