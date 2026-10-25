# Data and privacy

What Reroute keeps, why, for how long, who else sees what, and how to delete it, in line with India's Digital Personal Data Protection Act, 2023.

## What we keep

| Data | Where | Why | How long |
|---|---|---|---|
| Name, email, Google subject ID, role; for an email account, a salted scrypt hash of the password (never the password) | PostgreSQL `users` | Sign-in and roles | Until the account is deleted |
| Wallet entries: each top-up, booking and refund, with its amount and label (simulated money; no card or bank is involved) | PostgreSQL `wallet_entries` | The wallet that pays for simulated bookings (only with the demo login) | Until the account is deleted; a demo reset resets the demo wallet |
| Refresh tokens (hashed) | PostgreSQL `refresh_tokens` | Keeping you signed in | 30 days; rotated on every use |
| Trips, tasks, places you chose | PostgreSQL | Planning your day | Until you delete the trip |
| Places you added: the name, kind, your note, the pin, whether you shared it and a moderator's decision | PostgreSQL `places` | Finding them again, planning with them, and showing the ones you share | Until you delete one or your account; one a trip still goes to stays with that trip, without its note, until nothing goes there |
| Plan versions with their inputs and reason codes | PostgreSQL `plans`, `plan_legs` | Explaining and replaying every change | With the trip |
| Check-ins (done, skipped, delay) | PostgreSQL `checkins` | Following the day | With the trip |
| Reroute log | PostgreSQL `reroute_log` | Showing what Reroute changed, with Undo | With the trip |
| Share links (hashed tokens) | PostgreSQL `share_links` | Family view | Expire when the trip ends; revocable any time |
| Simulated bookings: passenger names and ages for a train ticket or a flight, the ride for a cab, the sight and how many are going for entry tickets | PostgreSQL `bookings` | The booking demo (only with the demo login; nothing real is booked) | With the trip; a demo reset deletes them |
| Location timeline, during active trips only | MongoDB `location_timeline` | Optional; the loop works without it. **Not collected in this build** | Planned: 30 days after the trip (TTL index), or sooner on request |
| Recorded Raasta rides, trimmed | MongoDB `gps_rides` | Building shared-auto routes | Kept with the route; first and last 200 m never stored |
| Rate-limit counters, idempotency keys, live state, reported delays | Redis | Safety and live updates | 1 minute to 36 hours |
| Place searches and their results | Redis | Fewer calls to OpenStreetMap | 24 hours |
| Road shapes of legs (the two stops' coordinates and the path) | Redis | Drawing legs on the map | 30 days |
| Read-aloud clips (the alert text and its audio) | Redis | Not asking for the same clip twice | 7 days |
| Rico's guide: city guides, places near an area (about a kilometre across), and web answers (kept under a hash of the question) | Redis | Not asking Wikivoyage, OpenStreetMap or Google the same twice | 7 days, a day, an hour |
| Request logs: method, path, status, time taken, trace ID | NGINX and API logs | Running and debugging the service | As long as the server keeps its logs |

Request logs never hold a query string (where place searches and read-aloud text travel) or a share link's token: both NGINX and the API mask `/shared/<token>` as `/shared/***`.

## What we never collect

Payment details, passwords, government ID numbers, contacts, or location outside an active trip.

## Other services that see some of your data

Reroute uses free public services. Each sees only what it needs, and none gets your name or email:

| Service | What it receives | When |
|---|---|---|
| Microsoft Azure AI Speech | The text of an alert or a chat reply Rico reads out, such as "Time to leave for the bank" (Rico reads its chat replies by default; the speaker button or Me turns it off) | Only with natural voices on (`TTS_ENABLED`) and an Azure key set on the server (`AZURE_SPEECH_KEY`); otherwise your phone's own voice reads it and nothing is sent |
| Microsoft Edge's read-aloud service (through the edge-tts library) | The same text | Only with natural voices on, when no Azure key is set or Azure doesn't answer |
| Your browser's speech service (Google's, in Chrome) | The sound of the one sentence you say to Rico; Reroute never receives or keeps the recording, only the words your browser hands back, and those stay on your phone | Only while Rico shows "Listening", after you tap "Talk to Rico". The microphone goes off when you finish the sentence, after 8 seconds of silence, or when you close Rico |
| OpenStreetMap Nominatim | The text you type in place search, and the city | When you search for a place Reroute doesn't already know |
| OpenFreeMap (map tiles) | Which map tiles your phone loads, so the area you look at, including around your position while "Follow me" is on | Whenever the map is shown; your phone fetches the tiles directly |
| FOSSGIS routing servers (routing.openstreetmap.de) | The coordinates of a leg's stops, and of the metro stations and shared-auto stands it passes (never your live position) | When the worker draws a plan's legs along the roads (cached 30 days), and once per plan in a city without sample data, for road distances |
| Google Maps | Your starting point and the leg's destination | Only when you tap **Open in Google Maps**; Google's own privacy policy applies there |
| Raasta (Reroute's own route service) | The coordinates of a leg's two stops | When the worker plans a day |
| Google | The sign-in code; the Calendar code if you import appointments | Only when you use Google sign-in or Calendar import |
| Google Gemini | The text you type in "Describe your day"; and a message to Rico that the phone couldn't understand by itself, with the last few messages and your trip's task titles, areas, times and today's plan. With Rico's agent, also what it looks up to answer: place names and areas, ride options and fares, your bookings and wallet balance, and what it read in a city's guide. Never your name, email or location | Only if the AI helper is turned on (off by default). Rico answers most messages on the phone, sending nothing |
| Google Search, through Gemini | The question Rico asks the web, such as "When is Lalbagh Botanical Garden open?" (Rico is told never to put your name or where you stay in it) | Only with the AI helper and a Gemini key, when Rico looks something up (at most 3 a message) |
| Wikivoyage (the Wikimedia Foundation) | The name of the city (or the place) Rico reads a guide for | Only with Rico's agent, when it reads a city's guide |
| OpenStreetMap's Overpass server | The area Rico looks around: a point rounded to about a kilometre, never the exact place you stay or your position | Only with Rico's agent, when it looks for places to see, eat or do |

## Live location on the map

"Show me on the map" (Me, or tapping "I've left") follows the phone's location while Reroute is open, to draw the blue dot, measure the distance left and say when you're nearly there. **The position stays on the phone:** it is never sent to Reroute's servers or stored. Browsers stop following when the phone locks or the app is closed. Turn it off in Me at any time. The map tiles around you are still loaded from OpenFreeMap, which can tell the area you're looking at (see above).

Roads for the map and the directions come from FOSSGIS's routing servers through Reroute's worker. Only the coordinates of a leg's stops, and of the stations and stands it passes, are sent (never your live position), and answers are cached for 30 days. **Turn by turn** follows your position on the phone only: the instructions are worked out on the phone, and spoken turns use the phone's own voice, so no street name ever goes to a server with where you are.

## The Android app

The Android app is the same web app inside Android, so everything above applies to it. What differs:

- **Staying signed in.** The browser keeps the refresh token in a cookie it never shows the page; the app keeps it in the Android Keystore, encrypted with a key that never leaves the phone, and sends it only to Reroute's API. It never goes to the phone's log. Signing out deletes it from the phone and ends the session on the server.
- **What stays on the phone.** The saved plan, check-ins waiting to sync and your settings are kept in the app's own storage, as a browser keeps them for the site. Android's backup is turned off for the app, so none of it is copied to Google Drive or a new phone.
- **Permissions, each asked the first time it's needed:** location for "Show me on the map" and turn by turn, only while Reroute is open (the position stays on the phone, as on the web); the microphone for talking to Rico; notifications for leave-by alerts (Android 13 and later). Say no and the rest of the app works.
- **Talking to Rico** uses Android's speech recognizer instead of the browser's. On most phones that is Google's speech service, which hears the one sentence you say, as Chrome's does; Reroute receives only the words.
- **The phone's own voice** is Android's text-to-speech (usually Google's, on the phone).
- **Google sign-in** goes through Android's own Google account picker; the server receives the same one-time code as from the web.
- **"Hey Rico"**, only with Me → "Hey Rico" on: the phone listens for Rico's name with a speech model that runs on the phone, downloaded once from Alpha Cephei's site (alphacephei.com, the makers of Vosk; the download asks for the file and sends nothing else). What the microphone hears is never recorded, kept or sent anywhere. Hearing "hey Rico" opens the voice screen, and from then on it's as "Talking with Rico out loud" says. With "Even when Reroute is closed" on, a notification shows the whole time it listens; with it off, it listens only while Reroute is on screen. Turning "Hey Rico" off stops the microphone at once.
- **Popping up over other apps** (Me → Pop up over other apps, with Android's "Display over other apps" allowed) shows Rico's card over the app on screen when he's called, and nothing else: Reroute doesn't see or read what's in other apps.
- **Push notifications**, only with Me → Phone notifications on: Reroute's server keeps the phone's Firebase token (an app-install identifier, no location) to send leave-by alerts, the morning plan and Rico's check-ins. The words of each alert ("Leave in 9 min. Metro, then shared auto.") pass through Google's Firebase Cloud Messaging, and with a check-in the leg's leave-by time, its mode and how much earlier to leave. The phone gets a Firebase token only once notifications are turned on. Turning them off or signing out deletes the token from the server; so does the theft check ending the sign-in that registered it, that sign-in expiring (within the hour), and Firebase reporting the app uninstalled (at the next push).

## Places you add

A place you add (press and hold a map, or "Add it as your own place" in place search) is personal data: what you call it, where it is and your note can say a lot about you.

- **Only you see it** unless you turn on "Share with everyone". Nobody else finds it in search or on a map, and nobody else's trip can use it, even with its ID.
- **Sharing asks a moderator first.** A moderator sees its name, kind, city, area and pin, and who added it only as an account ID: never your name, email or note. Once they approve it, every traveller can find its name, kind, area and pin, never your note or who added it. Until then, and if they say no (you see why), it stays yours alone.
- **Your note is yours alone**, shared or not, moderators included.
- **Nothing is sent anywhere else:** adding a place asks no outside service. The map you place the pin on loads its tiles from OpenFreeMap, as every map does.

## Family view

A share link shows stops and progress. It never shows coordinates or your exact location. Links are 128 random bits, stored only as a hash, expire when the trip ends, and stop working the moment you revoke them. Server logs show the link as `/shared/***`.

## Deleting your data

- **Location history:** Me → Delete my location history (`DELETE /v1/me/location-history`). It's removed at once.
- **Share links:** Share → Stop sharing (`DELETE /v1/share-links/:id`).
- **Places you added:** tap the place's pin on a map → Delete this place (`DELETE /v1/me/places/:id`). It's gone at once, unless a task or a stay of a trip still goes there: that trip keeps it until nothing goes there, but its note goes at once and it leaves search, the map and your places. A plan made before then names it "A deleted place".
- **Bookings:** cancelling keeps the (simulated) record with the trip; resetting the demo trip deletes it.
- **Everything else:** ask the team; account deletion removes your trips, tasks, plans, check-ins, bookings and the places you added (cascade). A shared place other travellers' trips go to stays for those trips, without your note or any link to you. Redis copies expire on their own (at most 30 days).

## Estimates

Every travel time and fare is an estimate and the app says so. A rerouted plan never claims anything was booked.

## Optional AI helper

Off by default (`AI_HELPER_ENABLED=false`). If turned on, only the text you type goes to the provider: no name, email or location.

Talking to Rico works without it: Rico reads common requests (running late, move, skip, change a time or a length, plan again, undo, what's next) on the phone. With the helper on, a message the phone can't place goes to Gemini with the day it needs to answer, and Gemini's answer is only an offer: the server checks it against your trip, and the app asks you before changing anything. With a Gemini key, Rico's agent can also read your trip, rides and wallet through Reroute's own API, signed in as you, and put several changes on one card. Nothing changes until you tap Do all, and Undo takes it back. As a local guide, it reads Wikivoyage and OpenStreetMap and asks Google Search, sending only a city's name, an area about a kilometre across, or its question (see the table above). The chat itself is kept in your browser for the session only.

### Talking with Rico out loud

Only while the voice screen is open (the Talk button): what the microphone hears goes straight from the phone to Google's Gemini Live, which turns it into words and answers in Rico's voice. Google also gets the day in words (the same as the chat sends) when the session starts. Reroute's server never receives or keeps the audio; the captions live on the screen only. Closing the screen turns the microphone off.

## Connected services and the wallet

The partners in **Me > Connected services** (RideNow, AutoGo, ZipBike, RailGo, SkyHop) are invented and simulated. Connecting one only flips a switch on your phone: nothing is sent to anyone, and no real account is linked. The wallet holds simulated money: adding money charges no card or bank, and bookings paid from it book nothing real.
