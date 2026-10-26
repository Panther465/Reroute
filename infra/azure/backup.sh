#!/usr/bin/env bash
# Reroute's nightly backup on its Azure server (reroute-backup.timer runs it; infra/azure/README.md): both databases,
# PostgreSQL (every database and role, pg_dumpall) and MongoDB (mongodump), each gzipped and sent to the private
# "backups" container of the storage account named in .env (BACKUP_STORAGE_ACCOUNT). The server signs in with its
# own managed identity: no storage key lives on it. Azure deletes copies after 30 days; the server keeps its last 7.
set -euo pipefail

APP=/opt/reroute/app
LOCAL=/opt/reroute/backups
ACCOUNT=$(grep -E '^BACKUP_STORAGE_ACCOUNT=' "$APP/.env" | cut -d= -f2-)
[ -n "$ACCOUNT" ] || { echo "No BACKUP_STORAGE_ACCOUNT in $APP/.env" >&2; exit 1; }
STAMP=$(date -u +%Y%m%d-%H%M)
compose() { docker compose -p reroute -f "$APP/docker-compose.yml" -f "$APP/docker-compose.prod.yml" -f "$APP/infra/azure/docker-compose.azure.yml" --project-directory "$APP" "$@"; }

mkdir -p "$LOCAL"
compose exec -T postgres pg_dumpall -U postgres | gzip -9 > "$LOCAL/postgres-$STAMP.sql.gz"
compose exec -T mongo mongodump --quiet --archive --gzip > "$LOCAL/mongo-$STAMP.archive.gz"
# A dump that came out empty is a failure, not a backup.
for f in "$LOCAL/postgres-$STAMP.sql.gz" "$LOCAL/mongo-$STAMP.archive.gz"; do
  [ "$(stat -c %s "$f")" -gt 1000 ] || { echo "Backup $f is too small" >&2; exit 1; }
done

# The managed identity's token for Azure Storage, from the VM's metadata service.
TOKEN=$(curl -sf -H Metadata:true "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://storage.azure.com/" | python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')
for f in "$LOCAL/postgres-$STAMP.sql.gz" "$LOCAL/mongo-$STAMP.archive.gz"; do
  curl -sf -X PUT -T "$f" \
    -H "Authorization: Bearer $TOKEN" -H "x-ms-version: 2021-08-06" -H "x-ms-blob-type: BlockBlob" \
    "https://$ACCOUNT.blob.core.windows.net/backups/$(basename "$f")"
done

find "$LOCAL" -type f -mtime +7 -delete
echo "Backed up $(ls -1 "$LOCAL" | grep -c "$STAMP") files to https://$ACCOUNT.blob.core.windows.net/backups/ ($STAMP)"
