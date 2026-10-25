# Known limits

Honest gaps in this build. Each is a deliberate scope choice or waits on the team.

## Data

- **Live tracking runs only while Reroute is open** (on screen or in the background): browsers don't allow it once the phone locks. Arrival and "nearly there" come from the phone's GPS, so indoors or in a metro they may be late or missing; the timeline and alerts still follow the clock.
- **Without an Azure key, natural voices use Microsoft Edge's online read-aloud service** through the edge-tts library, which isn't an official, documented API: it could change or stop. With `AZURE_SPEECH_KEY` set, Azure AI Speech, Microsoft's official service, reads the lines; its free tier allows 20 requests a minute and 0.5 million characters a month, and past those Edge's service reads them. Azure's word timings come over the WebSocket its Speech SDK uses (its REST API sends none), which Microsoft doesn't document for direct use. The phone's own voice takes over when neither answers.
- **Roads come from FOSSGIS's public routing servers**, which allow light use: one request a second, cached 30 days, at most 5,000 a day (`ROUTING_DAILY_LIMIT`).
  - While they're busy or down, a leg is drawn straight and dashed, marked approximate, and redrawn when they answer.
  - A metro ride is drawn station to station, not along the track's curves.
  - A shared auto with no recorded path follows the roads through its stands.
  - A walk to or from a station longer than 1.5 km is approximate unless the leg says how.
  - The turn-by-turn steps are OpenStreetMap's: an unnamed lane reads just "Turn left".
- **Bengaluru travel times are sample values** (`examples/bengaluru/travel-times.json`), from the project brief. For a place the file doesn't know (any place found by search, and KSR Bengaluru), Reroute plans a cab, and a walk when it's under 1.5 km, from the straight-line distance: roads at 1.3 times the line, cabs at 18 km/h plus 5 minutes' pickup, walking at 4.5 km/h, fares from the cab fare table. These legs are marked "Rough estimate" everywhere. Real road times need OSRM (`TRAVEL_TIMES_SOURCE=osrm`, `docker compose --profile routing up`). Gaps between places the file does know stay gaps, so the demo day plans exactly as the golden test says.
- **No live traffic.** Rico's "the roads are usually busy" check-ins come from typical traffic by city, hour and weekday (`TRAFFIC_SOURCE=usual`): rounded guesses, not measurements or a feed. A jam, rain, a festival, a holiday or a match isn't known, and a quiet evening still gets the check-in. They're guidance: the plan's times don't change until the traveller asks. The extra goes on top of the plan's time however it was worked out, so at the peaks a rough estimate (already at a city-average 18 km/h) may be counted slow twice. `TRAFFIC_SOURCE=off` turns them off.
- **The metro timetable** isn't supplied yet. `examples/bengaluru/metro.json` holds the lines and their stations, from OpenStreetMap (ODbL), for drawing rides. With OSRM on, metro legs appear only once timetables (`stations` and `rides`) are added.
- **The campus trip and its 20 to 30 real Raasta routes** wait on the team's mapping.
- **Sample Raasta routes** other than Koramangala–Jayanagar exist only to show the unverified, stale and e-rickshaw states.
- **A city's area is a box, not its outline:** OpenStreetMap's outline with a margin, at least about 22 km either side of the centre and at most about 66 km. A neighbouring town inside the box counts as part of the city, and the far edge of a sprawling one can fall outside. The list's areas were looked up once, in October 2026 (`examples/india-cities.json`); after adding a city to `backend/app/india.py`, run `infra/cities/from_osm.py` again. Nominatim finds only Thrissur's district, so Thrissur's centre was placed by hand.
- **India's bounding box is a box too,** so a point just over a border passes that check; a place must still be inside the city being planned.

## Features

- **Places of your own can't be edited.** Their name, kind, note and sharing are set when they're added: to change one, delete it and add it again. A traveller keeps up to 200 and adds up to 50 a day.
- **On a phone, press and hold a leg's map** (open a leg from Today) to add a place: Today's own maps on a phone are small previews. Desktop's Today map takes it too, and "Not here? Add it as your own place" works wherever you search for a place. There's no screen listing your places: they're on the maps and first in place search, and each pin's sheet deletes it.

