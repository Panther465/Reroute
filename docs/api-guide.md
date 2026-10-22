# API guide

Two JSON APIs under `/v1`, served from one origin by NGINX:

- **Reroute API**: trips, tasks, plans, check-ins, sharing. Swagger at `https://localhost/v1/docs`.
- **Raasta API**: shared-auto routes. Swagger at `https://localhost/v1/raasta/docs`.

The OpenAPI files in `shared/contracts/` are the contract; CI fails if either drifts from the code. Swagger lists every endpoint. The Postman collection in `postman/` replays the demo day with a response example for each step; it doesn't cover every endpoint (bookings, speech and road paths, for example, are only in Swagger).

## Conventions

- **JSON is camelCase.** Times are ISO 8601 with the city's offset (`2026-10-14T11:45:00+05:30`); opening hours are local `"HH:MM"`; money is whole rupees; durations are whole minutes. Every time and fare is an estimate.
- **Sign-in.** `POST /v1/auth/google` with a one-time Google code, or `POST /v1/auth/demo` locally. You get a 15-minute access token for the `Authorization: Bearer` header; the refresh token sits in an httpOnly cookie. `POST /v1/auth/refresh` needs the `X-CSRF-Token` header set to the `rr_csrf` cookie. The `user` in the answer (and `GET /v1/me`) carries `features`: `bookings`, `aiHelper` and `voices` say which optional parts this server has on, so the app can hide the rest.
- **Rate limits.** 60 requests a minute per user (or per IP before sign-in); sign-in 10 a minute per IP; refresh and sign-out 60 a minute per IP.
- **Idempotency.** Every POST except sign-in carries `idempotencyKey` (4 to 128 letters, digits, `.`, `_`, `:` or `-`). The same key and body replay the first response (header `Idempotent-Replayed: true`); the same key with a different body is 409 `IDEMPOTENCY_CONFLICT`; the same key while the first request is still running is 409 `IN_PROGRESS` (keep it and retry). Keys last 24 hours. Retry a failed request with the same key.
- **Errors** always look like `{"error": {"code", "message", "traceId"}}`: 400/422 bad input, 401/403 sign-in or role, 404 unknown ID, 409 conflict, 410 revoked share link, 413 body too large, 429 rate limit (with `Retry-After`). Send `X-Request-ID` to set the trace ID.
- **Lists** use `?cursor=&limit=` and return `nextCursor`.

## The demo day, step by step

```http
POST /v1/auth/demo                         {"as": "traveller"}
POST /v1/trips/trip-001/plans              {"idempotencyKey": "plan-001"}         → 202 {"jobId": "…"}
GET  /v1/jobs/{jobId}                                                             → {"status": "finished", "planVersion": 1}
GET  /v1/trips/trip-001/plans/1                                                   → legs 08:50, 11:05, 15:00, 16:30
POST /v1/trips/trip-001/demo/clock         {"now": "2026-10-14T10:55:00+05:30", "idempotencyKey": "clk-1"}
POST /v1/trips/trip-001/checkins           {"taskId": "task-meet", "kind": "delay", "delayMin": 40, "idempotencyKey": "chk-001"}
                                                                                  → result "options", opt-1 and opt-2
POST /v1/trips/trip-001/options/opt-1/accept {"idempotencyKey": "acc-001"}        → version 2, trigger "late"
POST /v1/trips/trip-001/plans/1/activate   {"idempotencyKey": "undo-001"}         → Undo: version 1 is active again
GET  /v1/trips/trip-001/summary                                                   → ₹560, 2 h 50 min, rerouted once
```

A check-in's `result` is `on_time`, `shifted` (the new plan is included), `options` (with `optionSetId`: send it back when accepting), `no_feasible_plan` (with `blocked`), `recorded`, or `pending` (202, with `jobId`; the outcome also arrives live). A skip is always saved: when what's left of the day no longer fits, the answer is 200 `no_feasible_plan`, not an error. While options wait, the 5-minute check keeps the same set (and `optionSetId`) unless the choices themselves changed. If another run is still updating the trip, a check-in, accept or Undo answers 409 `BUSY`; try again.

Adding, editing or removing a task on a day that already has a plan re-plans that day (trigger `edited`). `POST /v1/trips/:id/tasks` and `PATCH …/tasks/:taskId` return the re-plan's `jobId` to poll. When adding several tasks at once, pass `?replan=false` on all but the last so the day re-plans once.

