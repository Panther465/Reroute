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

**Simulated bookings** (only with `SIMULATED_SERVICES=true`, the default; otherwise 404, and `features.bookings` is false). Nothing real is booked or charged; every answer says `demo: true`.

```http
GET  /v1/trips/:id/train-options?taskId=task-train&to=Chennai     → sample trains around the task's time
GET  /v1/trips/:id/cab-options?toId=task-bank                     → cab choices for the leg to that stop ("end" for the way back)
POST /v1/trips/:id/bookings      {"kind": "train", "taskId", "destination", "trainNo", "travelClass", "passengers": [{"name", "age"}], "idempotencyKey"}
POST /v1/trips/:id/bookings      {"kind": "cab", "toId", "optionId", "idempotencyKey"}
POST /v1/trips/:id/bookings      {"kind": "ticket", "placeId", "visitDate", "optionId": "entry"|"guided", "visitors", "idempotencyKey"}
                                                                  → entry tickets to a sight in the trip's city (SightPass)
GET  /v1/trips/:id/bookings                                       → your simulated tickets and rides, newest first
POST /v1/trips/:id/bookings/:bookingId/cancel {"idempotencyKey"}  → cancelled, with a demo refund
```

## Map and voice helpers

- `GET /v1/trips/:id/plans/:version/paths` returns the plan's legs as drawn, for the map and the directions: `{complete, legs: [{seq, complete, segments: [{mode, source, coords, stops, line, distanceM, durationS, steps}]}]}`.
  - `source` says how each stretch was drawn: `road` (along OpenStreetMap's roads), `rail` (a metro line, station to station), `recorded` (a Raasta route's GPS path) or `approximate` (straight, where nothing better is known).
  - `steps` are turn-by-turn instructions: OSRM's manoeuvres (`kind`, `modifier`, `name`, `exit`), or `board` and `alight` with the `line`, where it's `towards` and how many `stops`. `at` indexes the segment's `coords`.
  - The worker draws the legs after each plan (the `maps` queue). Until it's done, `complete` is false: ask again, or wait for the `paths_ready` live event.
  - The times are for the map only: the plan's own times are the planner's.
- `GET /v1/road-path?from=lng,lat&to=lng,lat&profile=driving|foot` returns one path along the roads (`source: "road"`), or just its two ends (`source: "line"`) when routing is unavailable. Only cities Reroute covers; cached 30 days.
- `GET /v1/speech?text=…&voice=…&rate=slow|normal|fast` reads a short alert aloud as MP3 (Microsoft's neural voices: from Azure AI Speech when `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` are set, otherwise, or when Azure fails, from Edge's read-aloud service; cached 7 days). `GET /v1/speech/voices` lists the voices. `GET /v1/speech/timed` (same parameters) returns the clip with when each word is said, `{audio (base64 MP3), mime, durationMs, words:[{text, offsetMs, durationMs}]}`, for Rico's lip-sync. 404 when natural voices are off (`features.voices` is false), 502 when the voice service doesn't answer: the app then uses the phone's own voice.
- `GET /v1/places?q=…&city=bengaluru` searches places in a covered city: your own places first (`mine: true`), then known places, then OpenStreetMap, each place once. A place a traveller added carries its `category`. 503 `UNAVAILABLE` with `Retry-After: 1` means OpenStreetMap's search (one request a second for everyone) had no turn free and nothing known matched: ask again rather than say nothing was found.
- `GET /v1/cities?q=…` finds a city by name or in a sentence; without `q` it lists every city on Reroute's list, by name. Each has `lng`, `lat` and `bbox` (west, south, east, north), the area place search and trips stay inside.

## Changing a trip

