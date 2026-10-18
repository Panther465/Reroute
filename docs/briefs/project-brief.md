# Reroute: project brief for an AI coding agent

## 0. How to work on this project

You are a senior full-stack engineer joining a four-person student team. This brief explains what Reroute is, how it must behave and how it is built. It is the working source of truth; the team's formal PRD ("Reroute product requirements document", 15 October 2026) says the same things for reviewers. A second brief, "Reroute: UI build brief for an AI design and code agent", owns every visual decision: colours, type, layout, icons and motion. Follow it for anything a user sees.

Your first reply, before any code:
1. What we're building, in your own words, in under 150 words.
2. The two modules and how they talk to each other.
3. The five rules in this brief you think are easiest to break, and how you'll guard each one.
4. Your questions, if any.

How to work after that:
- Follow the build order in section 17, in small steps. A step is finished when its tests pass and the OpenAPI file, Postman collection and README match the code.
- When this brief doesn't cover a detail, choose the simplest option that keeps every rule here, write it down in `docs/decisions.md`, and carry on. Ask the team before changing scope, cost, a contract or the data model.
- Never invent features, prices, places, routes or endpoints that aren't here. Sample data is always labelled as sample.

## 1. What we're building

Reroute is a travel companion for work trips to an unfamiliar Indian city. The traveller enters their tasks once: a meeting at a fixed time, a bank that is open till 16:00, an office that closes at 17:00. Reroute plans the day: the order of tasks, when to leave, how to travel and what each leg costs. It then follows the day with the traveller. When they run late, it re-plans the rest of the day. If everything still fits, it shifts the times by itself and says so. If something must give, it changes nothing and offers 2 or 3 explained options.

Raasta, the second module, is a crowdsourced map of shared-auto, e-rickshaw and tempo routes: the stands, the fare, how often vehicles come and when the last one leaves. No app publishes these routes, although these vehicles carry about 25% of motorised trips in Indian cities. Reroute uses verified Raasta routes for local legs.

Tagline: "Running late? We'll reroute your day."

Everything serves one traceable chain: tasks → plan version 1 → check-in → delay found → options with reasons → chosen plan version 2 → updated timeline. Every plan version is saved with its inputs and reason codes, so any change can be explained and replayed.

## 2. Why it matters

Our project guide hit this problem on a work trip to Bengaluru: several tasks in one day, planned by hand across hotel, map and timing apps. Once he fell behind, nothing adjusted. Existing tools each cover one piece:
- Google Maps gives directions but doesn't know your appointments or office hours.
- TripIt organises bookings. Wanderlog and AI trip planners build tourist itineraries, and Wanderlog doesn't re-plan when you fall behind.
- MonkeyTravel shifts a leisure day only when you press its running-late control.
- No app publishes shared-auto routes.

## 3. Who uses it

| Person | How they get in | What they do |
|---|---|---|
| Traveller | Google sign-in, or the demo login locally | Creates trips, follows the day, checks in, reports delays, chooses options, shares the trip, reads the summary |
| Family member | A share link, no account | Watches one trip's progress, read-only |
| Raasta contributor | Any signed-in user | Adds routes by tapping stands or recording a ride, confirms routes, reports fares |
| Moderator | The moderator role | Approves, edits or rejects new routes and fare reports |
| Reviewer (our teacher) | The demo login | Changes a task or a delay and gets a different, explained plan without editing code |

Roles in code are traveller (the default), moderator and admin. A share link is not a role: it gives read-only access to one trip and nothing else.

## 4. Words we use

- **Trip:** a city, dates, a place of stay, and tasks.
- **Task:** something to do at a place for a duration. A fixed task starts at a set time (a meeting at 10:00). A window task must start and finish between opening and closing times (a bank open 10:00 to 16:00). Priority runs from 1 (must do) to 3 (nice to do).
- **Leg:** the journey to a task: its mode, leave-by time, arrival time, travel minutes and fare. A mixed leg has segments, such as "Metro, then shared auto".
- **Modes:** walk, metro, shared auto, e-rickshaw, tempo and cab. There is no bus data, so buses are left out.
- **Shared auto:** an auto-rickshaw that runs a fixed route between stands and carries several passengers at a fixed fare each. E-rickshaws and tempos work the same way.
- **Stand:** where shared autos stop and wait for passengers.
- **Check-in:** the traveller reports a task done, a task skipped, or a delay.
- **Behind schedule:** more than 5 minutes past a planned leave-by time, or a reported delay.
- **Plan version:** an immutable snapshot of the day's plan. Every change creates a new version.
- **Reason code:** a fixed code explaining a plan or option (section 8).
- **Shift only:** a re-plan that keeps every task, the order and the modes, and only moves times.
- **Transit adapter:** the only part of Reroute that asks Raasta and the metro timetable for public-transport options.
- **GTFS:** the standard open format for transit data, which Google Maps reads.

