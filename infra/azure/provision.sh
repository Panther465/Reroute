#!/usr/bin/env bash
# Creates Reroute's Azure server, once (infra/azure/README.md): a resource group, and an Ubuntu 24.04 VM with a public
# address and a DNS name, ports 80 and 443 open (and 22 for SSH, by key only), set up on first boot by
# cloud-init.yaml. Standard_B2as_v2 (2 vCPUs, 8 GB; B2ms had no capacity in Central India) is about $45 a month
# with its disk and address.
# Needs the Azure CLI, signed in (az login). Run from the repository root:  bash infra/azure/provision.sh
set -euo pipefail

RG=${RG:-reroute-rg}
LOCATION=${LOCATION:-centralindia}
VM=${VM:-reroute-vm}
SIZE=${SIZE:-Standard_B2as_v2}
DNS=${DNS:-reroute-app}
KEY=${KEY:-$HOME/.ssh/reroute_azure}
HERE=$(cd "$(dirname "$0")" && pwd)

# Git Bash on Windows finds the Azure CLI only as az.cmd.
command -v az >/dev/null 2>&1 || az() { az.cmd "$@"; }

# The server's own SSH key, kept on this PC only.
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C reroute-azure -f "$KEY"

az group create --name "$RG" --location "$LOCATION" --output none
az vm create \
  --resource-group "$RG" --name "$VM" --location "$LOCATION" \
  --image Canonical:ubuntu-24_04-lts:server:latest --size "$SIZE" \
  --admin-username reroute --ssh-key-values "$KEY.pub" \
  --public-ip-sku Standard --public-ip-address-dns-name "$DNS" \
  --os-disk-size-gb 64 --storage-sku StandardSSD_LRS \
  --custom-data "$HERE/cloud-init.yaml" \
  --output none
az vm open-port --resource-group "$RG" --name "$VM" --port 80,443 --priority 900 --output none

echo "https://$DNS.$LOCATION.cloudapp.azure.com"
