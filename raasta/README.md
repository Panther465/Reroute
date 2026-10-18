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

Daily freshness check (cron or the worker's scheduler): `python -m app.jobs.freshness`.

## Endpoints

All paths start with `/v1/raasta`. Reads are open data; writes need a Reroute access token
(`Authorization: Bearer …`); moderation needs the moderator or admin role.

| Method and path | Who | Purpose |
|---|---|---|
| GET /routes?from=lng,lat&to=lng,lat&at=ISO | anyone | Verified shared-auto options for one leg |
| GET /routes/{id} | anyone | One route with its stands |
| GET /stands?near=lng,lat&radius=m | anyone | Stands near a point |
| GET /cities/{slug}/gtfs.zip | anyone | The city's verified routes as GTFS |
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
- Every POST takes an `idempotencyKey` (8 to 128 characters) in its body. The same key with the same
  body returns the first response again, with `Idempotent-Replayed: true`. The same key with a
  different body returns 409 `IDEMPOTENCY_CONFLICT`. Keys are kept for 24 hours.
- Errors: `{"error": {"code": "...", "message": "...", "traceId": "..."}}`. Send `X-Request-ID`
  to choose the trace ID; it is echoed back on every response.
- Lists use `?cursor=&limit=` (default 20, at most 100) and return `nextCursor`.
- Limits: 60 requests a minute per user (or per IP when signed out), 10 contributions a day per
  user, and 413 for bodies above `MAX_BODY_BYTES`.

## Rules

- **Leg options.** Only verified routes are main options. Unverified or stale routes come back
  only under `extras`, so Reroute shows them as labelled extras (RAASTA_UNVERIFIED). A route whose
  last trip has gone by boarding time is left out and listed in `lastTripPassed`.
  The boarding stand must come before the alighting stand, each within `WALK_RADIUS_M`.
- **Recorded rides.** The server drops every point in the first and last 200 m before anything is
  stored, snaps the rest to roads with OSRM's match service (straight lines if OSRM is down) and
  suggests stands where the vehicle stood still for 30 seconds or more. The trimmed points go to
  MongoDB (`gps_rides`); Postgres keeps only the route.
- **Verifying.** A new route starts unverified. It becomes verified when a moderator approves it, or
  when a different contributor submits the same route: same vehicle type, same stands in the same
  order, each within 150 m.
- **Freshness.** "It still runs" confirmations update `lastConfirmedAt`. After 90 days without one, a
  verified route becomes stale and goes back to the moderator queue as a freshness check. A
  moderator, or two different riders confirming it, makes it verified again.
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
