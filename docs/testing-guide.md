# Testing Reroute by hand

A walk through every feature, with what should happen at each step. Use it before a demo or an evaluation, and after any change the automated tests don't cover by eye.

## What a real account can and can't do

The demo account is a prepared day on a simulated clock. A real account is an ordinary traveller on the real clock. Checked on 22 October 2026 against the local stack:

| | Demo account | Real account |
|---|---|---|
| Sign in | **Use the demo account**, shown only with `DEMO_LOGIN=true` in `.env` (off by default) | **Create account** with a name, email and password on the home screen, or **Continue with Google** once Google is set up (below). Trips are kept with the account. |
| First visit | The sample day | **Roo, full screen**, introduces itself and sets up the first trip by chatting, then plans it |
| Cities | Bengaluru | **Bengaluru only.** Any other city answers "Reroute doesn't cover that city yet." |
| Travel options | Metro, shared autos, walks and cabs from the sample travel-time file | Places you search for get **a rough cab estimate**, and a walk under 1.5 km, from the straight-line distance, marked "Rough estimate". No metro or shared auto until real routing data is set up (below). |
| Clock | Simulated: the **Simulate** panel moves time on | Real time. The Simulate panel is shown only to the demo account, so testing "running late" means reporting a delay at the real time. |
| Bookings (train, flight, cab) and the wallet | Simulated, ₹5,000 to start, every partner connected | Simulated too while `SIMULATED_SERVICES` is on (the default; off in production): ₹2,000 to start, partners to connect in Me |
| Morning planning | Not for the sample dates | Works: each later day of a multi-day trip is planned from 06:00 local time |
| Everything else | Works | Works: planning, running late, options, Undo, skip, move, Why this plan?, Roo, Raasta, share, summary, offline, alerts |

A real Bengaluru day was tried end to end through the API: a trip for today staying in Indiranagar, with a fixed meeting at Phoenix Marketcity, Cubbon Park and Lalbagh. It planned, re-planned after a 20-minute delay, and answered Why this plan? and the summary. Every leg was a rough cab estimate (₹1,150 for the day), as the table says.

### Turn on Google sign-in (for real accounts)

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project, then under **APIs & Services**:
   - **OAuth consent screen**: External, in Testing, and add your Gmail address (and your evaluators') as **test users**.
   - **Credentials → Create credentials → OAuth client ID → Web application**. Under **Authorized JavaScript origins** add `https://localhost` and `http://localhost:5173`. No redirect URI is needed: sign-in uses a pop-up.
   - For Calendar import, also enable the **Google Calendar API**.
2. Add these two lines to the `.env` file at the repository root:

   ```
   GOOGLE_CLIENT_ID=<your client ID>
   GOOGLE_CLIENT_SECRET=<your client secret>
   ```

3. Rebuild, because the web app reads the client ID when it is built:

   ```bash
   docker compose up -d --build
   ```

4. Open https://localhost: **Sign in with Google** now shows under the demo button.

### Optional: the AI helper

`GEMINI_API_KEY` is already set in `.env`, but the helper is off. Add `AI_HELPER_ENABLED=true` to `.env` and run `docker compose up -d`. That turns on **Describe your day**. It also lets Roo answer messages its built-in rules can't understand.

### Optional: real road times

`TRAVEL_TIMES_SOURCE=osrm` and `docker compose --profile routing up -d --build` download and prepare a map of the region (a large download that takes a while the first time). Every leg between searched places then gets road times for cabs and walking. Metro legs need a timetable file (`examples/bengaluru/metro.json`) that isn't supplied yet. Shared autos come from verified Raasta routes.

### Another city

Adding a city needs:

- an entry in `backend/app/cities.py` and `raasta/app/cities.py` (its name, time zone and map bounds);
- its cab fares;
- ideally, road data (OSRM) and Raasta routes.

Until then a city simply isn't offered.

## Before each session

- The demo account is off unless you switch it on: add `DEMO_LOGIN=true` to the `.env` file at the repository root and run `docker compose up -d`. Without it the home page offers only Create account, Sign in and Google.
- Run `docker compose up -d` and open https://localhost. Accept the certificate warning once.
- With the demo account, **Simulate → Reset the demo** puts the sample day back.
- To try the phone layout on a PC, open the browser's device toolbar (F12, then Ctrl+Shift+M) at 390 × 844.

## Feature by feature

Each row says which account to use (**D** for demo, **R** for real, **Both**).

### Landing page, accounts and meeting Roo

| Step | Account | What should happen |
|---|---|---|
| Open https://localhost signed out | | The landing page: "Running late? We'll reroute your day." with a live demo beside it |
| In the demo, choose **15 min**, then **40 min**, then **Keep it cheap** | | 15 min: the times move by themselves (bank 12:40). 40 min: two fixes appear; a cab keeps everything for +₹350, keeping it cheap moves the office to tomorrow at 10:00 |
| **Use the demo account** | D | Today opens with the Bengaluru sample trip |
| **Create account** with a name, an email and a password of 8 or more | R | Roo pops up to say hello, then **/welcome**: Roo, full screen, introduces itself |
| Chat with Roo: Bengaluru, From today, Just that day, search your hotel, then a task (what, where, any time, how long), then **That’s all, plan my day** | R | "Your day is planned!" with when you leave and get back; **Show my day** opens Today |
| Create an account again with the same email | | "An account with this email already exists. Sign in instead." |
| **Sign in** with a wrong password | | "Email or password is wrong." |
| **Continue with Google** | R | Google's pop-up (only once Google is set up; otherwise the button says it isn't) |
| **Me → Sign out** | Both | Back to the landing page; the phone forgets the trip and any queued actions |

