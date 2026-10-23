# Data and privacy

What Reroute keeps, why, for how long, who else sees what, and how to delete it, in line with India's Digital Personal Data Protection Act, 2023.

## What we keep

| Data | Where | Why | How long |
|---|---|---|---|
| Name, email, Google subject ID, role; for an email account, a salted scrypt hash of the password (never the password) | PostgreSQL `users` | Sign-in and roles | Until the account is deleted |
| Wallet entries: each top-up, booking and refund, with its amount and label (simulated money; no card or bank is involved) | PostgreSQL `wallet_entries` | The wallet that pays for simulated bookings (only with the demo login) | Until the account is deleted; a demo reset resets the demo wallet |
| Refresh tokens (hashed) | PostgreSQL `refresh_tokens` | Keeping you signed in | 30 days; rotated on every use |
| Trips, tasks, places you chose | PostgreSQL | Planning your day | Until you delete the trip |
| Plan versions with their inputs and reason codes | PostgreSQL `plans`, `plan_legs` | Explaining and replaying every change | With the trip |
| Check-ins (done, skipped, delay) | PostgreSQL `checkins` | Following the day | With the trip |
| Reroute log | PostgreSQL `reroute_log` | Showing what Reroute changed, with Undo | With the trip |
| Share links (hashed tokens) | PostgreSQL `share_links` | Family view | Expire when the trip ends; revocable any time |
| Simulated bookings: passenger names and ages for a train ticket or a flight, the ride for a cab | PostgreSQL `bookings` | The booking demo (only with the demo login; nothing real is booked) | With the trip; a demo reset deletes them |
| Location timeline, during active trips only | MongoDB `location_timeline` | Optional; the loop works without it. **Not collected in this build** | Planned: 30 days after the trip (TTL index), or sooner on request |
| Recorded Raasta rides, trimmed | MongoDB `gps_rides` | Building shared-auto routes | Kept with the route; first and last 200 m never stored |
| Rate-limit counters, idempotency keys, live state, reported delays | Redis | Safety and live updates | 1 minute to 36 hours |
| Place searches and their results | Redis | Fewer calls to OpenStreetMap | 24 hours |
| Road shapes of legs (the two stops' coordinates and the path) | Redis | Drawing legs on the map | 30 days |
| Read-aloud clips (the alert text and its audio) | Redis | Not asking for the same clip twice | 7 days |
| Request logs: method, path, status, time taken, trace ID | NGINX and API logs | Running and debugging the service | As long as the server keeps its logs |

Request logs never hold a query string (where place searches and read-aloud text travel) or a share link's token: both NGINX and the API mask `/shared/<token>` as `/shared/***`.

## What we never collect

Payment details, passwords, government ID numbers, contacts, or location outside an active trip.

## Other services that see some of your data

Reroute uses free public services. Each sees only what it needs, and none gets your name or email:

| Service | What it receives | When |
|---|---|---|
| Microsoft Edge's read-aloud service (through the edge-tts library) | The text of an alert or a chat reply Rico reads out, such as "Time to leave for the bank" (Rico reads its chat replies by default; the speaker button or Me turns it off) | Only with natural voices on (`TTS_ENABLED`); otherwise your phone's own voice reads it and nothing is sent |
| Your browser's speech service (Google's, in Chrome) | The sound of the one sentence you say to Rico; Reroute never receives or keeps the recording, only the words your browser hands back, and those stay on your phone | Only while Rico shows "Listening", after you tap "Talk to Rico". The microphone goes off when you finish the sentence, after 8 seconds of silence, or when you close Rico |
| OpenStreetMap Nominatim | The text you type in place search, and the city | When you search for a place Reroute doesn't already know |
| OpenFreeMap (map tiles) | Which map tiles your phone loads, so the area you look at, including around your position while "Follow me" is on | Whenever the map is shown; your phone fetches the tiles directly |
| Public OSRM server | The coordinates of a leg's two stops (never your live position) | When the map draws a leg along the roads (cached 30 days) |
| Raasta (Reroute's own route service) | The coordinates of a leg's two stops | When the worker plans a day |
| Google | The sign-in code; the Calendar code if you import appointments | Only when you use Google sign-in or Calendar import |
| Google Gemini | The text you type in "Describe your day"; and a message to Rico that the phone couldn't understand by itself, with the last few messages and your trip's task titles, areas, times and today's plan (never your name, email or location) | Only if the AI helper is turned on (off by default). Rico answers most messages on the phone, sending nothing |

## Live location on the map

"Show me on the map" (Me, or tapping "I've left") follows the phone's location while Reroute is open, to draw the blue dot, measure the distance left and say when you're nearly there. **The position stays on the phone:** it is never sent to Reroute's servers or stored. Browsers stop following when the phone locks or the app is closed. Turn it off in Me at any time. The map tiles around you are still loaded from OpenFreeMap, which can tell the area you're looking at (see above).

Road shapes for the map come from the public OSRM server through Reroute's API: only the coordinates of the two stops of a leg are sent (never your live position), and answers are cached for 30 days.

## Family view

A share link shows stops and progress. It never shows coordinates or your exact location. Links are 128 random bits, stored only as a hash, expire when the trip ends, and stop working the moment you revoke them. Server logs show the link as `/shared/***`.

## Deleting your data

- **Location history:** Me → Delete my location history (`DELETE /v1/me/location-history`). It's removed at once.
- **Share links:** Share → Stop sharing (`DELETE /v1/share-links/:id`).
- **Bookings:** cancelling keeps the (simulated) record with the trip; resetting the demo trip deletes it.
- **Everything else:** ask the team; account deletion removes your trips, tasks, plans, check-ins and bookings (cascade). Redis copies expire on their own (at most 30 days).

## Estimates

Every travel time and fare is an estimate and the app says so. A rerouted plan never claims anything was booked.

## Optional AI helper

Off by default (`AI_HELPER_ENABLED=false`). If turned on, only the text you type goes to the provider: no name, email or location.

Talking to Rico works without it: Rico reads common requests (running late, move, skip, change a time or a length, plan again, undo, what's next) on the phone. With the helper on, a message the phone can't place goes to Gemini with the day it needs to answer, and Gemini's answer is only an offer: the server checks it against your trip, and the app asks you before changing anything. The chat itself is kept in your browser for the session only.

## Connected services and the wallet

The partners in **Me > Connected services** (RideNow, AutoGo, ZipBike, RailGo, SkyHop) are invented and simulated. Connecting one only flips a switch on your phone: nothing is sent to anyone, and no real account is linked. The wallet holds simulated money: adding money charges no card or bank, and bookings paid from it book nothing real.