## 5. Scope

Build:
- the web app for travellers, family viewers, contributors and moderators, installable as a PWA;
- the planner, the re-planning loop and the worker that runs them;
- the Raasta module, with its own API and tables;
- both APIs, the database schemas and migrations, and seed data;
- tests, the Postman collection, and the documentation.

Use from outside: Google sign-in; Google Calendar, read-only, only when the traveller asks; OpenStreetMap data, with OSRM for road travel times and Nominatim for place search.

Don't build: hotel or ticket booking, payments, native Android or iOS apps, live traffic, GPS tracking while the phone is locked, a driver app, live auto tracking, or anything that needs a paid service.

Optional, and off by default: an AI helper that reads tasks typed in plain words (section 11).

## 6. Architecture

| Part | Choice |
|---|---|
| Frontend | React, Vite and TypeScript as an installable PWA; TanStack Query; React Router. Looks: the UI brief |
| Reroute API | Python 3.12, FastAPI, Pydantic v2; two copies behind NGINX |
| Raasta API | Python 3.12, FastAPI, Pydantic v2; a separate app with its own tables |
| Worker | Python worker on a Redis queue (RQ), plus a scheduler for the 5-minute checks |
| Relational data | PostgreSQL 16 with PostGIS, using SQLAlchemy 2, GeoAlchemy2 and Alembic migrations |
| Documents | MongoDB 7: raw GPS rides and the traveller's location timeline |
| Cache and live state | Redis 7: travel times, live trip state, rate limits, idempotency keys, jobs, and pub/sub for live events |
| Road routing | OSRM with OpenStreetMap data for each demo city (car and foot profiles), behind an adapter |
| Place search | Nominatim, cached, at most 1 request a second, behind an adapter |
| Metro | A static timetable file per city, behind an adapter |
| Sign-in | Google OAuth 2.0, then our own JWTs |
| Proxy | NGINX: HTTPS, one origin for the app and both APIs, load balancing, server-sent events |
| DevOps | Docker Compose (`docker compose up` starts everything), GitHub Actions |
| Tests | pytest, Postman with Newman, k6, Playwright with axe |

Local setup needs Git and Docker Desktop; Node.js 20 and Python 3.12 are needed only for work outside Docker. The first `docker compose up` prepares each city's OpenStreetMap extract for OSRM, which takes a few minutes.

How a request flows:
1. The phone calls NGINX. Paths under `/v1/raasta/` go to the Raasta API; other `/v1/` paths go to one of the two Reroute API copies; everything else serves the web app.
2. The Reroute API validates the request, saves it, and puts any planning work on the Redis queue. It never plans inside a request.
3. The worker gathers inputs, runs the planner, saves the new plan version and publishes an event on the trip's Redis channel.
4. Whichever API copy holds the traveller's live connection forwards the event to the phone as a server-sent event.

Boundaries that must hold:
- Raasta runs and demos on its own. Reroute reaches it only over HTTP, through the transit adapter, never through its tables.
- OSRM, Nominatim, the metro timetable and Google Calendar each sit behind an adapter interface, so any of them can be replaced without touching the planner.
- The planner is a pure function: inputs in, plan out. It reads no clock, network or database. The worker fetches everything first.
- No secret reaches the browser. Every setting comes from a variable documented in that app's `.env.example`.
- NGINX must not buffer the live stream (`proxy_buffering off` on that path).

## 7. Repository

