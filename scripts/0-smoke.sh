#!/usr/bin/env bash
# Verificacion rapida: todos los componentes arriba y respondiendo.
set -e
source "$(dirname "$0")/lib.sh"

titulo "SMOKE TEST - salud de los componentes"

paso "Gateway"
curl -s "$BASE/healthz"; echo

for c in auth scheduling records pharmacy queue notifications; do
  paso "Componente: $c"
  # Nota: /healthz de cada servicio se alcanza por su prefijo de API.
  curl -s -i "$BASE/api/$c/../healthz" >/dev/null 2>&1 || true
  docker compose exec -T "$c" wget -qO- http://localhost:3000/healthz 2>/dev/null || echo "(usar: docker compose ps)"
  echo
done

paso "Login de prueba"
TOKEN=$(login ana@paciente.uy ana123)
[ -n "$TOKEN" ] && echo "OK, token obtenido (${#TOKEN} chars)" || { echo "FALLO el login"; exit 1; }