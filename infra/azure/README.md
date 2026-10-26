# Reroute on Azure

The whole stack runs on one Azure server, exactly as `docker compose` runs it on a laptop, with the production
settings (`docker-compose.prod.yml`) and this folder's additions. Everything is in this folder; the secrets stay on
the owner's PC (`D:\reroute-secrets`) and on the server, never in git.

| What | Where |
|---|---|
| Server | `reroute-vm`, Ubuntu 24.04, Standard_B2as_v2 (2 vCPUs, 8 GB) with 4 GB swap, Central India, in resource group `reroute-rg`. (Standard_B2ms, the first choice, had no capacity in Central India.) |
| Address | https://reroute-app.centralindia.cloudapp.azure.com (Azure's DNS name; Let's Encrypt certificate, renewed automatically) |
| Cost | About $45 a month: the VM $0.0492 an hour (about $36), its 64 GB SSD about $5, the public address about $4. Stop or delete it in the Azure portal to stop paying |
| Open ports | 80 and 443 for everyone; 22 for SSH by key only (`~/.ssh/reroute_azure` on the owner's PC) |

The public site keeps the simulated bookings, wallet and connected partners on (`docker-compose.azure.yml`): it's the
owner's demo, and every price there says it's simulated money. There's no demo account: the production settings
refuse it, so people create an account or use Google sign-in.

## First time

1. Install the Azure CLI and sign in: `az login`.
2. Create the server: `bash infra/azure/provision.sh`. It prints the address.
3. Make the server's settings, once: `python infra/azure/make_env.py D:/reroute-secrets/azure.env https://reroute-app.centralindia.cloudapp.azure.com`.
   This keeps the keys from the root `.env` (Gemini, Google sign-in and Maps, Azure Speech, `RICO_KEY`) and makes new
   passwords and secrets for the server. Push notifications use `D:/reroute-secrets/fcm-service-account.json`.
4. Deploy: `CERT_EMAIL=you@example.com bash infra/azure/deploy.sh`. The first run also gets the certificate, which
   means accepting Let's Encrypt's subscriber agreement.
5. In Google Cloud, add the address to the OAuth web client's **Authorized JavaScript origins** and **Authorized
   redirect URIs**, or Google sign-in fails there.

## Updating

Push to `main`, then run `bash infra/azure/deploy.sh` again. The server pulls `main`, opens Rico's art, rebuilds what
changed and restarts it, keeping the database. `make_env.py` never overwrites `azure.env`, so the server's passwords
don't change under it. To change a setting, edit `D:/reroute-secrets/azure.env` and deploy.

## On the server

`ssh -i ~/.ssh/reroute_azure reroute@reroute-app.centralindia.cloudapp.azure.com`, then in `/opt/reroute/app`:

- `docker compose -f docker-compose.yml -f docker-compose.prod.yml -f infra/azure/docker-compose.azure.yml ps` (or `logs -f api-1`).
- Data lives in Docker volumes on the server's disk. Back the database up with
  `docker compose ... exec postgres pg_dump -U postgres reroute > backup.sql`, and copy the file off the server.

## The Android app for this server

Release builds reach this address. Build them from `frontend` with the owner's signing key (`android/keystore.properties`,
never in git, points at `D:/reroute-secrets/reroute-release.jks`):

```
VITE_API_BASE=https://reroute-app.centralindia.cloudapp.azure.com VITE_GOOGLE_CLIENT_ID=<the web client ID> pnpm build:android
cd android && ./gradlew assembleRelease bundleRelease
```

The APK (`app/build/outputs/apk/release/`) installs on a phone; the bundle (`app/build/outputs/bundle/release/`) is
what Google Play takes. For Google sign-in in the release app, add the release key's SHA-1 to an Android OAuth client
for `com.reroute.app` in Google Cloud. Keep the key and its passwords safe: Play updates must be signed with it.
