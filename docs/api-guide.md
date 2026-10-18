# API guide

Two JSON APIs under `/v1`, served from one origin by NGINX:

- **Reroute API**: trips, tasks, plans, check-ins, sharing. Swagger at `https://localhost/v1/docs`.
- **Raasta API**: shared-auto routes. Swagger at `https://localhost/v1/raasta/docs`.

The OpenAPI files in `shared/contracts/` are the contract; CI fails if they drift from the code. The Postman collection in `postman/` holds every request with a response example and replays the demo day.

## Conventions

- **JSON is camelCase.** Times are ISO 8601 with the city's offset (`2026-10-14T11:45:00+05:30`); opening hours are local `"HH:MM"`; money is whole rupees; durations are whole minutes. Every time and fare is an estimate.
- **Sign-in.** `POST /v1/auth/google` with a one-time Google code, or `POST /v1/auth/demo` locally. You get a 15-minute access token for the `Authorization: Bearer` header; the refresh token sits in an httpOnly cookie. `POST /v1/auth/refresh` needs the `X-CSRF-Token` header set to the `rr_csrf` cookie.
- **Idempotency.** Every POST except sign-in carries `idempotencyKey` (4 to 128 letters, digits, `.`, `_`, `:` or `-`). The same key and body replay the first response (header `Idempotent-Replayed: true`); the same key with a different body is 409 `IDEMPOTENCY_CONFLICT`. Keys last 24 hours. Retry a failed request with the same key.
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

A check-in's `result` is `on_time`, `shifted` (the new plan is included), `options`, `no_feasible_plan` (with `blocked`), `recorded`, or `pending` (202, with `jobId`; the outcome also arrives live).

## Live updates

`GET /v1/trips/:id/live` is a server-sent event stream: `plan_updated`, `options_ready`, `leave_now`, `checkin_recorded`, `trip_ended`. Send the access token in the `Authorization` header (read the stream with `fetch`). The family view polls `GET /v1/shared/:token` every 30 seconds.

## Raasta

`GET /v1/raasta/routes?from=lng,lat&to=lng,lat&at=ISO` returns verified, current routes in `items`, unverified or stale ones in `extras`, and routes whose last trip has gone in `lastTripPassed`. Reads are public; contributions need sign-in; moderation needs the moderator role. `GET /v1/raasta/cities/:slug/gtfs.zip` exports verified routes as GTFS.

## Demo-only routes

With `DEMO_LOGIN=true`: `POST /v1/trips/:id/demo/clock` sets the simulated time, `POST /v1/trips/:id/demo/check` runs the 5-minute check now, `POST /v1/trips/:id/demo/reset` restores the sample day. In production they answer 404.