```
reroute/
|-- backend/                 # Reroute API
|   |-- app/routes/          # trips, tasks, plans, check-ins, share links
|   |-- app/services/        # planner, re-planner, timeline, summary
|   |-- app/adapters/        # OSRM, Nominatim, metro timetable, Raasta, Google Calendar
|   |-- app/workers/         # plan jobs, 5-minute checks
|   `-- .env.example
|-- raasta/                  # Raasta API
|   |-- app/routes/          # stands, routes, contributions, moderation
|   |-- app/services/        # GPS cleaning, verification, GTFS export
|   `-- .env.example
|-- frontend/                # React app: traveller, family view, contributor, moderator
|-- shared/contracts/        # versioned task, plan and route schemas
|-- examples/                # Bengaluru demo trip, sample Raasta routes, travel times
|-- postman/                 # API collection with response examples
|-- docs/                    # API guide, data and privacy, known limits, decisions
|-- docker-compose.yml
`-- README.md
```

## 8. Contracts

The shapes below live in `shared/contracts/` as versioned JSON Schema generated from the Pydantic models. The frontend generates its TypeScript types from the OpenAPI file. Times are ISO 8601 with the city's offset (`2026-10-14T11:45:00+05:30`), money is whole rupees, and durations are whole minutes.

- **Task:** taskId, tripId, title, placeId, durationMin (5 to 720), either fixedStart or a window (opensAt, closesAt), priority (1 to 3), state (planned, in_progress, done, skipped or moved), hoursUnknown.
- **Plan:** planId, tripId, version, status (proposed, active or superseded), trigger (created, late, skipped or edited), checkinId, inputsHash, ruleVersion, travelTimeSnapshotId, legs, totals (travelMin, fareInr, waitMin), reasonCodes, explanation, createdAt.
- **Leg:** seq, taskId, mode (the main mode), segments ([{ mode, minutes }] for mixed legs), leaveBy, arriveAt, travelMin, waitMin, fareInr, transitRef (the Raasta route or metro line used, if any).
- **Option:** optionId, kind (faster_mode, move_task or skip_task), label, consequence, timeSavedMin, extraFareInr, movedTasks, skippedTasks, reasonCodes, and the proposed plan it would apply.
- **Check-in:** checkinId, tripId, taskId, kind (done, skipped or delay), delayMin for a delay, at, idempotencyKey.
- **Raasta route:** routeId, citySlug, stands (ordered: standId, name, location), path, vehicleType (shared_auto, e_rickshaw or tempo), fareInr, frequencyMin, firstTrip, lastTrip, status (unverified, verified or stale), source (stands_tapped, gps_ride or import), confidence, lastConfirmedAt.

The fields hoursUnknown, travelTimeSnapshotId, waitMin, segments, kind, consequence, timeSavedMin and skippedTasks extend the PRD contract; add them to the OpenAPI file.

Plan rules:
- A plan's content is never edited; only its status changes. Exactly one plan per trip is active.
- A proposed plan is an option waiting for the traveller. It gets the next version number only when accepted.
- Undo makes the previous version active again and marks the undone one superseded.
- A plan expires at the end of its day.

Reason codes:

| Code | Meaning |
|---|---|
| ON_TIME | On schedule; nothing changed |
| BEHIND_SCHEDULE | More than 5 minutes past a leave-by time, or a delay was reported |
| SHIFT_ONLY | Times moved; tasks, order and modes kept |
| FIXED_TASK_AT_RISK | A fixed time can't be met without a change |
| WINDOW_CLOSES_SOON | A closing time can't be met without a change |
| FASTER_MODE | The option uses a faster mode that costs more |
| TASK_MOVED_TOMORROW | A task moves to the next day of the trip |
| TASK_SKIPPED | A task is skipped |
| RAASTA_VERIFIED | A leg uses a verified Raasta route |
| RAASTA_UNVERIFIED | An unverified or outdated route is shown as a labelled extra |
| LAST_TRIP_PASSED | A shared-auto route was left out because its last trip has gone |
| HOURS_UNKNOWN | A task's opening hours are missing |
| NO_FEASIBLE_PLAN | No plan keeps every fixed time; the blocking task and the reason are named |

## 9. The planner

**Inputs:** the remaining tasks; the traveller's current place and time, plus any reported delay; a travel-time snapshot with every needed pair of places by every available mode; the day's Raasta routes and metro timetable; and the settings (cost weights, time rules, rule version).

**Leg options for each pair of places:**
- walk, when it is under 1.5 km;
- cab, priced from a per-city fare table (a base fare plus a rate per km);
- metro, with walking at each end, when both ends are near a station;
- a verified Raasta route that serves both ends, with walking at each end;
- metro plus one Raasta route.

A transit leg's travel minutes include walking and the expected wait, which is half the frequency. Every time and fare is an estimate, and the app says so.

**Time rules (settings in rule version 1.0):**
- Leave 5 minutes after a task ends. For a fixed task, leave at the latest time that still meets the buffer.
- A window task starts on arrival, but never before it opens, and must finish by closing time.
- Arrive at least 10 minutes before a fixed task.
- Never use a Raasta route outside its first and last trip, or the metro outside its service hours.
- The day starts and ends at the place of stay.
- A window task with unknown hours is planned as if open, flagged HOURS_UNKNOWN, and the traveller is asked for the hours.

**Search:**
- Up to 8 remaining tasks: depth-first search over every order (8 tasks give 40,320 orders) and every leg option, dropping a partial plan as soon as it misses a fixed time or closing time, or already costs more than the best plan found. This search is exact: it always finds the cheapest plan that keeps every rule.
- More than 8 tasks: insert tasks one at a time into their cheapest feasible position. This is fast but approximate; say so in the explanation.

**Cost**, lower is better: travel minutes + fare in rupees ÷ 10 + waiting minutes + 120 for each moved task. Waiting minutes are time spent idle, such as arriving before a place opens. The weights are settings, saved with the rule version.

**Ties** are broken in a fixed order: fewer moved tasks, then lower fare, then higher priority, then taskId. The same inputs always give the same plan.

**A task that can't fit** is never dropped silently. Return the best plan without it, name the task and the reason ("The university office closes at 17:00; the earliest arrival is 17:20"), and let the traveller move it to another day or change it.

**Replay:** inputsHash is the SHA-256 of the canonical JSON of every input, including the travel-time snapshot ID and the rule version. The inputs are saved with the plan, so it can be replayed exactly.

**Speed:** 8 tasks in under 2 seconds on a laptop. Fetch all travel times before the search (cached in Redis), keep the search in memory, and never call the network inside it.

## 10. The re-plan loop (the agentic flow)

The re-plan loop is Reroute's agent. It runs in the worker, decides with the deterministic planner, acts only within strict limits, and explains everything it does. It uses no AI model.

It runs after every check-in, every 5 minutes during an active trip, and whenever the traveller taps Running late. Each run:
1. **Sense:** load the active plan, the latest check-ins, the current time and the live trip state.
2. **Detect:** the traveller is behind schedule if the task before a leg still isn't checked in as done more than 5 minutes after that leg's leave-by time, or if they reported a delay.
3. **Decide:** run the planner on the remaining tasks from now. One of four results follows:
   - **On time:** nothing changes (ON_TIME), and the Now marker moves.
   - **Shift only:** every task is kept, with the same order and modes. Apply it at once as a new version (SHIFT_ONLY) and tell the traveller. Ask nothing.
   - **Something must give:** change nothing yet. Build 2 or 3 options that differ in kind: a faster mode that keeps every task, a cheaper plan that moves a task to the next trip day, or skipping a priority 3 task. Offer only feasible options, cheapest first by the cost rule. Each shows the time it saves, the extra money and any moved task, with reason codes.
   - **Nothing keeps every fixed time:** return NO_FEASIBLE_PLAN, naming the task at risk and why.
4. **Act:** save any new version (the old active one becomes superseded), update the live state, publish the event, and write a Reroute log entry. Options wait as proposed plans; accepting one makes it the next active version.
5. **Explain:** build every explanation from reason codes with fixed sentence templates, for example "A cab keeps all three tasks today for ₹350 more."

Guardrails:
- On its own, the loop may only shift times. A dearer mode, a moved task or a skipped task always needs the traveller's choice.
- It never moves a fixed time, never claims anything was booked, never offers a shared auto after its last trip, and never offers an unverified or outdated route as the only option.
- Every action is logged and can be undone.
- A repeated check-in with the same idempotency key returns the first result and starts no second re-plan.
- A trip has at most one set of open options. While they wait, the 5-minute check refreshes them instead of adding more, and drops any that stopped being feasible.
- Automatic shifts alert the traveller at most once every 15 minutes; the timeline always updates.
- Location is optional. If permission is denied, the loop works from check-ins and the clock alone.

**Leave-now alerts:** the worker sends a live event 10 minutes before each leave-by time and at the leave-by time. The app shows it on the timeline, and as a browser notification if the traveller allowed that.

## 11. The optional AI helper (off by default)

This is Diksha's area. Start it only when everything else works.
- **Describe your day:** the traveller types their day in plain words, and the server returns draft tasks (title, place text, duration, fixed time or window, priority). Nothing is saved until the traveller confirms each draft. The endpoint is `POST /v1/trips/:id/task-drafts`, and it saves nothing.
- It runs on the server only, behind `AI_HELPER_ENABLED=false` and an adapter, so the provider can change. The model's reply must validate against the task-draft schema; anything invalid is dropped, and the traveller fills in the form instead.
- It can never move a fixed time, invent a place or route, or bypass a planner rule. The planner and the explanation templates stay deterministic.
- Only the typed text goes to the provider: no name, email or location.
- The demo and every acceptance test must pass with it switched off.

## 12. Raasta

- **A separate app** with its own tables (a `raasta` schema in Postgres) and its own Swagger docs. It must run and demo on its own.
- **Adding a route:**
  - Tap stands: the contributor taps the stands in order, and OSRM draws the road path between them.
  - Record a ride: the phone records GPS points during the ride. The server trims the first and last 200 m, snaps the rest to roads with OSRM's match service, and suggests stands where the vehicle stopped. Raw points are kept in MongoDB.
  - Every contribution has a vehicle type, a fare, a frequency, and first and last trip times. It starts as unverified.
- **Verifying:** a route becomes verified when a moderator approves it, or when two different contributors submit the same route. Two routes count as the same when they have the same vehicle type and the same stands in the same order, with each stand within 150 m.
- **Freshness:** "It still runs" confirmations update lastConfirmedAt. After 90 days without a confirmation, a route becomes stale and goes back to verification. A moderator, or two riders confirming it, makes it verified again.
- **Fares:** show the most common fare reported in the last 30 days (on a tie, the newer one). Fare reports go through the moderator queue.
- **Offering routes to Reroute:** only verified, current routes are the main option, and only between their first and last trip. Unverified or stale routes appear only as labelled extras (RAASTA_UNVERIFIED).
- **Open data:** `GET /v1/raasta/cities/:slug/gtfs.zip` exports verified routes as GTFS (agency, stops, routes, trips, stop_times, frequencies, shapes and calendar).
- **Scope:** about 5 km around our campus, with 20 to 30 real routes, plus sample routes for the Bengaluru demo, labelled as sample.
- **Limit:** 10 contributions a day per user.

## 13. API

Both modules expose versioned JSON APIs under `/v1`. FastAPI generates the Swagger docs, and the OpenAPI file is the contract. The Postman collection holds every request with a response example.

Conventions:
- **Idempotency:** every POST takes an idempotency key (the `idempotencyKey` body field, as in the examples). The same key with the same body returns the first response again. The same key with a different body returns 409. Keys are kept for 24 hours.
- **Errors** use one shape, `{ "error": { "code": "...", "message": "...", "traceId": "..." } }`:
  - 400 or 422 for bad input;
  - 401 or 403 for sign-in or role problems;
  - 404 for unknown IDs;
  - 409 for conflicts;
  - 410 for a revoked or expired share link;
  - 413 for oversized bodies;
  - 429 for rate limits.
- **Lists** use cursor pagination (`?cursor=&limit=`, with `nextCursor` in the response).
- **Handlers** stay thin; the logic lives in services.
- **Planning** (`POST /v1/trips/:id/plans`) returns 202 with a jobId. The plan arrives as a live event and at `GET /v1/trips/:id/plans/:version`.

| Method and path | Module | Purpose |
|---|---|---|
| POST /v1/auth/google | Reroute | Exchange a Google sign-in code for our tokens |
| POST /v1/auth/refresh | Reroute | Get a new access token |
| POST /v1/trips | Reroute | Create a trip |
| POST /v1/trips/:id/tasks | Reroute | Add a task |
| POST /v1/trips/:id/calendar-import | Reroute | Import appointments from Google Calendar |
| POST /v1/trips/:id/plans | Reroute | Start planning; returns 202 and a job ID |
| GET /v1/trips/:id/plans/:version | Reroute | One plan version with its legs and reasons |
| POST /v1/trips/:id/checkins | Reroute | Report done, skipped or a delay; may return re-plan options |
| POST /v1/trips/:id/options/:optionId/accept | Reroute | Apply a re-plan option as a new plan version |
| GET /v1/trips/:id/live | Reroute | Live updates as server-sent events |
| POST /v1/trips/:id/share-links | Reroute | Create a view-only link |
| DELETE /v1/share-links/:id | Reroute | Revoke a link |
| GET /v1/shared/:token | Reroute | Family view of a shared trip |
| GET /v1/trips/:id/summary | Reroute | End-of-day summary and expense slip |
| GET /v1/raasta/routes?from=&to=&at= | Raasta | Verified shared-auto options for one leg |
| GET /v1/raasta/stands?near=&radius= | Raasta | Stands near a point |
| POST /v1/raasta/contributions | Raasta | Add a route or a GPS ride |
| PATCH /v1/raasta/contributions/:id | Raasta | Moderator decision |
| POST /v1/raasta/routes/:id/confirmations | Raasta | Confirm that a route still runs |
| POST /v1/raasta/routes/:id/fare-reports | Raasta | Report a fare |
| GET /v1/raasta/cities/:slug/gtfs.zip | Raasta | Download the city's open route data |

The screens also need these endpoints, which the PRD table doesn't list yet. Add them to the OpenAPI file and the Postman collection:

| Method and path | Module | Purpose |
|---|---|---|
| POST /v1/auth/demo | Reroute | Demo sign-in; exists only when DEMO_LOGIN=true |
| POST /v1/auth/logout | Reroute | Revoke the refresh token |
| GET /v1/me | Reroute | The signed-in user and their role |
| DELETE /v1/me/location-history | Reroute | Delete the traveller's location history |
| GET /v1/trips | Reroute | The traveller's trips |
| GET /v1/trips/:id | Reroute | One trip with its tasks and active plan |
| PATCH /v1/trips/:id/tasks/:taskId | Reroute | Edit a task, which re-plans with the trigger "edited" |
| POST /v1/trips/:id/plans/:version/activate | Reroute | Undo: make an earlier version active again |
| GET /v1/jobs/:jobId | Reroute | Status of a planning job |
| GET /v1/raasta/routes/:id | Raasta | One route with its stands |
| GET /v1/raasta/contributions?status= | Raasta | The moderator queue |
| GET /v1/raasta/fare-reports?status= | Raasta | Fare reports waiting for review |
| PATCH /v1/raasta/fare-reports/:id | Raasta | Moderator decision on a fare report |

**Live events** on `GET /v1/trips/:id/live`:
- `plan_updated`: a new active version, with its trigger and reason codes;
- `options_ready`: options waiting for a choice;
- `leave_now`: a leave-by time is close;
- `checkin_recorded`: a check-in was saved;
- `trip_ended`: the trip is over.

The family view refreshes `GET /v1/shared/:token` every 30 seconds.

**Example: report a delay**
```
POST /v1/trips/trip-001/checkins
{ "taskId": "task-meet", "kind": "delay", "delayMin": 40,
  "idempotencyKey": "chk-001" }

