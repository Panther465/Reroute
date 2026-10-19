# Decisions

Details the briefs don't settle, the simplest choice that keeps every rule, and why. Newest last. Anything that changes scope, cost, a contract or the data model is marked **Needs team sign-off**.

## Sources of truth

1. **The project brief owns behaviour and data; the UI brief owns visuals.** The two disagree on the demo: the UI brief has Tuesday 14 October 2025, the bank at 12:30, a bus mode and the university office at priority 2. The project brief has Wednesday 14 October 2026, the bank at 12:25, no buses, tempo as a mode and priority 1. We follow the project brief everywhere, including the golden test.
2. **Sample data is labelled.** Every sample place, trip, route and travel time carries `sample: true` or sits in `examples/`, and user-facing names end in "(sample)" where a person is implied.

## Planner (rule version 1.0)

3. **Cost counts only the legs still ahead.** This reproduces the brief's numbers exactly (opt-1 = 159, opt-2 = 246, metro-then-cab = 166). Costs are kept as integers scaled by 10 so fares divided by 10 never round.
4. **The 10-minute arrival buffer before a fixed task is not waiting.** The traveller leaves later instead (the brief: "leave at the latest time that still meets the buffer"). Waiting is time stuck at a place before it opens, or at a stand before the first trip.
5. **The first leg from the place of stay leaves as late as the first task allows.** For a window task that means arriving at opening time, so the traveller doesn't wait at a closed door. The earliest departure of any day is 07:00 (`day_earliest_departure`).
6. **"Higher priority" as a tie-break** compares the visit order's priorities lexicographically (must-do tasks earlier wins), then task IDs, then leg option IDs, so equal-cost plans are always chosen the same way.
7. **Exact search pruning.** Branch and bound with an admissible lower bound (each unvisited task's cheapest incoming leg, or the 120 penalty if it may be left out, plus the cheapest leg home), seeded with the insertion heuristic's cost, plus a dominance check: a partial plan at the same place with the same tasks done is dropped when another is earlier and cheaper even after charging it the time difference as waiting. Brute-force tests prove the result is still the cheapest. Eight tasks take about 0.1 s.
8. **Tasks left out.** When first planning a day, a task that can't fit is "unplaced" and named with its reason; the rest of the day is still planned. In a re-plan a task is "moved" (to the next trip day at its opening time, or 10:00) or "skipped" (priority 3 only). Fixed tasks are never left out by the planner.
9. **Option kinds.** Faster mode: the cheapest plan that keeps every task, any mode. Move task: the cheapest plan without cabs that moves at least one task ("Keep it cheap"). Skip task: the cheapest plan that skips at least one priority 3 task. Options that duplicate another are dropped; at most three, cheapest first.
10. **`timeSavedMin`** is how much earlier the day ends than it would if everything were simply shifted and nothing closed (17:30 for the 40-minute demo, so the cab saves 30 min).
11. **`extraFareInr`** is the option's remaining fares minus the active plan's remaining fares, never below zero.

## Re-plan loop

12. **A check-in waits for the worker.** Section 13's example returns options in the check-in response, while section 6 forbids planning inside a request. The API saves the check-in, enqueues the re-plan and waits up to `CHECKIN_WAIT_SECONDS` (8 s) for the worker's result. If the worker is slower it answers 202 with `result: "pending"` and a `jobId`; the outcome also arrives as a live event.
13. **Where the traveller is** comes from check-ins and the clock: the current task is the first task in the active plan that isn't done or skipped and whose leg should already have left. Location is never needed.
14. **A done check-in may shift times earlier.** Finishing early is a shift like any other: same tasks, order and modes.
15. **A skip re-plans from scratch** (trigger `skipped`) because the traveller chose to drop the task; a task edit does the same with trigger `edited`.
16. **Plans carry the legs already travelled** as `doneLegs`, so every version shows the whole day and the summary needs only the active version. `legs` holds the remaining legs, as in the API example.
17. **Undo restores task membership too.** Activating a version moves tasks to match it: a task moved by the undone version comes back to its planned day. Done check-ins are facts and never change.

## API

18. **Auth routes are exempt from idempotency.** Replaying a sign-in or refresh would hand out stored credentials. Every other POST requires `idempotencyKey`; a test walks the OpenAPI file to enforce it.
19. **Idempotency keys are scoped to the caller** (the verified token's subject, or the IP when anonymous) and to the path.
20. **Added endpoints** (documented in the OpenAPI file and Postman): `GET /v1/places` (place search for the task form), `GET /v1/trips/:id/share-links`, `DELETE /v1/trips/:id/tasks/:taskId` (only for a task without check-ins, so the record stays complete), and three demo-only routes under `/v1/trips/:id/demo/` (`clock`, `check`, `reset`) that exist only with `DEMO_LOGIN=true`. **Needs team sign-off** (the brief asks before adding endpoints).
21. **Calendar import returns draft tasks and saves nothing.** Events without a time, or whose location doesn't match a known place, come back with `placeId: null` for the traveller to fix.
22. **Window times** (`opensAt`, `closesAt`) are local times of day (`"10:00"`), not full timestamps; fixed starts are full ISO 8601 with the offset.
23. **Live events need the access token in a header**, so the web app reads the stream with `fetch`, not `EventSource`.

## Data

24. **Exactly one active plan per trip** is a partial unique index; immutability is a trigger that rejects any change except `status`, `activated_at`, and a version set once.
25. **Database roles enforce the module boundary.** `reroute_app` owns `public` and has no rights on `raasta`; `raasta_app` owns only `raasta`.
26. **Raasta routes are directional.** The two-way Koramangala–Jayanagar corridor is seeded as two routes.
27. **If Raasta is unreachable**, its routes count as unverified, so they can only be labelled extras and the plan still works with metro, walking and cabs.
28. **The travel-time snapshot ID** includes a hash of the Raasta statuses and service hours it used, so replays stay exact.

## Raasta

29. **A route serves a leg** when its boarding stand comes before its alighting stand and each is within `WALK_RADIUS_M` (800 m) of the ends. Walking is estimated at 80 m/min and the expected wait at half the frequency, rounded up.
30. **`GET /routes` returns `rideDistanceM`**, not ride minutes: the Raasta route contract has no travel time, so travel minutes come from the travel-time snapshot (and OSRM when enabled).
31. **Before its first trip** a route is still listed and the planner's service-hours rule makes the traveller wait; only "after the last trip" leaves it out (`lastTripPassed`).
32. **A stale route goes back to verification** as a waiting `freshness_check` contribution in the moderator queue. Rejecting a new route or a freshness check removes the route.
33. **Taps within 30 m of an existing stand reuse it.** Without OSRM, route paths fall back to straight lines between stands, or to the trimmed ride points.
34. **GTFS** uses `route_type` 1501 (share taxi) and one frequency-based template trip per route; the calendar runs one year from the export date, which the request handler passes in, and the feed includes `feed_info.txt`.
35. **`/readyz` answers 500 `INTERNAL`** when a dependency is down, because the brief's error list has no 503. Raasta's Redis keys live in database 1.

## Infrastructure

36. **OSRM is an optional Compose profile.** The Bengaluru demo uses the sample snapshot (`TRAVEL_TIMES_SOURCE=sample`), so `docker compose up` works without preparing a map. `--profile routing` downloads and prepares the southern India extract for car and foot.
37. **Tests run jobs inline** (`QUEUE_SYNC=true`) on in-memory Redis; the setting is refused in production.

## Frontend

38. **The existing Figma Make app is the starting point.** It was ported to the real APIs; the client-side planner was removed so there is exactly one planner.
- **One planner.** The client-side planner from the prototype is gone; the web app renders the server's plan. `src/lib/timeline.ts` turns the trip into the timeline view model and is unit-tested against the golden plan.
- **The app's clock is the server's `now`**, never the device clock, so the demo clock drives every screen.
- **Where the traveller is, on screen:** a leg counts as being ridden between its leave-by and arrival times; "Check in" targets the current task, else the next one. "Start this leg" is local only.
- **Window tags read "Open till HH:MM"**: the API doesn't distinguish "open till" from "closes".
- **Offline:** the TanStack Query cache persists for 7 days, so the active plan renders after an offline reload. Check-ins made offline are queued with their idempotency keys and sent when the phone is back online; a 4xx answer drops one, a 5xx or no connection keeps it.
- **Live events are read with `fetch`** because `EventSource` can't send the access token.
- **Code splitting:** every screen except Today loads on demand; MapLibre alone is above the default chunk warning, so the limit is 1100 kB.
- **Animated elements** (UI brief motion rules, with reduced-motion versions): the sign-in hero is a 2-second, one-shot preview of the reroute choreography on the sample day; on Today, a mode-coloured marker sits on the leg being ridden at the share of the leg already travelled and moves only when the clock does.
- **Node.js 22 LTS, not 20.** The brief names Node.js 20 for work outside Docker, but Node 20 reached end of life in April 2026 and the current test toolchain (jsdom's HTTP client) needs Node 22. CI, the web image and `engines` all use 22.
- **The app's clock runs from when the server sent `now`**, not from page load, so a plan reopened offline hours later still knows the time. The trip says whether its clock is simulated (`clockSimulated`); the demo clock holds still where it was set. The trip is always confirmed with the server on load.
- **Host ports avoid local installs:** the stack publishes PostgreSQL, Redis and MongoDB on 55432, 56379 and 57017 and plain HTTP on 8080, all configurable, so it starts on machines that already run these databases.
