#!/usr/bin/env bash
# Deploys main to Reroute's Azure server (provision.sh made it; infra/azure/README.md). Sends the server its settings
# (the production .env and Firebase's push key, from the secrets folder on this PC, never git); then, on the server,
# pulls main from GitHub, opens Rico's art with RICO_KEY, rebuilds and restarts the stack, and gets or renews the
# Let's Encrypt certificate. Run from the repository root:  bash infra/azure/deploy.sh
set -euo pipefail

HOST=${HOST:-reroute-app.centralindia.cloudapp.azure.com}
KEY=${KEY:-$HOME/.ssh/reroute_azure}
SECRETS=${SECRETS:-/d/reroute-secrets}
REPO=${REPO:-https://github.com/Panther465/Reroute.git}
# Let's Encrypt's notices about the certificate (expiry, policy changes) go here.
CERT_EMAIL=${CERT_EMAIL:?Set CERT_EMAIL, where Let\'s Encrypt sends notices about the certificate}

ssh_() { ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "reroute@$HOST" "$@"; }

# A new server takes a minute to answer SSH, and its first boot sets up Docker before anything else.
for _ in $(seq 1 60); do ssh_ -o ConnectTimeout=5 true 2>/dev/null && break; sleep 5; done
ssh_ 'until [ -f /var/lib/cloud/instance/reroute-ready ]; do sleep 5; done'
scp -q -i "$KEY" "$SECRETS/azure.env" "reroute@$HOST:/opt/reroute/secrets/reroute.env"
if [ -f "$SECRETS/fcm-service-account.json" ]; then
  scp -q -i "$KEY" "$SECRETS/fcm-service-account.json" "reroute@$HOST:/opt/reroute/secrets/fcm-service-account.json"
fi

ssh_ "REPO='$REPO' HOST='$HOST' CERT_EMAIL='$CERT_EMAIL' bash -s" <<'ON_SERVER'
set -euo pipefail
chmod 700 /opt/reroute/secrets
chmod 600 /opt/reroute/secrets/reroute.env
# The worker reads Firebase's key as its own user (Docker hands it the file as it is here), so the file is readable;
# the folder around it is this login's alone.
[ ! -f /opt/reroute/secrets/fcm-service-account.json ] || chmod 644 /opt/reroute/secrets/fcm-service-account.json
[ -d /opt/reroute/app/.git ] || git clone --quiet "$REPO" /opt/reroute/app
cd /opt/reroute/app
git fetch --quiet origin main
git reset --quiet --hard origin/main
install -m 600 /opt/reroute/secrets/reroute.env .env

# Rico's art is in git only encrypted: open it with RICO_KEY (from .env) before the web image is built.
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/app -w /app/frontend node:22-alpine node rico/lock.mjs unlock --quiet

compose() { docker compose -p reroute -f docker-compose.yml -f docker-compose.prod.yml -f infra/azure/docker-compose.azure.yml "$@"; }
compose up -d --build --remove-orphans --wait --wait-timeout 900
docker image prune -f >/dev/null

# The nightly backup (backup.sh, reroute-backup.timer), once the server knows where to send it: BACKUP_STORAGE_ACCOUNT,
# from setup-backups-and-alerts.sh.
if grep -q '^BACKUP_STORAGE_ACCOUNT=.' .env; then
  sudo install -m 644 infra/azure/reroute-backup.service infra/azure/reroute-backup.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --quiet --now reroute-backup.timer
fi

# The certificate: issued the first time, then renewed by certbot's own timer; its hook hands each one to NGINX.
sudo install -D -m 755 infra/azure/cert-hook.sh /etc/letsencrypt/renewal-hooks/deploy/reroute.sh
if [ ! -d "/etc/letsencrypt/live/$HOST" ]; then
  sudo certbot certonly --non-interactive --agree-tos --email "$CERT_EMAIL" --webroot -w /opt/reroute/acme -d "$HOST"
  sudo env RENEWED_LINEAGE="/etc/letsencrypt/live/$HOST" /etc/letsencrypt/renewal-hooks/deploy/reroute.sh
fi
compose ps --format '{{.Service}}: {{.Status}}'
ON_SERVER

echo "Deployed: https://$HOST"