200 { "planId": "plan-001", "result": "options",
  "reasonCodes": ["BEHIND_SCHEDULE", "WINDOW_CLOSES_SOON"],
  "options": [
    { "optionId": "opt-1", "label": "Take a cab to the bank",
      "extraFareInr": 350, "movedTasks": [],
      "reasonCodes": ["FASTER_MODE"] },
    { "optionId": "opt-2", "label": "Keep it cheap",
      "extraFareInr": 0, "movedTasks": ["task-office"],
      "reasonCodes": ["TASK_MOVED_TOMORROW"] } ] }
```
The `result` field is one of `on_time`, `shifted` (the new plan is included), `options` or `no_feasible_plan`.

**Example: accept an option**
```
POST /v1/trips/trip-001/options/opt-1/accept
{ "idempotencyKey": "acc-001" }

200 { "planId": "plan-002", "version": 2, "status": "active",
  "trigger": "late", "ruleVersion": "1.0",
  "legs": [
    { "seq": 1, "taskId": "task-bank", "mode": "cab",
      "leaveBy": "2026-10-14T11:45:00+05:30",
      "arriveAt": "2026-10-14T12:35:00+05:30",
      "travelMin": 50, "fareInr": 430 } ],
  "reasonCodes": ["FASTER_MODE"],
  "explanation": "A cab keeps all three tasks today for ₹350 more." }
