#!/usr/bin/env bash
# Backups and the site-down alert for Reroute's Azure server, once (infra/azure/README.md):
# - a private storage account (its "backups" container keeps each copy for 30 days, backup-retention.json), which
#   the server writes to with its own managed identity: no storage key is handed out;
# - Azure Monitor checking the site every 5 minutes from two places, and emailing ALERT_EMAIL when both fail
#   (monitoring.json), about $10 a month.
# Prints the storage account's name, for BACKUP_STORAGE_ACCOUNT in the server's settings. Needs the Azure CLI,
# signed in. Run from the repository root:  ALERT_EMAIL=you@example.com bash infra/azure/setup-backups-and-alerts.sh
set -euo pipefail

RG=${RG:-reroute-rg}
LOCATION=${LOCATION:-centralindia}
VM=${VM:-reroute-vm}
HOST=${HOST:-reroute-app.centralindia.cloudapp.azure.com}
ALERT_EMAIL=${ALERT_EMAIL:?Set ALERT_EMAIL, where the site-down alert goes}
HERE=$(cd "$(dirname "$0")" && pwd)

# Git Bash on Windows finds the Azure CLI only as az.cmd, and hands it Windows paths. It would also turn Azure's own
# addresses (/subscriptions/…, the role's scope) into folder paths, so it's told to leave arguments alone.
command -v az >/dev/null 2>&1 || az() { az.cmd "$@"; }
export MSYS_NO_PATHCONV=1
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

# A new subscription has Azure's monitoring switched off until asked for (free, once).
for provider in Microsoft.Insights Microsoft.OperationalInsights Microsoft.AlertsManagement; do
  az provider register --namespace "$provider" --wait --output none
done

# One name per subscription, the same on every run.
ACCOUNT=${BACKUP_STORAGE_ACCOUNT:-reroutebk$(az account show --query id -o tsv | tr -d '\r' | sha1sum | cut -c1-8)}
az storage account create --name "$ACCOUNT" --resource-group "$RG" --location "$LOCATION" --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --allow-blob-public-access false --https-only true --output none
az storage container-rm create --storage-account "$ACCOUNT" --resource-group "$RG" --name backups --output none
az storage account management-policy create --account-name "$ACCOUNT" --resource-group "$RG" --policy "@$(win "$HERE/backup-retention.json")" --output none

PRINCIPAL=$(az vm identity assign --resource-group "$RG" --name "$VM" --query systemAssignedIdentity --output tsv | tr -d '\r')
SCOPE=$(az storage account show --name "$ACCOUNT" --resource-group "$RG" --query id --output tsv | tr -d '\r')
az role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" --scope "$SCOPE" --output none

az deployment group create --resource-group "$RG" --name reroute-monitoring --template-file "$(win "$HERE/monitoring.json")" \
  --parameters siteUrl="https://$HOST/v1/healthz" alertEmail="$ALERT_EMAIL" --output none

echo "BACKUP_STORAGE_ACCOUNT=$ACCOUNT"