### Start a trip

| Step | Account | What should happen |
|---|---|---|
| **Plan → Start a new trip**: search where you stay (try "Indiranagar"), pick dates | R | The trip is created; Plan shows the city, dates and hotel |
| **Add a task**: title, place (search), length, then *fixed time*, *opening hours* or *any time*, and *must do / should do / if there's time* | Both | The task appears under its day with tags (Fixed 13:00, Open till 16:00, Must do) |
| **Plan my day** | Both | "Planning your day…", then Today with the route. On the demo day: leave 08:50, meeting 10:00, bank 12:25, office 15:40, back 16:50 |
| A task that can't fit (two fixed times too close) | Both | Today lists it under "isn't in today's plan" with the reason, and offers **Move to Thursday** |
| **Plan → Your trips** | Both | Switch between trips |

### Today

| Step | Account | What should happen |
|---|---|---|
| Look at the Next card and the timeline | Both | Leave-by time with a countdown, the mode chain, fare and arrival; the day as a transit line with a yellow Now line |
| Click a leg (desktop) or tap it (phone) | Both | Desktop: the map and directions on the right. Phone: the leg detail screen with stands, directions and fare |
| **I've left** | Both | Toast "On your way…"; the main button becomes **Mark done** |
| **Mark done** | Both | The stop turns green with a tick, Roo celebrates, and a toast offers **Undo** for 5 seconds |
| **Mark done** more than 10 minutes before a stop starts | Both | It asks first |
| **Simulate → Next departure / +15 min** | D | The clock moves on; the Now line and countdown follow |
| **Simulate → Simulate the ride to the meeting** | D | A dot moves along the road on the map, then "You've arrived" |
| **Book a cab** (next leg), Roo's **Book my ticket** for the train | Both (demo server) | Simulated booking sheets; a ride with a driver and OTP, a ticket with a PNR. Nothing is charged |

### Running late (the core)

| Step | Account | What should happen |
|---|---|---|
| **Simulate → Current time 10:55**, then **Running late → About 15 min → Update my times** | D | Everything still fits: later stops move 15 minutes (12:40, 15:55, back 17:05), with a banner and **Undo** |
| **Undo** | Both | "Your earlier plan is back" |
| **Running late → About 40 min** | D | "Choose how to fix your day": **Take a cab to the bank** (+₹350) or **Keep it cheap** (the office moves to tomorrow at 10:00) |
| Choose one, then **Undo** | D | The day re-routes with the split-flap times, then comes back |
| On your own trip, **Running late** with any delay | R | The same rules at the real time: a shift if it fits, options if it doesn't |

### Change the day

| Step | Account | What should happen |
|---|---|---|
| Tap a stop → edit its length or time → save | Both | "Re-planning…", then the new times play on the timeline, with Undo |
| Skip a task (stop sheet) | Both | "Day rerouted. Later stops moved up." |
| Move a task to tomorrow (Plan or the not-in-plan card) | Both | Today re-plans without it; it shows under Tomorrow |
| **Why this plan?** (Today or Plan) | Both | Your day beside "cabs door to door" and "no cabs", how Reroute chose, and every way for each leg with its points |

### Roo

| Step | Account | What should happen |
|---|---|---|
| Watch Roo on the Now line | Both | It breathes, blinks, glances about, follows the mouse; near a departure it says "Leave in 8 min…" by itself |
| Tap Roo (or **Ask Roo** in the desktop top bar) | Both | The chat opens and Roo greets you by name with where the day stands |
| Type "what's next?" | Both | The next departure and arrival |
| "I'm 20 minutes late" | Both | Running late opens with 20 filled in |
| "move the bank to tomorrow" → **Move it** | Both | A card first; after the tap, "Done. The bank is on Thursday now…" and the timeline re-routes |
| "undo that" → **Undo it** | Both | The earlier plan comes back |
| "make the meeting 2 hours", "move the office to 3", "skip the office" | Both | A card each; **Not now** leaves the day as it is |
| "plan my day again", "how's my day?", "dark mode", "mute" | Both | Re-plan card; a summary with a link; the theme changes; voice alerts off |
| "hey i wanna re plan" | Both | "What’s changed?" with answers; A task changed, then which, then what (time, length, move, skip), ending in a card |
| "create an entire new plan" | Both | "Are you sure?" Adjust this plan, Start a new trip (Roo sets it up), or Never mind |
| "what's my balance?", "add 1000 to my wallet", "book a flight to Delhi" | Both (demo server) | The balance; a card to add the money; the flight sheet with Delhi chosen |
| The speaker button in the chat header | Both | Roo stops (or starts) reading its replies aloud |
| The mic button (Chrome or Edge), say "what's next" | Both | Roo listens, answers on screen and out loud |
| With the AI helper on: "can the bank wait till Thursday?" | Both | Roo understands free wording and still asks before changing anything |