`PATCH /v1/trips/:id {startDate?, endDate?, stayPlaceId?, stayLabel?}` changes a trip's dates or where you stay (`stayPlaceId` and `stayLabel` go together) and returns `{trip, jobId}`. Its city stays: for another city, start a new trip. Dates that leave a task outside the trip are 409 `TASKS_OUTSIDE_DATES` (move or remove it first); more than 14 days is 422. A new place to stay re-plans a day that has a plan (`jobId`). The sample trip is fixed (409 `SAMPLE_TRIP`).

## Expenses

Every route is under `/v1/trips/:id`. Amounts are in **paise** (`amountPaise: 61250` is ₹612.50), unlike the rest of the API's whole rupees, because receipts have paise.

| Call | What it does |
|---|---|
| `GET /expenses` | The trip's expenses (newest day first), `totals` (spent up to the trip's today, upcoming, the forecast, the daily pace, to claim, owed to you, by category, payment and day), the `budget`, `alerts`, `insights`, `claims`, and whether receipts can be `scanning`. Reading it first brings the bookings and plan's fares in step (below) |
| `POST /expenses {day, category, title, amountPaise, payment, …}` | Adds one (201). `category` is transport, stay, food, tickets, communication, office, client or other; `payment` cash, card, upi, wallet or company (company-paid is never reimbursable). Optional `merchant`, `note`, `taxPaise` (GST included), `gstin`, `reimbursable`, `fromReceipt`. The day must be within 30 days of the trip |
| `PATCH /expenses/:eid` | Changes one; `{confirm: true}` confirms a plan estimate as paid. A booking or plan expense the traveller changes is theirs from then on (`edited`) |
| `DELETE /expenses/:eid` | Deletes one added by hand; one from a booking or the plan is put aside instead, so it doesn't come back |
| `POST /expenses/parse {text}` | A draft from a typed line ("Uber to airport Rs. 612.50 upi"): amount, category, payment, day, GST, GSTIN, shop. A shop the traveller has filed before gets their category and payment |
| `POST /expenses/scan` (a JPEG, PNG or WebP as the body, up to 2 MB) | A draft read from a receipt's photo by Gemini: 503 `SCAN_OFF` without the AI helper and a key, 422 `SCAN_FAILED` if no total can be read, 40 a day per traveller |
| `PUT /expenses/:eid/receipt` (the photo as the body), `GET`, `DELETE` | The receipt's photo, kept with the expense. The type is checked from the file's first bytes, not just its Content-Type |
| `PUT /expense-budget {totalPaise, dailyPaise, categoryDailyPaise, receiptOverPaise}`, `DELETE` | The budget and the office's limits, each optional (`categoryDailyPaise: {"food": 80000}` is ₹800 a day for meals; receipts needed above ₹500 unless changed) |
| `POST /expense-claims {expenseIds?}` | A claim (201) of every expense that's ready (reimbursable, confirmed, not claimed, up to today), or those listed, with a reference like `RR-7Q4K2M`. Claimed expenses can't change (409 `CLAIMED`). 409 `NOTHING_TO_CLAIM` |
| `POST /expense-claims/:cid/reimbursed`, `POST /expense-claims/:cid/withdraw` | Marks it paid back; or withdraws one not yet paid back, so its expenses can change |
| `GET /expenses/export.csv?claimId=` | A CSV for the office (UTF-8 with a byte-order mark, so spreadsheets show ₹): date, category, description, shop, payment, reimbursable, amount, GST, GSTIN, receipt, estimate, claim. A cell starting with `= + - @` is kept as text, so a spreadsheet never runs it |

**Kept in step:** each booking is an expense at what it cost after any refund (a cancelled train keeps its fee), paid from the wallet; each leg with a fare in a day's plan is an estimate, except a leg a cab was booked for. Re-planning updates or removes the estimates; one the traveller changed, put aside or claimed stays.

**Alerts:** over budget, heading over (the forecast is past the budget), nearly spent (80%), a day over the daily budget, a category over its daily limit, expenses over the receipt limit without a photo, likely duplicates (the same amount, day and kind, at least one typed in), and plan estimates on past days still to confirm.

