#!/bin/sh
# certbot's deploy hook on Reroute's Azure server (deploy.sh installs it in /etc/letsencrypt/renewal-hooks/deploy/):
# after the certificate is issued or renewed, put it where NGINX reads it (localhost.crt and .key, the names
# infra/nginx/nginx.conf uses) and reload NGINX.
set -eu
install -m 644 "$RENEWED_LINEAGE/fullchain.pem" /opt/reroute/certs/localhost.crt
install -m 600 "$RENEWED_LINEAGE/privkey.pem" /opt/reroute/certs/localhost.key
nginx=$(docker ps -q --filter label=com.docker.compose.project=reroute --filter label=com.docker.compose.service=nginx)
[ -z "$nginx" ] || docker exec "$nginx" nginx -s reload
