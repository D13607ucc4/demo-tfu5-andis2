#!/usr/bin/env bash
# DEMO 3 - ESCALABILIDAD HORIZONTAL (HU8: estabilidad en picos de demanda)
# 
# Comparamos el tiempo total de N requests con 1 replica vs 3 replicas.
# El componente tiene un limite de 0.35 CPU por replica (ver docker-compose),
# asi que la mejora se nota: sumamos capacidad agregando instancias, no
# haciendo mas grande una sola (eso seria escalado vertical).
set -e
source "$(dirname "$0")/lib.sh"

REQUESTS=${REQUESTS:-200}
PARALELO=${PARALELO:-20}

titulo "DEMO 3 - Escalabilidad horizontal"

# Genera carga en paralelo contra el gateway.
generar_carga() {
  local inicio fin
  inicio=$(date +%s%N)
  seq 1 "$REQUESTS" | xargs -P "$PARALELO" -I{} \
    curl -s -o /dev/null "$BASE/api/queue/farmacia/resumen"
  fin=$(date +%s%N)
  echo $(( (fin - inicio) / 1000000 ))   # milisegundos
}

paso "Escenario A: 1 replica de queue-service"
docker compose up -d --scale queue=1 queue >/dev/null
sleep 6
MS_1=$(generar_carga)
echo "$REQUESTS requests con concurrencia $PARALELO -> ${MS_1} ms"

paso "Escenario B: 3 replicas de queue-service"
docker compose up -d --scale queue=3 queue >/dev/null
sleep 8
docker compose ps queue
MS_3=$(generar_carga)
echo "$REQUESTS requests con concurrencia $PARALELO -> ${MS_3} ms"

paso "Resultado"
echo "1 replica : ${MS_1} ms"
echo "3 replicas: ${MS_3} ms"
if [ "$MS_3" -lt "$MS_1" ]; then
  echo "Mejora: $(( (MS_1 - MS_3) * 100 / MS_1 ))% menos tiempo total."
else
  echo "Sin mejora medible: probablemente el cuello de botella esta en Redis o"
  echo "en el cliente. Subi REQUESTS/PARALELO para saturar mas."
fi

paso "Reparto real del trafico entre replicas"
for i in $(seq 1 12); do
  curl -s -D - -o /dev/null "$BASE/api/queue/farmacia/resumen" \
    | grep -i 'x-served-by' | tr -d '\r'
done | sort | uniq -c

echo
echo "CONCLUSION: el componente escala horizontalmente porque es sin estado."
echo "El estado compartido esta afuera (Redis), no en la memoria del proceso."
echo
echo "Escalado VERTICAL: esta en docker-compose.yml, en deploy.resources.limits."
echo "PostgreSQL (con estado) se escala asi, subiendo cpus/memory, porque no se"
echo "replica de forma trivial. Para verlo: bajar cpus a 0.25 y repetir la carga."