#!/usr/bin/env bash
# GENERA EL CERTIFICADO AUTOFIRMADO DEL GATEWAY  (PATRON 6 - GATEWAY OFFLOADING)
#
# Por que: el TLS se TERMINA en nginx (en el borde). Los servicios internos
# siguen hablando HTTP plano. Para la demo alcanza un certificado autofirmado
# (no hay una CA real), asi que el cliente debe usar `curl -k`.
#
# Correr UNA VEZ antes de `docker compose up`:
#     ./scripts/gen-certs.sh
#
# Es idempotente: si el certificado ya existe, no lo regenera.
set -u

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERTS="$DIR/nginx/certs"

mkdir -p "$CERTS"

if [ -f "$CERTS/localhost.crt" ] && [ -f "$CERTS/localhost.key" ]; then
  echo "El certificado ya existe en $CERTS (no se regenera)."
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: no se encontro 'openssl'. Instalalo (viene con Git Bash en Windows)." >&2
  exit 1
fi

echo "Generando certificado autofirmado CN=localhost en $CERTS ..."

# Trabajamos DENTRO de la carpeta de certs con nombres RELATIVOS.
# Por que: en Git Bash de Windows, MSYS_NO_PATHCONV=1 (necesario para que el
# -subj "/CN=localhost" no se reescriba como ruta) tambien impide que openssl
# (binario nativo) entienda rutas absolutas tipo /c/Users/... . Con nombres
# relativos evitamos ese choque.
cd "$CERTS" || exit 1

MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout localhost.key -out localhost.crt \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null

if [ ! -f localhost.crt ]; then
  # OpenSSL viejo sin -addext: reintentamos sin SAN.
  MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout localhost.key -out localhost.crt \
    -subj "/CN=localhost" 2>/dev/null
fi

if [ -f "$CERTS/localhost.crt" ] && [ -f "$CERTS/localhost.key" ]; then
  echo "OK: $CERTS/localhost.crt"
  echo "Recorda levantar con: docker compose up -d --build"
else
  echo "FALLO: no se pudo generar el certificado." >&2
  exit 1
fi
