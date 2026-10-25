# Testing Reroute by hand

A walk through every feature, with what should happen at each step. Use it before a demo or an evaluation, and after any change the automated tests don't cover by eye.

## What a real account can and can't do

The demo account is a prepared day on a simulated clock. A real account is an ordinary traveller on the real clock. Checked on 22 October 2026 against the local stack:

| | Demo account | Real account |
|---|---|---|
| Sign in | **Use the demo account**, shown only with `DEMO_LOGIN=true` in `.env` (off by default) | **Create account** with a name, email and password on the home screen, or **Continue with Google** once Google is set up (below). Trips are kept with the account. |
| First visit | The sample day | **Rico, full screen**, introduces itself and sets up the first trip by chatting, then plans it |
| Cities | Bengaluru | **Any city or town in India**, typed by name (slips are fine: "bengluru", "Gurgaon"), like Rajpura with Chitkara University. Outside Bengaluru, travel is rough cab and walking times |
| Travel options | Metro, shared autos, walks and cabs from the sample travel-time file | Places you search for get **a rough cab estimate**, and a walk under 1.5 km, from the straight-line distance, marked "Rough estimate". No metro or shared auto until real routing data is set up (below). |
| Clock | Simulated: the **Simulate** panel moves time on | Real time. The Simulate panel is shown only to the demo account, so testing "running late" means reporting a delay at the real time. |
| Bookings (train, flight, cab) and the wallet | Simulated, ₹5,000 to start, every partner connected | Simulated too while `SIMULATED_SERVICES` is on (the default; off in production): ₹2,000 to start, partners to connect in Me |
| Morning planning | Not for the sample dates | Works: each later day of a multi-day trip is planned from 06:00 local time |
| Everything else | Works | Works: planning, running late, options, Undo, skip, move, Why this plan?, Rico, Raasta, share, summary, offline, alerts |

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

4. Open https://localhost: **Continue with Google** on the home page now works. Without the client ID it stays greyed out, with "Google sign-in isn't set up on this server yet."

### Optional: the AI helper

`GEMINI_API_KEY` is already set in `.env`, but the helper is off. Add `AI_HELPER_ENABLED=true` to `.env` and run `docker compose up -d`. That turns on **Describe your day**. With the key it also turns on Rico's agent: Rico answers what its built-in rules can't understand, and can do several things from one message, on one card you confirm.

### Optional: Rico's voice from Azure

Rico speaks through Microsoft Edge's free read-aloud service. To use Azure AI Speech instead (Microsoft's official service, with the same voices), create a **Speech** resource in the [Azure portal](https://portal.azure.com) on the **Free F0** tier (0.5 million characters a month). Open its **Keys and Endpoint** page and add the key and region to `.env`:

```
AZURE_SPEECH_KEY=<KEY 1>
AZURE_SPEECH_REGION=centralindia
```

Then run `docker compose up -d`. **Hear Rico** in Me now speaks through Azure. If Azure can't answer (a wrong key, or the free tier's limits), Edge's service reads the line instead.

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

### Landing page, accounts and meeting Rico

| Step | Account | What should happen |
|---|---|---|
| Open https://localhost signed out | | The landing page: "Running late? We'll reroute your day." with a live demo beside it |
| In the demo, choose **15 min**, then **40 min**, then **Keep it cheap** | | 15 min: the times move by themselves (bank 12:40). 40 min: two fixes appear; a cab keeps everything for +₹350, keeping it cheap moves the office to tomorrow at 10:00 |
| **Use the demo account** | D | Today opens with the Bengaluru sample trip |
| **Create account** with a name, an email and a password of 8 or more | R | Rico pops up to say hello, then **/welcome**: Rico, full screen, introduces itself |
| Chat with Rico: Bengaluru, From today, Just that day, search your hotel, then a task (what, where, any time, how long), then **That’s all, plan my day** | R | "Your day is planned!" with when you leave and get back; **Show my day** opens Today |
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
| **Start a new trip** → city: scroll to **Or choose from the list** | R | Every city on the list, by state; picking one (Pune, say) goes straight on, with no wait for a lookup |
| Place search: **Not here? Add it as your own place** | Both | **Add a place** opens: a name, a kind, a note and a pin; saved, it's picked at once and comes first in your searches, marked as yours |

### Today

