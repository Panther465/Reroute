# Raasta API

Raasta is a crowdsourced map of shared-auto, e-rickshaw and tempo routes: the stands, the fare,
how often vehicles come and when the last one leaves. It is a separate app with its own tables
(the `raasta` schema) and its own Swagger docs, and it runs and demos on its own. Reroute reaches
it only over HTTP, through its transit adapter.

Swagger: `http://localhost:8001/v1/raasta/docs` · OpenAPI: `/v1/raasta/openapi.json`

## Run it alone

With Docker (from the repository root, everything else included):

```sh
docker compose up raasta
```

Without Docker (Python 3.12+, plus PostgreSQL 16 with PostGIS, Redis 7 and MongoDB 7 running):

```sh
cd raasta
python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cp .env.example .env                             # then edit the values
alembic upgrade head
python -m app.seed                               # sample Bengaluru routes, labelled sample
uvicorn app.main:app --port 8001 --reload
```

The freshness check runs inside the API every 6 hours (a Redis lock keeps several copies from
running it at once). To run it by hand: `python -m app.jobs.freshness`.

## Endpoints

All paths start with `/v1/raasta`. Reads are open data; writes need a Reroute access token
(`Authorization: Bearer …`); moderation needs the moderator or admin role.

| Method and path | Who | Purpose |
|---|---|---|
| GET /routes?from=lng,lat&to=lng,lat&at=ISO | anyone | Verified shared-auto options for one leg |
| GET /routes/{id} | anyone | One route with its stands |
| GET /stands?near=lng,lat&radius=m | anyone | Stands near a point (sample stands and stands on verified or stale routes) |
| GET /cities/{slug}/gtfs.zip | anyone | The city's verified routes as GTFS (404 for a city Raasta doesn't serve) |
| POST /contributions | signed in | Add a route by tapping stands, or a recorded GPS ride |
| POST /routes/{id}/confirmations | signed in | Confirm that a route still runs |
| POST /routes/{id}/fare-reports | signed in | Report a fare |
| GET /contributions?status= | moderator | The moderator queue |
| PATCH /contributions/{id} | moderator | Approve, edit or reject a route |
| GET /fare-reports?status= | moderator | Fare reports waiting for review |
| PATCH /fare-reports/{id} | moderator | Accept or reject a fare report |
| GET /healthz, /readyz | anyone | Liveness and readiness |

Conventions shared with the Reroute API:

- JSON is camelCase. Times of day are `HH:MM`; timestamps are ISO 8601 with `+05:30`; money is whole rupees.
- Every POST takes an `idempotencyKey` (4 to 128 characters) in its body; `idempotency_key` is
  read too. The same key with the same body returns the first response again, with
  `Idempotent-Replayed: true`. The same key with a different body returns 409
  `IDEMPOTENCY_CONFLICT`. The same request again while the first is still running returns 409
  `IN_PROGRESS`: retry later with the same key. Keys are kept for 24 hours.
- Errors: `{"error": {"code": "...", "message": "...", "traceId": "..."}}`. Send `X-Request-ID`
  (8 to 128 of `A-Z a-z 0-9 . _ : -`) to choose the trace ID; it is echoed back on every response,
  unhandled 500s included. 503 `UNAVAILABLE` means MongoDB couldn't store or remove a recorded
  ride; nothing was saved, so retry later.
- Lists use `?cursor=&limit=` (default 20, at most 100) and return `nextCursor`. A malformed
  cursor is 400 `BAD_REQUEST`.
- Limits: 60 requests a minute per user (or per IP when signed out), 10 contributions a day per
  user, and 413 for bodies above `MAX_BODY_BYTES`.
- Cities: only the cities in `app/cities.py` (Bengaluru today, the same bounding box as the Reroute
  API). A contribution must name one, and every tapped location and ride point must lie inside it
  (422 otherwise); stand IDs from another city are refused.
- Service token: the Reroute API sends `X-Service-Token` equal to `RAASTA_SERVICE_TOKEN` (empty
  turns it off). Its requests share one bucket of `SERVICE_RATE_LIMIT_PER_MINUTE` (3000) and can
  only read: a POST or PATCH with the token and no signed-in user is 403. Production refuses a
  token shorter than 32 characters or starting with `dev-only`.
- Logs: one access line per request with the method, the path without its query string (queries
  carry coordinates), the status, the time taken and the trace ID. Uvicorn's own access log is off.

## Rules

- **Leg options.** Only verified routes are main options. Unverified or stale routes come back
  only under `extras`, so Reroute shows them as labelled extras (RAASTA_UNVERIFIED). A route whose
  last trip has gone by boarding time is left out and listed in `lastTripPassed`.
  The boarding stand must come before the alighting stand, each within `WALK_RADIUS_M`.
- **Recorded rides.** The server keeps only the points more than 200 m, in a straight line, from
  both the first and the last point, so waiting at the start with a jittery GPS doesn't use up
  the margin; a ride that never gets that far from both ends is refused. Long rides are thinned
  to 2,000 points spread over time. The server snaps them to roads with OSRM's match service
  (straight lines if OSRM is down) and suggests at most 20 stands, spread along the ride, where
  the vehicle stood still for 30 seconds or more (slightly approximate, so a crafted ride can't
  make it slow). The trimmed points go to MongoDB (`gps_rides`) only once the rest of the
  contribution is valid, just before it is committed; Postgres keeps only the route. Rejecting a
  recorded ride deletes its points.
- **Verifying.** A new route starts unverified. It becomes verified when a moderator approves it
  (never their own contribution: that is 403), or when a different contributor submits the same
  route: same vehicle type, same stands in the same order, each within 150 m. That second
  submission must be a recorded ride or tap at least one stand as a location (stand IDs alone
  don't count), and must come from someone who hasn't contributed to the route before. Other
  matching submissions are merged into the route without verifying it.
- **Freshness.** "It still runs" confirmations update `lastConfirmedAt`; each rider counts once per
  route per day (a repeat returns the current state), and `confirmationsCount` counts different
  riders. After 90 days without one, a verified route becomes stale and goes back to the moderator
  queue as a freshness check. A moderator, or two different riders since it went stale, makes it
  verified again; riders are the people confirming it and the contributors whose submission
  matched it, so one submission alone never revives it.
- **Stands on the map.** `GET /stands` lists sample stands and stands on verified or stale routes.
  Stands that only belong to unverified routes, or to none, stay hidden until a route through
  them is verified.
- **Fares.** A route shows the most common accepted fare reported in the last 30 days (on a tie, the
  newer one), else its own fare. Fare reports go through the moderator queue.
- **Open data.** The GTFS feed holds verified routes only: agency, stops, routes, trips,
  stop_times, frequencies, shapes, calendar and feed_info. Shared autos run on headways, so each
  route has one template trip with frequency-based service between its first and last trip.

## Tests

```sh
pytest                      # unit tests; no database needed
TEST_DATABASE_URL=postgresql+psycopg://... pytest -m db     # integration tests
```
