# Known limits

Honest gaps in this build. Each is a deliberate scope choice or waits on the team.

## Data

- **Bengaluru travel times are sample values** (`examples/bengaluru/travel-times.json`), from the project brief. Pairs not listed have no leg option, so a task at a new place can't be planned until OSRM is enabled (`TRAVEL_TIMES_SOURCE=osrm`, `docker compose --profile routing up`).
- **Day 2 of the demo (Train home, KSR Bengaluru) can't be planned:** the sample snapshot has no pairs to or from KSR, and the brief forbids inventing travel times. The task shows on the timeline under tomorrow.
- **The metro timetable file** (`examples/<city>/metro.json`) isn't supplied yet; with OSRM on, metro legs appear only once it exists.
- **The campus trip and its 20 to 30 real Raasta routes** wait on the team's mapping.
- **Sample Raasta routes** other than Koramangala–Jayanagar exist only to show the unverified, stale and e-rickshaw states.

## Features

- **The optional AI helper** ("Describe your day") is off and its endpoint isn't built; the brief says to start it only when everything else works.
- **Google sign-in and Calendar import** need `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Without them the web app hides both buttons and the demo login works.
- **Location is not collected.** The re-plan loop works from check-ins and the clock; the `location_timeline` collection and its deletion endpoint are in place for when the team adds location sharing.
- **Leave-now browser notifications** need the traveller's permission, asked from the Me screen.

## Operations

- **The NGINX certificate is self-signed** for local use. Deploy with a real certificate.
- **The k6 load test** runs on demand (`Load test` workflow) with a raised per-user rate limit, because all virtual users share the demo account.
- **A manual NVDA screen-reader check** is required by the brief and isn't automated.
