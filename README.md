# Reroute

*Running late? We'll reroute your day.*

Reroute is a travel companion for work trips to an unfamiliar Indian city. You enter your tasks once: a meeting at 10:00, a bank that's open till 16:00, an office that closes at 17:00. Reroute plans the day (the order, when to leave, how to travel and what each leg costs) and follows it with you. When you run late, it re-plans the rest of the day: if everything still fits it shifts the times and tells you; if something has to give, it changes nothing and offers two or three explained options.

**Raasta**, the second module, is a crowdsourced, moderated map of shared-auto, e-rickshaw and tempo routes: the stands, the fare, how often they come and when the last one leaves. Reroute uses verified Raasta routes for local legs.

Every travel time and fare is an estimate. All demo data is sample data.

## Quick start

You need Git and Docker Desktop.

```bash
git clone https://github.com/Panther465/Reroute.git
cd Reroute
docker compose up --build
```

Open **https://localhost**, accept the local certificate, and choose **Use the demo account**.

If ports are taken on your machine, the stack stays out of the way: PostgreSQL, Redis and MongoDB are published on 55432, 56379 and 57017, and plain HTTP on 8080. Change any of them with `POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`, `MONGO_HOST_PORT`, `HTTP_PORT` or `HTTPS_PORT`. Everything listens on 127.0.0.1 only; set `BIND_ADDR=0.0.0.0` to try the app from a phone on the same network. Browsers won't install the offline service worker over an untrusted certificate; to try offline mode locally, trust the certificate (for example with [mkcert](https://github.com/FiloSottile/mkcert), placed at `/etc/nginx/certs/localhost.{crt,key}` in the `certs` volume). The demo trip is Bengaluru, Wednesday 14 October 2026, on a simulated clock.

Try the golden path:

1. **Plan** → **Plan my day**. The plan leaves the hotel at 08:50; the meeting is 10:00 to 11:00, the bank 12:25, the university office 15:40, back at the hotel 16:50.
2. Open the **Simulate** panel, set the time to 10:55, then **Running late** → **About 15 min**. Everything still fits, so Reroute shifts the later stops (12:40, 15:55, 17:05) without asking.
3. Undo it, then report **About 40 min**. Now something must give: **Take a cab to the bank** (+₹350, saves 30 min) or **Keep it cheap** (the office moves to tomorrow at 10:00). Choose one, then Undo.
4. **Share** your trip and open the link in a private window: family see your stops and progress, never your exact location.

## How it fits together

```
Phone (PWA) ──HTTPS──▶ NGINX ─┬─ /v1/raasta/* ──▶ Raasta API ──▶ PostgreSQL (raasta schema), MongoDB (rides)
                              ├─ /v1/*        ──▶ Reroute API ×2 ──▶ PostgreSQL (public), Redis
                              └─ /*           ──▶ web app             │
                                                                        ▼ queue
                                           Worker (planner, re-plan loop) ──HTTP──▶ Raasta API
                                           Scheduler (5-minute checks, leave-now alerts, morning plans)
```

- The **planner** is a pure function (`backend/app/services/planner/`): inputs in, plan out, no clock, network or database. Up to eight tasks the search is exact.
- The **API never plans inside a request**: it saves, enqueues, and the worker plans. Plans are immutable versions; Undo reactivates an earlier one.
- **Reroute reaches Raasta only over HTTP** through the transit adapter. The database roles make reading Raasta's tables impossible.
- Live updates go to the phone as server-sent events.

## Repository

| Path | What |
|---|---|
| `backend/` | Reroute API, worker and scheduler (FastAPI, SQLAlchemy, RQ) |
| `raasta/` | Raasta API (FastAPI, PostGIS, MongoDB) |
| `frontend/` | The web app (React, Vite, TypeScript, PWA) |
| `shared/contracts/` | Generated OpenAPI files: the contract |
| `examples/bengaluru/` | Sample demo trip, travel times and Raasta routes |
| `postman/` | API collection with response examples |
| `tests/load/` | k6 load test |
| `infra/` | NGINX, PostgreSQL roles, OSRM preparation |
| `docs/` | [API guide](docs/api-guide.md), [decisions](docs/decisions.md), [data and privacy](docs/data-and-privacy.md), [known limits](docs/known-limits.md), [briefs](docs/briefs/) |

## Working outside Docker

Node.js 22 (LTS) and Python 3.12 are only needed here.

```bash
# Databases only (published on 55432, 56379 and 57017 so they don't clash with local installs)
docker compose up -d postgres redis mongo

# Reroute API (http://localhost:8000/v1/docs)
cd backend && python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]" && cp .env.example .env
alembic upgrade head && python -m app.seed
uvicorn app.main:app --reload            # and in other shells: rq worker planning; python -m app.workers.scheduler

# Raasta API (http://localhost:8001/v1/raasta/docs)
cd raasta && pip install -e ".[dev]" && cp .env.example .env && alembic upgrade head && python -m app.seed && uvicorn app.main:app --port 8001

# Web app (http://localhost:5173)
cd frontend && pnpm install && pnpm dev
```

## Tests

| Command | What it checks |
|---|---|
| `cd backend && pytest` | Planner rules, the golden test from the brief, request guards; API flow tests too when `TEST_DATABASE_URL` points at PostGIS |
| `cd raasta && pytest` | Trimming, matching, fares, freshness, GTFS, idempotency |
| `cd frontend && pnpm test` | Timeline view model, API client, offline queue |
| `npx newman run postman/reroute.postman_collection.json --insecure` | The demo day against a running stack |
| `cd frontend && E2E_BASE_URL=https://localhost pnpm e2e` | Playwright with axe |
| `k6 run tests/load/k6.js` | 500 virtual users, 95% under 500 ms |

CI runs all of them except the load test, which runs on demand.

## Configuration

Every setting is an environment variable documented in `backend/.env.example`, `raasta/.env.example` and `frontend/.env.example`. No secret is committed or sent to the browser. `DEMO_LOGIN=true` is refused when `APP_ENV=production`, and so are development values of `JWT_SECRET` and `RAASTA_SERVICE_TOKEN`.

For a deployment, `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` runs everything in production mode without the demo login; Compose refuses to start until every secret it names is set.

## Team

| Owner | Area |
|---|---|
| Ankit | Backend and the agentic flow: the APIs, planner, re-plan loop and worker |
| Diksha Sharma | Databases and AI: schemas, migrations, PostGIS and MongoDB, Redis, seed and Raasta data, the optional AI helper |
| Trish | Frontend: the React PWA, following the UI brief |
| Lovish | Testing and deployment: pytest, Postman and Newman, k6, Playwright with axe, Docker, NGINX, CI |
