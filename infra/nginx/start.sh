#!/bin/sh
# Creates a self-signed certificate for localhost on first start (local use only), then runs NGINX.
# For a deployment, mount a real certificate at /etc/nginx/certs/localhost.{crt,key}.
set -eu

if [ ! -f /etc/nginx/certs/localhost.crt ]; then
  command -v openssl >/dev/null 2>&1 || apk add --no-cache openssl >/dev/null
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout /etc/nginx/certs/localhost.key -out /etc/nginx/certs/localhost.crt 2>/dev/null
fi

exec nginx -g "daemon off;"