### Raasta (shared autos)

| Step | Account | What should happen |
|---|---|---|
| **Raasta → Your next leg** card, or search Koramangala → Jayanagar | Both | Verified shared-auto routes with fare, frequency and last trip |
| Open a route | Both | Stands, directions, map, last confirmed |
| **It still runs**, **Report a fare** | Both | Confirmation counted once per rider per day; the fare report waits for a moderator |
| **Add a route** (record a ride or tap points) | Both | Saved as unverified until a moderator or two different riders confirm it |
| Moderation | | The web app has no moderator sign-in button: use the Postman requests **Moderator sign-in** and **Moderator queue** |

### Wallet, connected services and flights

| Step | Account | What should happen |
|---|---|---|
| **Me > Wallet** | Both | The balance and its latest entries; **Add money** with a chip or an amount, then a tick and the new balance |
| **Me > Connected services > Connect** a partner | R | A consent sheet, "Connecting…", then Connected; **Disconnect** undoes it |
| **Plan > Book a flight**: Find flights, choose a fare, a passenger, Review and pay | Both | The pay step says what the wallet has after; too little, and it says how much to add with **Add money** right there |
| Pay | Both | A boarding pass with a PNR and seats; the wallet shows the charge; **Cancel the flight** refunds all but ₹500 |
| Book a cab or train with its partner disconnected | R | The sheet asks to connect RideNow or RailGo first |

### Share, summary, settings

| Step | Account | What should happen |
|---|---|---|
| **Share** (Today header) → copy the link → open it in a private window | Both | Family view: stops and progress, never your exact location; nothing can be changed |
| **Simulate → Expire share links** | D | The family link says it has ended |
| **Summary** (Roo's "How's my day?" or the end of the day) | Both | Tasks done, the mini line, the expense slip; **Download the slip** and **Share with my office** |
| **Me**: Language हिन्दी, Theme Light/Dark/System | Both | The interface switches language and theme at once |
| **The sun or moon button** (home page, Roo's welcome, the desktop top bar, Today's header on a phone) | Both | Light and dark swap with a short cross-fade; the choice stays after a reload, with no flash of the other theme |
| **Me → Alerts**: sound, chime, Roo's voice, **Hear Roo**, volume, vibration, phone notifications | Both | **Hear Roo** speaks; notifications ask for permission once |
| **Me → Reroute log** | Both | Every plan and change with its reason |
| **Me → Delete my location history** | Both | Confirms, then deletes |

### Offline and reliability

| Step | Account | What should happen |
|---|---|---|
| **Simulate → Go offline**, then **Mark done** | D | "Marked done. It syncs when you're back online." The check-in waits on the phone |
| Turn offline off | D | The queued check-in is sent once; the day updates |
| With the local certificate trusted (mkcert, see the README): DevTools → Network → Offline, then reload | Both | The day still shows from the phone's copy, and maps say they need a connection. On the untrusted certificate browsers won't install the offline worker: use **Go offline** instead |
| **Simulate → Run the 5-minute check** | D | The server's automatic check runs now (it normally runs every 5 minutes) |

### Desktop and accessibility

| Step | What should happen |
|---|---|
| At 1366 and 1920 wide: Today, Plan, Why, Raasta, Leg detail, Summary, Me | Two-column layouts; nothing stretched or empty |
| Keyboard only: Tab through Today, open Running late with Enter, Escape closes | Visible focus everywhere; focus returns to the button |
| Windows: Settings → Accessibility → Visual effects → Animation effects off | Roo, the pulse and the re-route choreography stop moving; everything still works |
| A screen reader (NVDA) on Today and in Roo's chat | Every button named; Roo's messages announced |

## The automated tests

| Command | What it checks |
|---|---|
| `cd backend && pytest` | Planner rules, the golden day, Roo's checks; with `TEST_DATABASE_URL` (a throwaway PostGIS, never the stack's database) the whole API |
| `cd raasta && pytest` | Ride trimming, matching, fares, moderation, freshness |
| `cd frontend && pnpm test` | The timeline model, Roo's understanding, voice, the offline queue |
| `npx newman run postman/reroute.postman_collection.json --insecure` | The demo day over HTTP, against the running stack |
| `cd frontend && E2E_BASE_URL=https://localhost pnpm e2e` | Every flow above that can be scripted, on a phone and a desktop, with axe accessibility checks in light and dark. Run it with `AUTH_RATE_LIMIT_PER_MINUTE=1000 RATE_LIMIT_PER_MINUTE=1000 docker compose up -d` first, then `docker compose up -d` after |
