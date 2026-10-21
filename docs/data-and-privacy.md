# Data and privacy

What Reroute keeps, why, for how long, and how to delete it, in line with India's Digital Personal Data Protection Act, 2023.

## What we keep

| Data | Where | Why | How long |
|---|---|---|---|
| Name, email, Google subject ID, role | PostgreSQL `users` | Sign-in and roles | Until the account is deleted |
| Refresh tokens (hashed) | PostgreSQL `refresh_tokens` | Keeping you signed in | 30 days; rotated on every use |
| Trips, tasks, places you chose | PostgreSQL | Planning your day | Until you delete the trip |
| Plan versions with their inputs and reason codes | PostgreSQL `plans`, `plan_legs` | Explaining and replaying every change | With the trip |
| Check-ins (done, skipped, delay) | PostgreSQL `checkins` | Following the day | With the trip |
| Reroute log | PostgreSQL `reroute_log` | Showing what Reroute changed, with Undo | With the trip |
| Share links (hashed tokens) | PostgreSQL `share_links` | Family view | Expire when the trip ends; revocable any time |
| Location timeline, during active trips only | MongoDB `location_timeline` | Optional; the loop works without it. **Not collected in this build** | Planned: 30 days after the trip (TTL index), or sooner on request |
| Recorded Raasta rides, trimmed | MongoDB `gps_rides` | Building shared-auto routes | Kept with the route; first and last 200 m never stored |
| Rate-limit counters, idempotency keys, live state | Redis | Safety and live updates | 1 minute to 24 hours |

## What we never collect

Payment details, passwords, government ID numbers, contacts, or location outside an active trip.

## Live location on the map

"Show me on the map" (Me, or tapping "I've left") follows the phone's location while Reroute is open, to draw the blue dot, measure the distance left and say when you're nearly there. **The position stays on the phone:** it is never sent to Reroute's servers or stored. Browsers stop following when the phone locks or the app is closed. Turn it off in Me at any time.

Road shapes for the map come from the public OSRM server through Reroute's API: only the coordinates of the two stops of a leg are sent (never your live position), and answers are cached for 30 days.

## Family view

A share link shows stops and progress. It never shows coordinates or your exact location. Links are 128 random bits, stored only as a hash, expire when the trip ends, and stop working the moment you revoke them.

## Deleting your data

- **Location history:** Me → Delete my location history (`DELETE /v1/me/location-history`). It's removed at once.
- **Share links:** Share → Stop sharing (`DELETE /v1/share-links/:id`).
- **Everything else:** ask the team; account deletion removes your trips, tasks, plans and check-ins (cascade).

## Estimates

Every travel time and fare is an estimate and the app says so. A rerouted plan never claims anything was booked.

## Optional AI helper

Off by default (`AI_HELPER_ENABLED=false`). If turned on, only the text you type goes to the provider: no name, email or location.