Two stops at the same place (a checkout at the hotel, two tasks in one building) are joined by an "Already there" leg: walk, 0 minutes, ₹0, no segments. A task that couldn't fit is listed in `moved` with `kind: "unplaced"` and its reason, and stays listed in every re-planned version of that day.

**Morning plans.** From 06:00 local time, the scheduler plans each later trip day on its own (trigger `morning`, starting from the place of stay) if it has tasks and no plan yet, and only for a trip you planned before. It arrives as `plan_updated` with `trigger: "morning"` and `notify: true`. `GET /v1/trips/:id/summary?day=YYYY-MM-DD` takes any day of the trip (422 outside it).

## Live updates

`GET /v1/trips/:id/live` is a server-sent event stream: `plan_updated`, `options_ready`, `leave_now`, `checkin_recorded`, `trip_ended`. Send the access token in the `Authorization` header (read the stream with `fetch`). The family view polls `GET /v1/shared/:token` every 30 seconds.

## Raasta

`GET /v1/raasta/routes?from=lng,lat&to=lng,lat&at=ISO` returns verified, current routes in `items`, unverified or stale ones in `extras`, and routes whose last trip has gone in `lastTripPassed`. Reads are public; contributions need sign-in; moderation needs the moderator role. `GET /v1/raasta/cities/:slug/gtfs.zip` exports verified routes as GTFS.

## Demo-only routes

With `DEMO_LOGIN=true`: `POST /v1/trips/:id/demo/clock` sets the simulated time, `POST /v1/trips/:id/demo/check` runs the 5-minute check now, `POST /v1/trips/:id/demo/reset` restores the sample day (and forgets the trip's reported delays, alerts and morning plans) and deletes any other trips the demo account started. In production they answer 404.

**Simulated bookings** (also only with `DEMO_LOGIN=true`; otherwise 404, and `features.bookings` is false). Nothing real is booked or charged; every answer says `demo: true`.

```http
GET  /v1/trips/:id/train-options?taskId=task-train&to=Chennai     → sample trains around the task's time
GET  /v1/trips/:id/cab-options?toId=task-bank                     → cab choices for the leg to that stop ("end" for the way back)
POST /v1/trips/:id/bookings      {"kind": "train", "taskId", "destination", "trainNo", "travelClass", "passengers": [{"name", "age"}], "idempotencyKey"}
POST /v1/trips/:id/bookings      {"kind": "cab", "toId", "optionId", "idempotencyKey"}
GET  /v1/trips/:id/bookings                                       → your simulated tickets and rides, newest first
POST /v1/trips/:id/bookings/:bookingId/cancel {"idempotencyKey"}  → cancelled, with a demo refund
```

## Map and voice helpers

- `GET /v1/road-path?from=lng,lat&to=lng,lat&profile=driving|foot` returns a leg's path along the roads for the map (`source: "road"`), or just its two ends (`source: "line"`) when the routing server is unavailable. Only cities Reroute covers; cached 30 days.
- `GET /v1/speech?text=…&voice=…&rate=slow|normal|fast` reads a short alert aloud as MP3 (Microsoft Edge's neural voices; cached 7 days). `GET /v1/speech/voices` lists the voices. 404 when natural voices are off (`features.voices` is false), 502 when the voice service doesn't answer: the app then uses the phone's own voice.
- `GET /v1/places?q=…&city=bengaluru` searches places in a covered city: known places first, then OpenStreetMap.

`POST /v1/trips/:id/task-drafts` (describe your day) and `POST /v1/trips/:id/calendar-import` return draft tasks and save nothing. Each draft's `placeText` is matched like a place search (known places first, then OpenStreetMap): `placeId` and `place` hold the best match, or are null when nothing matched and the traveller must choose.

`POST /v1/trips/:id/roo` (AI helper only) answers one chat message to Roo: `{message, history: [{role: "user"|"roo", text}]}` gives `{reply, action}`. `action` is null or one change Roo offers (`late`, `done`, `left`, `skip`, `move`, `duration`, `time`, `add`, `replan`, `undo`, `why`, `summary`, `theme`, with `taskId`, `minutes`, `time`, `day`, `text` or `theme` as the type needs). It is checked against the trip and saves nothing: the app asks the traveller, then calls the usual endpoints. 503 `UNAVAILABLE` means Gemini couldn't answer; the app answers from the phone instead.
