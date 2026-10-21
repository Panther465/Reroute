# Known limits

Honest gaps in this build. Each is a deliberate scope choice or waits on the team.

## Data

- **Live tracking runs only while Reroute is open** (on screen or in the background): browsers don't allow it once the phone locks. Arrival and "nearly there" come from the phone's GPS, so indoors or in a metro they may be late or missing; the timeline and alerts still follow the clock.
- **Natural voices use Microsoft Edge's online read-aloud service** through the edge-tts library, which isn't an official, documented API: it could change or stop. The phone's own voice takes over when it does.
- **Map roads come from the public OSRM demo server** (light use, cached 30 days). If it's down, legs are drawn as curves between their stops. Metro legs are drawn along roads too, as an approximation.
- **Bengaluru travel times are sample values** (`examples/bengaluru/travel-times.json`), from the project brief. For a place the file doesn't know (any place found by search, and KSR Bengaluru), Reroute plans a cab, and a walk when it's under 1.5 km, from the straight-line distance: roads at 1.3 times the line, cabs at 18 km/h plus 5 minutes' pickup, walking at 4.5 km/h, fares from the cab fare table. These legs are marked "Rough estimate" everywhere. Real road times need OSRM (`TRAVEL_TIMES_SOURCE=osrm`, `docker compose --profile routing up`). Gaps between places the file does know stay gaps, so the demo day plans exactly as the golden test says.
- **The metro timetable file** (`examples/<city>/metro.json`) isn't supplied yet; with OSRM on, metro legs appear only once it exists.
- **The campus trip and its 20 to 30 real Raasta routes** wait on the team's mapping.
- **Sample Raasta routes** other than Koramangala–Jayanagar exist only to show the unverified, stale and e-rickshaw states.

## Features

- **The AI helper** ("Describe your day") is enabled by default. With `GEMINI_API_KEY` set (a free key from Google AI Studio) it asks Gemini to read the description. Without a key, or once the free tier's per-minute or daily quota is used up, it falls back to a pattern-based parser that handles common day descriptions.
- **Google sign-in and Calendar import** need `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Without them the web app hides both buttons and the demo login works.
- **Location is not collected.** The re-plan loop works from check-ins and the clock; the `location_timeline` collection and its deletion endpoint are in place for when the team adds location sharing.
- **Leave-now browser notifications** need the traveller's permission, asked from the Me screen.

## API gaps the web app works around

- **A trip's city, dates and place of stay can't be edited** after creation (no `PATCH /v1/trips/:id`); the Plan screen shows them read-only.
- **A share link's token is shown once** (only its hash is stored). After a reload the app can't show the link again without creating a new one.
- **Raasta has no "my contributions" list or contributor names**, so the Raasta tab doesn't list your own routes and the moderator queue shows a short rider ID.
- **Nearby stands don't carry their route IDs**, so tapping one fills the search instead of opening a route.
- **Written directions are generated in the app** from leg segments and route stands; the API has no directions field.
- **Raasta route options carry no ride minutes**, only fare, frequency and walking time.

## Operations

- **The NGINX certificate is self-signed** for local use, so browsers won't install the offline service worker until you trust it (mkcert works). Deploy with a real certificate.
- **The k6 load test** runs on demand (`Load test` workflow) with a raised per-user rate limit, because all virtual users share the demo account.
- **A manual NVDA screen-reader check** is required by the brief and isn't automated.