## Places of your own

- `POST /v1/me/places {name, category, note?, lng, lat, citySlug, share, idempotencyKey}` adds a place only you see (201). `category` is `food`, `stay`, `sight`, `shop`, `transit` or `other`; the point must be in India and inside the city (422); 200 places a traveller (409 `TOO_MANY_PLACES`) and 50 added a day (429). With `share: true` it's `pending` until a moderator decides.
- `GET /v1/me/places?city=…` lists yours, newest first, with `status` (`private`, `pending`, `approved` or `rejected`, with `rejectReason`) and your `note`, which nobody else ever sees.
- `DELETE /v1/me/places/:placeId` deletes one of yours (204; 404 for anyone else's). A trip that already goes there keeps it until nothing does.
- Moderators and admins: `GET /v1/places/review?status=pending|approved|rejected` lists shared places (never the note), and `POST /v1/places/:placeId/approve {idempotencyKey}` or `…/reject {reason?, idempotencyKey}` decides. 403 for anyone else, and for a moderator's own place.

`POST /v1/trips/:id/task-drafts` (describe your day) and `POST /v1/trips/:id/calendar-import` return draft tasks and save nothing. Each draft's `placeText` is matched like a place search (known places first, then OpenStreetMap): `placeId` and `place` hold the best match, or are null when nothing matched and the traveller must choose.

`POST /v1/trips/:id/roo` (AI helper only; the app now uses Rico's agent, below, when there's a Gemini key) answers one chat message to Rico: `{message, history: [{role: "user"|"roo", text}]}` gives `{reply, action}`. `action` is null or one change Rico offers (`late`, `done`, `left`, `skip`, `move`, `duration`, `time`, `add`, `replan`, `undo`, `why`, `summary`, `theme`, with `taskId`, `minutes`, `time`, `day`, `text` or `theme` as the type needs). It is checked against the trip and saves nothing: the app asks the traveller, then calls the usual endpoints. 503 `UNAVAILABLE` means Gemini couldn't answer; the app answers from the phone instead.

**Rico's agent** (the AI helper with a Gemini key; `features.agent`). `POST /v1/roo/turns` takes `{message, history, tripId?, mode?}` and returns `{reply, reads, ask, proposal, places, sources}`. With `mode: "tourist"` Rico is also a local guide: it recommends places to see, eat and do from Wikivoyage, OpenStreetMap and the web, then offers to plan the day. `places {route, places: [{name, why, what, hours, price, lat, lng, km, photo, source}]}` are the places it shows as cards (any mode): only places a tool read for that message, each with a Wikimedia Commons `photo` (`{url, thumbUrl, title, credit, sourceUrl}`, shown with its credit) when one was found and `km` from the stay; `route: true` means in the order to go. `sources [{title, url}]` are the web pages it read. Rico reads the trip through tools (`reads` says what it looked at, such as "Read your day"). `ask {question, options}` is a question with answers to tap. `proposal` is one card holding every change it would make: `{proposalId, steps: [{stepId, tool, kind, label, detail, icon, args, costInr, refundInr, topUpInr, auto}], totalCostInr, final, expiresAt}`. A `server` step changes the trip; a `phone` step (theme, voice, a screen, a "running late" message) is done by the app, which gets its `args`. Nothing changes until `POST /v1/roo/proposals/:id/execute`. That runs the server steps in order through the same API and returns `{state: done|partial|failed, steps: [{stepId, status, message}], phone, summary, canUndo}`. It stops at the first step that fails, and a ride whose fare has risen more than 20% since the card stops it too. It answers 409 `ALREADY_DONE`, `IN_PROGRESS`, or `STALE` when the day's tasks or fixes on offer changed since the card was made, and 404 after 15 minutes or for anyone else. `POST /v1/roo/proposals/:id/undo` takes a card back: it cancels the rides it booked, removes tasks it added, reverts its edits and restores the plan from before. `GET /v1/roo/proposals/:id` shows a card while it's kept. The agent has its own limit per traveller: `ROO_AGENT_PER_MINUTE` (8) messages a minute and `ROO_AGENT_PER_DAY` (200) a day, then 429. 503 `UNAVAILABLE` means Gemini can't answer, and the phone answers instead.

## Accounts, the wallet and flights

- `GET /v1/auth/options` (no sign-in needed) says which ways in the server offers: `{demoLogin, google, passwordReset}`. The home page shows Use the demo account only when `demoLogin` is true, and "Forgot your password?" only when `passwordReset` is (the server sends email: `SMTP_HOST`).
- `POST /v1/auth/signup {name, email, password}` creates an account (201, the same `TokenOut` as the other sign-ins, and the refresh cookie), and emails a link to confirm the address. A taken email is 409 `EMAIL_TAKEN`. `POST /v1/auth/login {email, password}` signs in; any failure is 401 "Email or password is wrong."

### Looking after an account

| Call | What it does |
|---|---|
| `POST /v1/auth/password/forgot {email}` | 202 whether or not an account has that email (it never says which exist), and emails that account a link to `/reset-password#token=…`: one hour, once. At most one a minute and 5 a day per account. 503 `EMAIL_OFF` when the server sends no email |
| `POST /v1/auth/password/reset {token, password}` | 204. Sets the password, confirms the email (the link reached it) and **signs out everywhere**: every refresh token is revoked and every access token issued under the old password is refused at once (they carry a `pwd` stamp). An unknown, used or expired link is 400 `LINK_INVALID` |
| `POST /v1/auth/email/verify {token}` | 204: confirms the address from the link in the email (`/verify-email#token=…`, 3 days, once) |
| `POST /v1/me/verification-email` | 202: sends that link again. 409 `ALREADY_VERIFIED`, 429 within a minute of the last, 503 `EMAIL_OFF` |
| `PATCH /v1/me {name}` | Changes the name (`UserOut`). The demo accounts' is fixed (409 `DEMO_ACCOUNT`) |
| `POST /v1/me/password {currentPassword, newPassword}` | A new `TokenOut` for this sign-in; every other sign-in ends. A wrong current password is 403 `WRONG_PASSWORD`; a Google-only account is 409 `NO_PASSWORD` (it can set one with "Forgot your password?") |
| `GET /v1/me/export` | A JSON file of everything kept about the account: profile, trips with their tasks, plans, check-ins, bookings, share links and Reroute log, places, wallet, phones for alerts, live sign-ins and location history. Never a password, token or hash |
| `POST /v1/me/delete {password}` (or `{email}` for a Google-only account) | 204: deletes the account and everything kept with it, after asking Raasta to delete the rider's recorded rides and unlink the rest (`DELETE /v1/raasta/me`, as the traveller) and deleting the location history. If Raasta or MongoDB can't be reached, nothing is deleted (503). A place other travellers' trips go to, or one a moderator approved for everyone, stays without its owner or note. The demo accounts can't be deleted |

`UserOut` says `emailVerified` and `hasPassword`, and `features.email` whether the server sends email. Email links carry their token after `#`, which browsers never send to a server or pass on as a Referer; the page posts it.
- `GET /v1/wallet` gives `{balanceInr, entries}`; `POST /v1/wallet/topups {amountInr}` (100 to 50,000) adds simulated money. Both need `SIMULATED_SERVICES`, like bookings, and `features.wallet` says so.
- `GET /v1/airports` lists the airports; `GET /v1/trips/:id/flight-options?from=BLR&to=DEL&date=2026-10-15` the sample flights. Book one with `POST /v1/trips/:id/bookings {kind: "flight", origin, flightTo, flightDate, flightNo, cabin, passengers}`.
- Every booking is paid from the wallet: too little money is 409 `INSUFFICIENT_FUNDS`, saying how much to add.