| Step | Account | What should happen |
|---|---|---|
| Look at the Next card and the timeline | Both | Leave-by time with a countdown, the mode chain, fare and arrival; the day as a transit line with a yellow Now line |
| Click a leg (desktop) or tap it (phone) | Both | Desktop: the map and directions on the right. Phone: the leg detail screen with stands, directions and fare |
| **I've left** | Both | Toast "On your way…"; the main button becomes **Mark done** |
| **Mark done** | Both | The stop turns green with a tick, Rico celebrates, and a toast offers **Undo** for 5 seconds |
| **Mark done** more than 10 minutes before a stop starts | Both | It asks first |
| **Simulate → Next departure / +15 min** | D | The clock moves on; the Now line and countdown follow |
| **Simulate → Simulate the ride to the meeting** | D | A dot moves along the road on the map, then "You've arrived" |
| Today's map after planning | Both | Each leg runs along real roads, and the metro along its line with a dot at each station. While the worker is still drawing, a leg is a straight dashed line with the note "Dashed: approximate route" |
| **Turn by turn** on the leave card, then **Follow my location** (or Simulate the ride) | Both | The next instruction, large, with the distance to it. Every step is listed, and the current one is highlighted. The map follows you. **Speak turns** reads them out in the phone's voice. **Open in Google Maps** opens the same leg in Google Maps |
| Press and hold a leg's map (right-click with a mouse), or the round add button under the zoom | Both | **Add a place** with the pin where you pressed; once saved it's a blue pin, and tapping it says who sees it, with Delete |
| **Book a cab** (next leg), Rico's **Book my ticket** for the train | Both (demo server) | Simulated booking sheets; a ride with a driver and OTP, a ticket with a PNR. Nothing is charged |

### Running late (the core)

| Step | Account | What should happen |
|---|---|---|
| **Simulate → Current time 10:55**, then **Running late → About 15 min → Update my times** | D | Everything still fits: later stops move 15 minutes (12:40, 15:55, back 17:05), with a banner and **Undo** |
| **Undo** | Both | "Your earlier plan is back" |
| **Running late → About 40 min** | D | "Choose how to fix your day": **Take a cab to the bank** (+₹350) or **Keep it cheap** (the office moves to tomorrow at 10:00) |
| Choose one, then **Undo** | D | The day re-routes with the split-flap times, then comes back |
| On your own trip, **Running late** with any delay | R | The same rules at the real time: a shift if it fits, options if it doesn't |
| **Simulate → Current time 08:45**, then **Running late → About 40 min** (still at the hotel) | D | The 10:00 meeting can't be reached in time, and it isn't yours to move: **Go anyway, about 25 min late** ("You reach the meeting at about 10:25; it starts at 10:00"). Choose it: Today says "You'll reach the meeting at about 10:25, 25 min after its 10:00 start" with **Tell them** |
| **Tell them** (or ask Rico "tell them I'm late") | Both | A message with your arrival time, to change and send by WhatsApp, SMS or the phone's share sheet. Reroute sends nothing itself |
| Running late so far that you'd miss the whole meeting | Both | No "skip" or "edit": **Tell them** (a message asking for another time), or **It moved: change the time** if the host really moved it |

### Change the day

| Step | Account | What should happen |
|---|---|---|
| Tap a stop → edit its length or time → save | Both | "Re-planning…", then the new times play on the timeline, with Undo |
| Skip a task (stop sheet) | Both | "Day rerouted. Later stops moved up." |
| Move a task to tomorrow (Plan or the not-in-plan card) | Both | Today re-plans without it; it shows under Tomorrow |
| **Why this plan?** (Today or Plan) | Both | Your day beside "cabs door to door" and "no cabs", how Reroute chose, and every way for each leg with its points |

### Rico