- **The AI helper** ("Describe your day") is off by default, as the brief says; set `AI_HELPER_ENABLED=true` to turn it on. With `GEMINI_API_KEY` set (a free key from Google AI Studio) it asks Gemini to read the description. Without a key, or once the free tier's per-minute or daily quota is used up, it falls back to a pattern-based parser that handles common day descriptions. A fixed time it can't read as a real "HH:MM" is dropped, and the traveller sets it.
- **Rico's live voice is like Ana, not Ana.** It's a grown-up Google voice raised on the phone, so a careful ear may hear a slight processed edge, and it isn't quite the voice his alerts use. `ROO_LIVE_PITCH=0` plays Google's voice as it comes.
- **Talking with Rico out loud** needs the AI helper and a Gemini key, and uses Google's realtime audio model (`ROO_LIVE_MODEL`, Gemini 3.8 Live). Google ends a session after 15 minutes, and free-tier keys allow only a few at once. Rico's planner (`ask_reroute`) answers at the agent's speed, a few seconds.
- **Rico's agent** needs the AI helper and a Gemini key. Gemini's free tier allows only so many requests a minute and a day; `gemini-3.5-flash` allows just 20 a day, which is why Rico uses Flash-Lite. When a model's quota runs out, Rico rests it until Gemini says to try again and uses `GEMINI_MODEL`; when both are out, the phone answers by itself. The agent books cabs and entry tickets but not trains or flights: for those it opens the sheet. It changes only the trip on screen, or a new trip it starts on the same card.
- **Rico as a local guide reads free public sources, which may be slow or busy.** The public Overpass server often is (from some networks it doesn't answer at all); then Rico has no nearby places to offer and says so, and tries again after a minute. Wikivoyage's guides vary: a big city's lists its places in district guides (Rico reads up to 8), and a small town may have none. OpenStreetMap's names can be in the local script. Wikimedia asks callers for contact details in the User-Agent; `Reroute/1.0 (travel planner)` has none yet.
- **Web look-ups** need the AI helper and a Gemini key, and spend Google Search's own quota (at most 3 a message). Google's terms for answers grounded in Google Search ask apps to show its search suggestions with them; the app doesn't yet.
- **Entry tickets are a demo** (SightPass, invented): any place can be ticketed, and fares are made up. Only Rico books them: the app shows them in the trip's bookings, with Cancel, but has no sheet of its own to book one.
- **The guide needs Rico's agent** (the AI helper and a Gemini key): without it the glasses button and Me's switch don't show.
- **Rico moves only where it's drawn live.** With reduced motion, Save-Data or a GPU the browser calls slow, Rico is a still of the 3D Rico in its mood: it doesn't breathe, follow the pointer, or move its mouth as it speaks. Its stills are made once from the 3D engine (`frontend/roo3d/stills.mjs`), so after the Blender pieces are rendered again, run that too.
- **Morning planning** plans a later trip day on its own from 06:00 local time (`MORNING_PLAN_FROM_MIN`), from the place of stay, but only for a trip the traveller has planned before and only for a day with tasks and no plan yet. It runs once per trip day; if it fails (for example when a fixed time can't be kept) it tries again after 30 minutes, and the traveller can always plan the day themselves, which shows the reason. The scheduler looks at trips running around the server's real date, so a trip on the demo clock is planned in the morning only when its dates are around today; the demo trip (October 2026 sample dates) is planned with "Plan my day" as before.
- **Bookings are a demo.** Train tickets and cab rides are simulated: sample trains, invented drivers, nothing booked or charged. They exist while `SIMULATED_SERVICES` is on (the default; off in production: 404, and `features.bookings` is false), are paid from a wallet of simulated money, and keep passenger names and ages with the trip.
- **Google sign-in and Calendar import** need `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Without them the web app hides both buttons and the demo login works.
- **Location is not collected.** The re-plan loop works from check-ins and the clock; the `location_timeline` collection and its deletion endpoint are in place for when the team adds location sharing.
- **Leave-now browser notifications** need the traveller's permission, asked from the Me screen.

## The Android app

- **Beyond parity, only push and "Hey Rico" so far.** No location with the screen off, no links that open in the app, and no Play Store listing yet. Those wait for the owner's go-ahead.
- **"Hey Rico" is a small model listening for a few phrases.** Said clearly, "hey Rico", "hi Rico" and "okay Rico" wake him; a noisy street, a soft voice or another phrasing can miss him, and on the emulator's test clips a sound-alike ("hey Ricky", "hey Nico") never woke him. It hears English only.
- **Rico pops up over other apps only with "Display over other apps" allowed** for Reroute (Me sends you there), and not over the lock screen: a locked phone gets the "I'm here! Tap to talk." notification. Some phone makers add their own pop-up controls that can stop it too. He talks in Reroute, full screen, not in a little panel over the other app.
- **After the phone restarts, open Reroute once** to have Rico listen in the background again. Some phones' battery savers also stop a background microphone they think is idle; the "Rico is listening" notification goes when they do. So does Rico's ear if the speech library ever aborts (it's in a process of its own, so Reroute carries on): opening Reroute starts it again.
- **The APK is about 51 MB**, 40 of it the speech library for four kinds of processor. An app bundle on the Play Store sends each phone only its own, about 10 MB.
- **Push needs Firebase set up** (README, "Push notifications"). Without it, alerts come over the live stream only, and Android 15 and later cut an app's network a few seconds after it leaves the screen, then freeze it once other apps are in use (on the Android 17 emulator: no network after about 5 seconds, frozen about 15 seconds after two other apps). An alert sent after that waits until Reroute is opened again, where Today shows when to leave.
- **Only leave-by alerts, the morning plan and Rico's check-ins are pushed.** "Nearly there", "arrived" and "a task ends soon" come from the phone itself while Reroute runs, as on the web.
- **The at-time alert can sound twice** when Reroute is in the background but not yet frozen: the phone raises its own ("Time to leave for …") at the leave-by time, and the server's "Leave now" can come up to five minutes later, with other words. A copy within two minutes takes the first one's place quietly.
- **A phone signed out with no signal can still get that account's pushes**, shown as notifications while Reroute is in the background, until the phone has a signal again while Reroute is running (it then drops its Firebase token, and the server forgets the phone at the next push), someone signs in on it (the phone moves to them), or that sign-in expires. A token Firebase replaces while Reroute isn't opened gets no pushes until the app next opens.
- **Android only.** Capacitor could build an iPhone app from the same code; it isn't set up.
- **Release builds aren't signed yet.** A release needs an upload key and, for the Play Store, a Google Play developer account. Google sign-in in a release needs that key's SHA-1 on the Android OAuth client too (and the Play App Signing key's, once on the Play Store).
- **The API address is built in.** Each build calls the address in `frontend/.env.android`; pointing the app at another server means building it again.
- **Debug builds accept the local stack's self-signed certificate** for loopback and private-network addresses (the emulator's 10.0.2.2, a PC on the Wi-Fi). Release builds accept no bad certificate.
- **Talking to Rico needs Android's speech recognizer** (Google's app on most phones). On an emulator or a phone without it, the microphone button says the phone can't listen.
- **The phone's own voice depends on the phone's text-to-speech.** With no Indian English voice installed, another English voice reads.
- **The expense slip is saved to Documents/Reroute** on Android 11 and later. On Android 10 and older the share sheet opens instead, to save it to Files or Drive.
- **The icon and splash are the web app's mark,** not Rico, until the extras.

## API gaps the web app works around

- **A trip's city, dates and place of stay can't be edited** after creation (no `PATCH /v1/trips/:id`); the Plan screen shows them read-only.
- **A share link's token is shown once** (only its hash is stored). After a reload the app can't show the link again without creating a new one.
- **Raasta has no "my contributions" list or contributor names**, so the Raasta tab doesn't list your own routes and the moderator queue shows a short rider ID.
- **Nearby stands don't carry their route IDs**, so tapping one fills the search instead of opening a route.
- **Written directions are generated in the app** from leg segments and route stands; the API has no directions field.
- **Raasta route options carry no ride minutes**, only fare, frequency and walking time.

## Operations

- **The NGINX certificate is self-signed** for local use, so browsers won't install the offline service worker until you trust it (mkcert works). Deploy with a real certificate.
- **Locally, everything listens on 127.0.0.1.** Set `BIND_ADDR=0.0.0.0` to open the app to other devices (a phone on the same Wi-Fi), or deploy with `docker-compose.prod.yml`, which listens on all addresses and refuses to start without real secrets.
- **Reroute and Raasta share one JWT secret (HS256)** so Raasta can verify Reroute's access tokens. A per-service key pair, so Raasta could verify without being able to sign, is a recorded follow-up.
- **When Raasta is busy or down**, Reroute plans with the last answer it got about each route (kept 24 hours) and waits out Raasta's `Retry-After`. After a day without an answer, Raasta's routes count as unverified until it's back.
- **The k6 load test** runs on demand (`Load test` workflow) with a raised per-user rate limit, because all virtual users share the demo account.
- **A manual NVDA screen-reader check** is required by the brief and isn't automated.