```
Only the first leg is shown; the Postman collection holds the full responses.

## 14. Data storage (a starting design)

Diksha owns the final schema; the contracts in section 8 are fixed.
- **PostgreSQL, Reroute tables:**
  - users (Google subject ID, email, name, role);
  - trips;
  - places (name, area, a PostGIS point, OSM ID);
  - tasks;
  - plans and plan_legs;
  - checkins;
  - share_links (token stored hashed, revokedAt, expiresAt);
  - refresh_tokens (stored hashed);
  - reroute_log.
- **PostgreSQL, `raasta` schema:**
  - stands (a geography point with a GiST index, for "stands near me");
  - routes (a geography line);
  - route_stands;
  - contributions;
  - confirmations;
  - fare_reports.
- **MongoDB:**
  - gps_rides: the trimmed raw points of each recorded ride;
  - location_timeline: the traveller's points during active trips only. A TTL index deletes them 30 days after the trip, and the traveller can delete them sooner.
- **Redis:**
  - the travel-time cache, keyed by city, from, to, mode and hour, kept for 24 hours;
  - live trip state;
  - rate-limit counters;
  - idempotency keys (24 hours);
  - the RQ queues;
  - one pub/sub channel per trip.
- **Seed data:**
  - the demo traveller for DEMO_LOGIN;
  - a moderator;
  - the Bengaluru demo trip;
  - sample Raasta routes, all labelled as sample.

## 15. Security and privacy

1. **Validation:** validate every input with Pydantic. That covers times, durations (5 minutes to 12 hours), coordinates inside the city, fares (₹0 to ₹2,000) and body size (413 above the limit).
2. **Google sign-in:** use the authorization code flow. The browser gets a one-time code from Google, and only the server exchanges it, using a client secret the browser never sees. Verify the ID token's issuer, audience and expiry, and find the user by Google's subject ID. Ask for Calendar read-only access only when the traveller imports.
3. **Tokens:**
   - The access token is a JWT that lasts 15 minutes and is sent in the Authorization header.
   - The refresh token sits in an httpOnly, Secure, SameSite=Strict cookie. It is rotated on every use and stored hashed, so it can be revoked.
   - The refresh call also needs a CSRF token (double submit).
4. **Access:** check the role and trip ownership on every route. A share token is 128 random bits, stored hashed. It can be revoked, and it expires when the trip ends.
5. **Idempotency:** every POST is idempotent, so a repeated check-in or contribution never creates a second re-plan or route.
6. **Rate limits** in Redis:
   - 60 requests a minute per user;
   - 10 Raasta contributions a day;
   - stricter limits per IP on the sign-in routes.
7. **Cross-site scripting:** React's escaping only. User text is never rendered as HTML, and NGINX sends a Content Security Policy.
8. **Location:**
   - Use it only during an active trip.
   - Trim the first and last 200 m of every Raasta recording.
   - Let users delete their history, in line with India's DPDP Act, 2023.
   - `docs/` lists what data is kept, for how long and how to delete it.
9. **Never collected:** payment details, passwords or government ID numbers.
10. **Honest labels:** travel times and fares are labelled as estimates, and a rerouted plan never claims that anything was booked.
11. **Reproducible plans:** every plan can be rebuilt from its saved inputs, rule version and travel-time snapshot.
12. **Secrets and demo mode:**
    - No secret goes in the repository or the browser.
    - `DEMO_LOGIN=true` must be refused when the app runs in production mode.
    - Serve the app and both APIs from one origin, so cookies stay first-party and CORS stays closed.

## 16. Demo data and the golden test

**Bengaluru demo trip** (sample data, labelled as sample): Wednesday 14 October 2026, day 1 of 2, staying at a hotel near Majestic. IDs match the API examples (trip-001, task-meet, task-bank, task-office).

| Task | Place | Timing | Duration | Priority |
|---|---|---|---|---|
| Meeting | Whitefield | Fixed 10:00 | 1 h | 1 |
| Bank | Koramangala | Open 10:00 to 16:00 | 2 h 30 min | 1 |
| University office | Jayanagar | Open 10:00 to 17:00 | 45 min | 1 |
| Train home | KSR Bengaluru | Fixed, Thursday 15 October 21:00 | 30 min | 1 |

**Travel-time snapshot** (`examples/bengaluru/travel-times.json`, sample):

| From → to | Transit option | Cab |
|---|---|---|
| Hotel → Whitefield | Metro, then shared auto: 60 min, ₹70 | 75 min, ₹600 |
| Hotel → Koramangala | Metro: 35 min, ₹30 | 40 min, ₹300 |
| Hotel → Jayanagar | Metro: 20 min, ₹30 | 35 min, ₹250 |
| Whitefield → Koramangala | Metro, then shared auto: 80 min, ₹80 | 50 min, ₹430 |
| Whitefield → Jayanagar | Metro, then shared auto: 100 min, ₹90 | 70 min, ₹550 |
| Koramangala ↔ Jayanagar | Shared auto (Raasta, verified): 40 min, ₹30 | 30 min, ₹250 |
| Koramangala → Hotel | Metro: 35 min, ₹30 | 40 min, ₹300 |
| Jayanagar → Hotel | Metro: 20 min, ₹30 | 35 min, ₹250 |

Pairs not listed have no leg option in this sample.

**Expected results.** The planner must produce exactly these; they are the golden test:
- **Plan version 1:**
  - leave the hotel at 08:50;
  - meeting 10:00 to 11:00;
  - leave 11:05 by metro, then shared auto;
  - bank 12:25 to 14:55;
  - leave 15:00 by Raasta shared auto;
  - office 15:40 to 16:25;
  - leave 16:30 by metro;
  - hotel 16:50.
- **15-minute delay**, reported at 10:55: shift only, applied at once. Leave at 11:20; the bank becomes 12:40, the office 15:55 and the hotel 17:05.
- **40-minute delay**, reported at 10:55: nothing changes until the traveller chooses. The reason codes are BEHIND_SCHEDULE and WINDOW_CLOSES_SOON, and the two options appear in this order:
  - **opt-1, "Take a cab to the bank":** +₹350, saves 30 min, cost 159. Leave at 11:45 by cab; the bank becomes 12:35 to 15:05, the office 15:50 to 16:35, and the hotel 17:00.
  - **opt-2, "Keep it cheap":** no extra cost, cost 246. The bank becomes 13:05 to 15:35, then metro to the hotel at 16:15. The office moves to tomorrow at 10:00.
  - Taking metro and shared auto to the bank, then a cab to the office (cost 166), keeps every task but loses to opt-1, so it isn't offered.
- **Accepting opt-1** creates version 2 (trigger late). Undo makes version 1 active again.
- **Day summary with opt-1:** ₹70 + ₹430 + ₹30 + ₹30 = ₹560, 2 h 50 min travelling, rerouted once.

**Demo clock:** with `DEMO_LOGIN=true`, the API accepts a simulated current time and can run the 5-minute check at once, so the reviewer can replay the day from the app's Simulate panel. Production ignores both.

**Campus trip:** a second demo around our campus, using real Raasta routes mapped by the team.

## 17. Build order and owners

| Weeks | Deliverable |
|---|---|
| 1–2 | API design in OpenAPI, repository, Docker setup and demo login |
| 3–4 | PostgreSQL with PostGIS, MongoDB, migrations and seed data; start mapping Raasta routes |
| 5–6 | Google sign-in, JWT, roles, share links and Calendar import |
| 7–8 | Redis cache and job queue, the planner worker, the OSRM adapter and rate limits |
| 9–10 | Planner and re-planner with their tests; Raasta verification and its transit adapter |
| 11–12 | React screens; pilot trips start |
| 13–14 | Live updates, offline mode and instant check-ins; Postman flows |
| 15–16 | Accessibility audit, load test, deployment, demo video and final documents |

| Owner | Area |
|---|---|
| Ankit | Backend and the agentic flow: the APIs, planner, re-plan loop and worker |
| Diksha Sharma | Databases and AI: schemas, migrations, PostGIS and MongoDB, Redis design, seed and Raasta data, the optional AI helper |
| Trish | Frontend: the React PWA, following the UI brief |
| Lovish | Testing and deployment: pytest, Postman and Newman, k6, Playwright with axe, Docker, NGINX, CI and deployment |

When you work in one area, stay in it. Flag any change that touches another owner's contract, schema or API.

**Offline and instant check-ins** (weeks 13–14):
- The service worker and a persisted TanStack Query cache keep the active plan readable offline.
- Check-ins made offline are queued with their idempotency keys and sent when the phone is back online. Idempotency makes the retry safe.
- Check-ins update the screen at once, then reconcile with the server's answer.

## 18. Definition of done

The reviewer will check that:
1. A new developer can follow the README and start everything with `docker compose up`.
2. Sign-in works with Google or the local demo login, and a family viewer cannot change anything.
3. The demo trip gets a plan in under 2 seconds that keeps every fixed time and opening window.
4. The timeline shows each leg's mode, time and fare, and a leave-now alert.
5. A 15-minute delay shifts the later times without asking anything.
6. A 40-minute delay offers options with time and extra cost; accepting one creates plan version 2, and Undo restores version 1.
7. A Raasta leg shows the fare, frequency, last trip and last confirmed date, and a route past its last trip is not offered.
8. A new Raasta route appears in plans only after it is verified.
9. Sending the same check-in twice causes only one re-plan.
10. A share link shows the live trip read-only and stops working once revoked.
11. The app works by keyboard and with a screen reader, with no critical axe issues.
12. A k6 load test of 500 virtual users keeps 95% of responses under 500 ms.

Also required:
- **Planner tests:** 30 or more, all passing, including:
  - fixed times and the 10-minute buffer;
  - opening windows;
  - the cheapest order matching brute force on small cases;
  - the same input giving the same plan and hash;
  - shift-only detection;
  - options of different kinds;
  - last trips;
  - unverified routes never being the only option;
  - unknown hours;
  - a task moved to the next day;
  - no feasible plan naming the task;
  - more than 8 tasks.
- **Golden test:** section 16, exactly.
- **Backend coverage:** 70% or more.
- **Postman:** the collection passes in CI.
- **Accessibility:** a manual NVDA check.
- **Re-plans:** keep every fixed time in 100% of the test cases where that is possible.
- **Completion checklist:**
  - Raasta runs on its own.
  - Routing and calendar can be replaced without changing the planner.
  - No secret is in browser code.
  - Every plan traces from trip to check-in to version to reason codes.
  - `docs/` lists the data kept, how to delete it, and the known limits.
  - A clean checkout starts with one command.

Deliver:
- the source code and the `.env.example` files;
- the README and `docker-compose.yml`;
- the Postman collection with response examples;
- the tests;
- phone screenshots and a short demo video;
- the API guide.

No real credentials go in the repository.

## 19. Never

- Drop a task silently, or move a fixed time without the traveller's choice.
- Offer a shared auto after its last trip, or an unverified or outdated route as the only option.
- Claim that anything was booked, or show an estimate as exact.
- Edit a plan in place, or plan inside an API request.
- Let Reroute read Raasta's tables, or let the planner call the network.
- Use a paid service, put a secret in the browser or the repository, or enable DEMO_LOGIN in production.
- Use location outside an active trip, or keep the first and last 200 m of a ride.
- Let the optional AI helper change a rule, a fixed time or a route.
- Add features, data or endpoints this brief doesn't describe without recording the decision and asking the team.