| Step | Account | What should happen |
|---|---|---|
| Watch Rico on the Now line | Both | It breathes, blinks, glances about, follows the mouse; near a departure it says "Leave in 8 min…" by itself |
| Tap Rico (or **Ask Rico** in the desktop top bar) | Both | The chat opens and Rico greets you by name with where the day stands |
| Type "what's next?" | Both | The next departure and arrival |
| "I'm 20 minutes late" | Both | Running late opens with 20 filled in |
| "move the bank to tomorrow" → **Move it** | Both | A card first; after the tap, "Done. The bank is on Thursday now…" and the timeline re-routes |
| "undo that" → **Undo it** | Both | The earlier plan comes back |
| "make the meeting 2 hours", "move the office to 3", "skip the office" | Both | A card each; **Not now** leaves the day as it is |
| "plan my day again", "how's my day?", "dark mode", "mute" | Both | Re-plan card; a summary with a link; the theme changes; voice alerts off |
| "hey i wanna re plan" | Both | "What’s changed?" with answers; A task changed, then which, then what (time, length, move, skip), ending in a card |
| "create an entire new plan" | Both | "Are you sure?" Adjust this plan, Start a new trip (Rico sets it up), or Never mind |
| "what's my balance?", "add 1000 to my wallet", "book a flight to Delhi" | Both (demo server) | The balance; a card to add the money; the flight sheet with Delhi chosen |
| The mic button (Chrome or Edge), say "what's next" | Both | Rico listens and answers on screen. The chat never reads aloud: that's **Talk** |
| The green voice button in the chat (where Send is while the box is empty; the AI helper and the key) | Both | Rico pops up full screen with a sound, just him and a glow: "Listening…" (the glow breathes), "Hearing you…" the moment you speak (a ring rides your voice), "Thinking…" (a turning ring) and "Rico is talking" (his mouth moves, the ring rides his voice). Ask "when do I leave?" and he answers within a fifth of a second of you stopping; talk over him and he stops. **Mute**, **Captions** and the red **End** work; asking him to change the day brings up his card, and nothing changes until **Do it**. On the emulator, give it your microphone first (README, the Android app) |
| The glasses button in the chat header (the AI helper and the key) | Both | Rico puts on his guide glasses, here and everywhere he shows, and asks "Shall I recommend places to see, eat and do, or do you have some in mind?". **Recommend places** gets real ones (he says he read the Wikivoyage guide and looked on the map); "plan my whole day, tickets and all" puts the visits and entry tickets on one card. After **Do all** the tickets are under **Plan → Bookings**: open one for the ticket, with **Cancel the tickets**. Tap the glasses again and he takes them off |
| Plan, Raasta or Me | Both | A small Rico wanders along the bottom, naps after a while, giggles when tapped and asks "Hi! Need me?". **Me → Rico walks with you** turns him off |
| In the Android app: answer Rico's offer as the app opens, "Want to call me hands-free?", with **Turn it on** (it opens Me, downloads Rico's ear once and turns it all on), or turn on **Me → "Hey Rico"** yourself; then say "Hey Rico" | Both | Rico pops up talking. With **Even when Reroute is closed** on, a "Rico is listening" notification stays while you use other apps, and saying his name shows "I'm here! Tap to talk.", which opens him talking. With **Pop up over other apps** on (allow "Display over other apps" when Android asks), say it while in another app: a card pops up at the bottom with Rico waving and a moving voice line, and a moment later Reroute opens on him talking, no tap |
| With the AI helper on: "can the bank wait till Thursday?" | Both | Rico understands free wording and still asks before changing anything |
| With the AI helper and the key: "skip the university office, book a cab to the bank and go dark" | Both | Rico says what it looked at, then shows one card: *Rico will do 3 things*. Nothing changes until **Do all**. Then each step gets a tick, the ride is booked, dark mode comes on, and **Undo** puts it all back |

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
| **Summary** (Rico's "How's my day?" or the end of the day) | Both | Tasks done, the mini line, the expense slip; **Download the slip** and **Share with my office** |
| **Me**: Language हिन्दी, Theme Light/Dark/System | Both | The interface switches language and theme at once |
| **The sun or moon button** (home page, Rico's welcome, the desktop top bar, Today's header on a phone) | Both | Light and dark swap with a short cross-fade; the choice stays after a reload, with no flash of the other theme |
| **Me → Alerts**: sound, chime, Rico's voice, **Hear Rico**, volume, vibration, phone notifications | Both | **Hear Rico** speaks; notifications ask for permission once |
| Rico in 3D: open /welcome or Ask Rico on a laptop or a recent phone | Both | A fuzzy plush 3D Rico breathes, blinks, follows the pointer and hops on each line; the Ask Rico button and the "Welcome back!" greeting show the same Rico. Beside each of Rico's lines in the chat, and everywhere with reduced motion, Save-Data or a slow GPU, a still of the same 3D Rico shows instead, never a flat one (force either with `localStorage['reroute.roo3d']` = `on` or `off`) |
| Turn on **Rico reads its replies aloud** (Me) and open /welcome | Both | Each line plays to its end before the next; the words appear as they're said; Rico's mouth closes on b, m and p and between words |
| Android app with Firebase set up (README, "Push notifications"): **Me → Phone notifications** on, plan the day, **Simulate** the clock to 9 minutes before the first departure, go to the home screen and open two other apps, then **Simulate → Run the 5-minute check** from a browser signed in to the same account | D | "Leave in 9 min." arrives as a phone notification although Android has frozen Reroute; tapping it opens Today |
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
| Windows: Settings → Accessibility → Visual effects → Animation effects off | Rico, the pulse and the re-route choreography stop moving; everything still works |
| A screen reader (NVDA) on Today and in Rico's chat | Every button named; Rico's messages announced |

## The automated tests

| Command | What it checks |
|---|---|
| `cd backend && pytest` | Planner rules, the golden day, Rico's checks; with `TEST_DATABASE_URL` (a throwaway PostGIS, never the stack's database) the whole API |
| `cd raasta && pytest` | Ride trimming, matching, fares, moderation, freshness |
| `cd frontend && pnpm test` | The timeline model, Rico's understanding, voice, the offline queue |
| `npx newman run postman/reroute.postman_collection.json --insecure` | The demo day over HTTP, against the running stack |
| `cd frontend && E2E_BASE_URL=https://localhost pnpm e2e` | Every flow above that can be scripted, on a phone and a desktop, with axe accessibility checks in light and dark. Run it with `AUTH_RATE_LIMIT_PER_MINUTE=1000 RATE_LIMIT_PER_MINUTE=1000 docker compose up -d` first, then `docker compose up -d` after |
| `cd frontend && pnpm exec playwright test -c playwright.android.config.ts` | The Android app against the web app: the same journeys inside the installed debug APK on an emulator or a phone, plus Android's share sheet, the Maps app, the back button, the bars and a leave-by notification in the background. Fails on any console error or any error in the app's own Logcat. Needs the stack the APK was built for, with `DEMO_LOGIN=true` (see the README's Android section) |
