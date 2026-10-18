# Reroute: UI build brief for an AI design and code agent

## 0. Your role and what to deliver

You are a senior product designer and front-end engineer. Build the complete frontend for **Reroute** as working React code: real components with real states, not static mockups. Use the fixture data in section 13 so every screen works without a backend. Before you call it done, check every screen against section 16. If you can run the app in a browser, screenshot each screen at 390×844 and 1280×800 in light and dark mode; if you can't, review each screen's code against it.

## 1. The product

Reroute is a travel companion for people on work trips to an unfamiliar Indian city. The traveller enters their tasks (a meeting at 10:00, a bank visit before 16:00, an office that closes at 17:00). Reroute plans the day: the order, when to leave, how to travel and what it costs. It guides the traveller through the day and re-plans it automatically when they run late. When something has to give, it offers 2 or 3 explained options and lets the traveller choose.

Its **Raasta** module supplies shared-auto and e-rickshaw routes (the stand, fare, how often they come, the last trip) that no other app has.

Tagline: *Running late? We'll reroute your day.*

## 2. Who uses it, and where

- A phone in one hand, outdoors, often in sunlight, walking to an auto stand, short on time and a little anxious.
- Patchy mobile data. Once a plan is loaded, it must keep working offline.
- Users range from students to senior professionals; many are not tech-savvy. English and Hindi.
- The screen must answer four questions in under 2 seconds: what now, when do I leave, how do I get there, what will it cost.

## 3. UI type (decided)

- **Mobile-first installable PWA**, designed at 390×844 first, working down to 320 px.
- **Bottom tab bar** with four tabs: Today, Plan, Raasta, Me. No hamburger menu.
- **Bottom sheets** for actions on mobile (Running late, Share, Add a task); centred dialogs on desktop.
- **Large screens (1024 px and up):** two panes. The timeline sits on the left (420 px) and the map with leg detail on the right. A top bar replaces the bottom tabs.
- **Between 600 and 1023 px:** keep the phone layout, centred and at most 560 px wide.
- **Moderator queue:** desktop-first (a table with a side panel); on mobile it becomes a list with a detail view.
- **Family view:** a public read-only page at `/shared/:token` with no navigation.

## 4. Design concept: your day is a transit line

Every trip is drawn like a metro line diagram. Stops are stations, legs are line segments coloured by how you travel, and the current moment is a yellow Now bar.

The visual language comes from classic railway timetables and metro maps, plus the colours of Indian street transport: auto-rickshaw green, canopy yellow and signal red.

"Premium" here means precision and calm: generous space, times aligned in one fixed column, tabular numbers, and one accent at a time.

**The one memorable thing:** when the day changes, the line physically re-routes. Everything around it stays quiet and disciplined.

## 5. Frontend stack

- React 19 with Vite and TypeScript (strict mode).
- Tailwind CSS v4, with every token defined as a CSS variable in `@theme`. Components never contain raw hex values.
- Radix UI primitives for Dialog (and the sheet), Popover, Tabs, Toast, Toggle Group and Tooltip, so accessibility is built in.
- If your environment starts from shadcn/ui, you may use its Radix-based components, but restyle every one with these tokens. The default shadcn look must not show anywhere.
- Motion (formerly Framer Motion, imported from `motion/react`) for animation; plain CSS transitions for simple hovers and colour changes.
- `lucide-react` icons, plus 2 custom SVG icons (section 6.4).
- MapLibre GL JS with free OpenStreetMap vector tiles (for example OpenFreeMap) and a custom muted map style.
- TanStack Query for data, React Router for routes, and a small i18n layer for English and Hindi.
- `vite-plugin-pwa` for installing the app and offline caching.
- Playwright with axe for checks.

## 6. Design tokens

### 6.1 Colour

Light theme (the default):

| Token | Hex | Use |
|---|---|---|
| `--ground` | #EDF0EB | App background (the "platform") |
| `--surface` | #FFFFFF | Sheets, cards, bars |
| `--surface-sunken` | #E3E8E1 | Segmented-control tracks, the offline pill |
| `--line` | #D5DBD3 | Hairlines, borders and skeleton blocks |
| `--line-strong` | #AEB7AE | Dividers and dashed rules |
| `--ink` | #1A2230 | Main text, cab legs, station rings |
| `--ink-2` | #3D4757 | Secondary text |
| `--muted` | #566173 | Places, notes, captions (still at least 4.5:1) |
| `--green` | #0B7A4B | Shared auto, e-rickshaw, Raasta, primary buttons |
| `--green-ink` | #0A5C39 | Green text on tints |
| `--green-tint` | #DCEFE4 | Success and "fits" backgrounds |
| `--yellow` | #F2C12E | ONLY "Now" and "just changed" |
| `--red` | #C8102E | Late, blocked, destructive |
| `--red-ink` | #9E0C24 | Red text |
| `--red-tint` | #FBE3E6 | Late backgrounds |
| `--blue` | #2D5BD0 | Metro and bus legs |
| `--blue-tint` | #E3EAFB | Metro tags |
| `--focus` | #2D5BD0 | Focus ring |
| `--on-green` | #FFFFFF | Text and icons on green |
| `--on-ink` | #FFFFFF | Text and icons on ink (tags, toast, done stations) |
| `--on-yellow` | #1A2230 | Text and icons on yellow |

Dark theme ("night travel"; follows the system setting, with a manual switch):

| Token | Hex |
|---|---|
| `--ground` | #10161F |
| `--surface` | #18202B |
| `--surface-sunken` | #0C1118 |
| `--line` | #2A3442 |
| `--line-strong` | #3B4757 |
| `--ink` | #EEF1EC |
| `--ink-2` | #C3CBD5 |
| `--muted` | #9AA5B3 |
| `--green` | #34B27B |
| `--green-ink` | #8FE0B8 |
| `--green-tint` | #12382A |
| `--yellow` | #F2C12E |
| `--red` | #FF5C6F |
| `--red-ink` | #FFB3BC |
| `--red-tint` | #3A141B |
| `--blue` | #7096FF |
| `--blue-tint` | #18264A |
| `--focus` | #7096FF |
| `--on-green` | #10161F |
| `--on-ink` | #10161F |
| `--on-yellow` | #1A2230 |

**Colour rules:**
- Legs by mode:
  - metro and bus: blue
  - shared auto, e-rickshaw and tempo: green
  - cab: ink
  - walking: a dotted ink line
- Colour always comes with an icon and a text label; it never carries meaning alone.
- Yellow is never decoration.
- Red appears only for late, blocked or destructive states.
- Text and icons on a solid green, ink or yellow fill use the matching `--on-*` token; on a tint, use the matching `-ink` colour. When a changed time's yellow highlight fades, its text fades from `--on-yellow` to `--ink` with it.

### 6.2 Typography

- **Display and numbers:** Archivo (variable), `font-stretch: 75%`, weights 700 to 800. Use it for screen titles, times and big money amounts. Times always use `font-variant-numeric: tabular-nums`.
- **Interface and body:** Atkinson Hyperlegible, weights 400 and 700. It was designed for legibility, which suits outdoor use and low-vision users.
- **Hindi:** Noto Sans Devanagari (400 and 700) as the fallback in the same font stack.
- Load all three from one stylesheet, including Archivo's width axis (without `wdth`, `font-stretch: 75%` does nothing):
  `https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..100,600..800&family=Atkinson+Hyperlegible:wght@400;700&family=Noto+Sans+Devanagari:wght@400;700&display=swap`
  Cache the font files in the service worker so they work offline.
- Never use Inter, Roboto, Arial or the system font as the design font. Never use all caps.

| Style | Font | Size / line height | Use |
|---|---|---|---|
| display-1 | Archivo 75%, 800 | 32/34 | Screen titles ("Bengaluru") |
| display-2 | Archivo 75%, 800 | 26/28 | Sheet titles |
| time-lg | Archivo 75%, 700, tabular | 40/40 | The next leave-by time |
| time | Archivo 75%, 700, tabular | 21/24 | Timeline times |
| title | Atkinson 700 | 17/24 | Stop names, option titles |
| body | Atkinson 400 | 16/24 | Body text (minimum 16) |
| small | Atkinson 400 | 14/20 | Places, notes, leg details |
| caption | Atkinson 700 | 13/18 | Pills and tags, in sentence case |

On desktop, add 2 px to the display styles. Archivo display text uses -0.01em letter spacing; Atkinson stays at 0.

### 6.3 Space, size, radius, elevation

- 4 px base. Steps: 4, 8, 12, 16, 20, 24, 32, 40, 56.
- Side padding: 20 px on mobile, 32 px on desktop. Maximum line length 72 characters.
- Touch targets at least 48×48; primary buttons 52 px tall.
- Radius follows hierarchy, not one value for everything:
  - tags and chips 8 px
  - inputs and buttons 14 px
  - cards and route boxes 16 px
  - top corners of bottom sheets 22 px
  - pills 999 px
- Timeline rows are not cards. They sit on the ground, separated by space and the line.
- Borders are 1 px `--line`; selected items get 2 px `--green`.
- No shadows by default. Only floating layers get one:
  - sheet: `0 -8px 32px rgba(16,22,31,0.18)`
  - toast: `0 8px 24px rgba(16,22,31,0.24)`

### 6.4 Icons

- `lucide-react`, `strokeWidth={1.75}`, 20 px inline and 24 px in navigation, round caps and joins, `currentColor`.
- **Modes:** Footprints (walk), TrainFront (metro), Bus (bus), CarTaxiFront (cab).
- **Two custom icons on the same 24×24 grid with a 1.75 stroke:**
  - **AutoRickshaw:** a three-wheeler silhouette with a canopy.
  - **ERickshaw:** a flat roof with a small lightning bolt.
  - A tempo reuses AutoRickshaw.
- **Everything else:** MapPin (place), Clock (time), IndianRupee (fare), Navigation (start a leg), Share2, Copy, CircleCheck (done), TriangleAlert (behind), Route (rerouted), Ban (blocked), WifiOff (offline), Undo2, Plus, CalendarPlus (import calendar), ShieldCheck (verified route), History (Reroute log), Languages, Sun, Moon, ChevronLeft, X.
- No emoji. An active tab is shown by green colour, its label, and a 3 px indicator.
- **App icon:** a white three-station line with one bend, on `--green`. Ship it as a maskable PWA icon (192 and 512 px) and as the favicon.

### 6.5 Motion tokens

- Durations:
  - `--dur-instant` 90 ms
  - `--dur-quick` 160 ms
  - `--dur-base` 240 ms
  - `--dur-slow` 400 ms
  - `--dur-hero` 900 ms
- Easing:
  - out: `cubic-bezier(0.16, 1, 0.3, 1)`
  - in-out: `cubic-bezier(0.65, 0, 0.35, 1)`
  - in, for exits: `cubic-bezier(0.4, 0, 1, 1)`
- Springs in Motion:
  - sheet: stiffness 420, damping 40
  - selection ring: stiffness 500, damping 38
  - press: scale 0.97 over 90 ms
- Animate only transform, opacity and SVG `pathLength`, at 60 fps. The one exception is the text colour of a changed time while its highlight fades.
- Nothing runs longer than 900 ms, except the signature choreography (about 2 s in total).
- Nothing loops forever, except the Now pulse in the 10 minutes before a leave-by time.

## 7. Components

1. **App shell.** A header with the city in display-1, a date line ("Tuesday 14 October, day 1 of 2") and a status pill. A bottom tab bar, 64 px tall plus the safe area, hidden inside full-screen sheets. No fake phone status bar.
2. **Status pill** (32 px tall inside a 48 px tap area, caption text, icon and words):
   - "On time": green tint, Clock
   - "Behind by 40 min": red tint, TriangleAlert
   - "Rerouted at 10:55": green tint, Route
   - "Offline": sunken, WifiOff
   - "Blocked": red tint, Ban
   Tapping it opens the Reroute log.
3. **Next card.** The leave-by time in time-lg, "Leave for the bank in Koramangala", and the leg summary with mode icons. On `--surface` with a 16 px radius, a 1 px `--line` border and no shadow. In the last 10 minutes the time gets a yellow background and the label becomes "Leave now".
4. **Timeline (the signature).**
   - Three columns: time (56 px), line (24 px), content.
   - Stations are 16 px rings with a 3 px ink border and a `--surface` fill:
     - Now: yellow fill
     - done: ink fill with an `--on-ink` check
     - fixed task: a "Fixed 10:00" tag
     - task with opening hours: an "Open till 16:00" or "Closes 17:00" tag
   - Legs are 6 px line segments in their mode colour:
     - a mixed leg stacks segments in proportion to their minutes
     - walking is dotted
     - each leg shows its mode icons, a label ("Metro, then shared auto"), the duration and the fare
     - a Raasta leg adds a ShieldCheck "Verified" tag, or an "Unverified" tag
   - Tap a leg to open Leg detail; tap a stop to open a task sheet (edit or skip).
   - A 2 px yellow Now bar crosses the timeline at the current time, with a "Now 10:55" pill.
5. **Bottom action bar on Today.** "Running late" (2 px red outline, red-ink text) and "Check in" (solid green), each 52 px tall, side by side, padded for the safe area.
6. **Bottom sheet.**
   - Built on Radix Dialog for focus and screen readers, with Motion handling the spring and the drag, and a drag handle at the top.
   - Springs in over a backdrop of `rgba(16,22,31,0.45)`.
   - At most 88vh tall.
   - Traps focus and returns it on close; Esc and a swipe down both close it.
   - Title in display-2.
7. **Delay chips.** A radio group: "About 15 min", "About 40 min", "About 1 h", and "Other", which opens a number input.
8. **Option card.**
   - A radio card with:
     - a title
     - the cost difference ("+₹350" in red-ink, or "No extra cost" in green-ink)
     - the consequence ("All three tasks still happen today", or "The office visit moves to tomorrow, 10:00")
     - small reason tags such as "Faster by cab"
   - When selected: a 2 px green border and green tint. The selection outline slides between cards using a shared layout animation.
9. **Buttons.**
   - Primary: green fill, `--on-green` text.
   - Secondary: 2 px ink outline.
   - Tertiary: underlined text.
   - Destructive: red outline.
   - Labels are verbs. While waiting, a 16 px spinner and a progress label ("Rerouting…") show inside the button.
10. **Inputs.** The label always sits above the field. 48 px tall, 14 px radius, 2 px border, a 3 px focus ring. Errors appear below in red-ink with a TriangleAlert icon and are linked with `aria-describedby`.
11. **Task list (Plan screen).** Rows inside one `--surface` panel with dividers, not separate cards. Each row has a title, a place and tags:
    - "Fixed 10:00": ink tag
    - "Open till 16:00" or "Closes 17:00": green outline tag
    - duration: grey outline tag
12. **Toast.** An `--ink` background with `--on-ink` text and an Undo button, so it reads as inverted in both themes. Uses `role="status"`, closes after 8 seconds, pauses while hovered or focused, and can be swiped away. After it closes, Undo stays available in the Reroute log.
13. **Map card.**
    - 16 px radius, a muted MapLibre style, and a dark version of that style for the dark theme.
    - Route lines in mode colours with a `--surface` casing.
    - Stands as rings, plus the user's location dot.
    - Written directions always come first; the map is never the only way to follow a route.
14. **Expense slip.**
    - Laid out like a receipt: each leg with its mode, and the fare right-aligned in tabular numbers.
    - A dashed rule before the total, which is set in Archivo 26 tabular.
    - Actions: "Download the slip" and "Share with my office".
15. **Empty states.** No illustrations. A one-line heading, one sentence, and one primary action.
16. **Skeletons.** Static `--line` blocks shaped like the final layout. No shimmer.
17. **Reroute log.** A list of what Reroute did by itself, for example "11:16 Shifted 3 stops by 15 min", each with Undo. It opens from the status pill and keeps the planner's automatic actions transparent.
18. **"Describe your day" (optional AI helper, behind a feature flag).**
    - The traveller types their day in plain words.
    - The parsed tasks appear as editable draft rows, labelled "Drafted from your text. Check before adding."
    - Nothing is saved until they tap "Add these tasks".

## 8. Screens

Every screen needs a loading state (skeleton), an empty state, an error state (inline, with Try again), an offline state, and a blocked state where relevant.

1. **Sign in**
   - The Reroute wordmark in Archivo 75% 800, with a small three-stop line, built from the timeline components, that draws once (600 ms) when the page opens.
   - One sentence: "Plan your work day in a new city. We'll reroute it when you run late."
   - "Continue with Google", following Google's sign-in branding guidelines exactly. This button may keep Google's own font; it is the only exception to section 14.
   - "Use the demo account", shown in local mode only.
2. **Plan your day**
   - Header "New trip", with city and date fields, a "Staying at" field, and the "Your tasks" list.
   - "Add a task" opens a sheet with:
     - a title
     - a place search
     - a duration stepper
     - a timing choice (Fixed time, Opening hours, or Anytime)
     - a priority
   - Also "Import from Google Calendar" and the optional "Describe your day".
   - The primary button "Plan my day" shows "Planning your day…" and the first-reveal line animation, then opens Today.
3. **Today** (home): the header, the Next card, the timeline and the bottom action bar. An offline banner appears when needed. On desktop, the map sits beside the timeline.
4. **Running late** (sheet)
   - Title: "How late will the meeting run?", using the current task's name. Then the delay chips.
   - If the day still fits: a green-tint box, "Your day still fits. Every stop moves 15 minutes later. No extra cost.", and the button "Update my times".
   - If something must give: one explanation line ("The university office closes at 17:00. Choose how to fix the rest of today."), the option cards, and the button "Reroute my day". Below, the text button "Keep the current plan".
   - **Automatic version:** when Reroute shifts the day by itself, show a banner instead of the sheet: "You were 25 min behind. Reroute moved your later stops." with Undo.
5. **Leg detail** (a pushed screen)
   - A back button and the title "Koramangala to Jayanagar", with "Shared auto, about 40 min" beneath it.
   - A short vertical line showing the stands ("Board here", "Get off here, 3rd stop").
   - Numbered directions (a real sequence).
   - Facts: Fare "₹30 a person", How often "About every 10 min", Last one "Around 21:30", Last confirmed "3 days ago, by 4 riders".
   - A Verified tag, and the buttons "It still runs" (secondary) and "Start this leg" (primary). A text link "Report a fare".
6. **Share**
   - A sheet with the "Share live trip" switch, the link with a Copy button, and "Stop sharing".
   - It explains what family will see: your stops and progress, not your exact location.
   - **Family view** (public page): "[Traveller name]'s trip in Bengaluru", a read-only live timeline, and "Updated 2 min ago". No edit controls. A turned-off link shows "This trip is no longer shared."
7. **Day summary**
   - The title "Tuesday in Bengaluru", with "All three tasks done. Rerouted once, at 10:55."
   - A horizontal mini line recapping the stops, a "Done today" checklist, and the expense slip.
8. **Raasta**
   - **Tab home:** "Where from? Where to?" search, nearby stands, and "Add a route". A search result opens a route page that reuses the Leg detail layout.
   - **Add a route**, with a mode switch between "Tap stands" and "Record a ride":
     - Tap stands: a map where tapped stands get numbered markers (order matters), and a reorderable list of stands.
     - Fields: vehicle (Shared auto, E-rickshaw or Tempo), fare, how often, and last trip.
     - A privacy note: "We trim the first and last 200 m of every ride."
     - The button "Submit for checking".
   - **Record a ride:** a large timer, the distance, "Mark a stand", "Finish ride", and a note to keep the screen on.
9. **Moderator queue**
   - Desktop table with columns: Route, Submitted by, Source, Stands, Fare, Status, Submitted.
   - Filter tabs: Waiting, Verified, Stale, Rejected.
   - A row opens a side panel with a map preview, the list of stands, and "Approve", "Edit" or "Reject" (with a reason).
   - A "Download verified routes (GTFS)" button above the table.
10. **Me**
    - Profile.
    - Language: English or हिन्दी.
    - Theme: System, Light or Dark.
    - Notifications.
    - "Delete my location history".
    - "Sign out".

## 9. The signature animation: "Reroute my day"

Triggered when the traveller taps "Reroute my day" or "Update my times".

| Time | What happens |
|---|---|
| 0 ms | The button presses (scale 0.97, 90 ms). If the API takes more than 300 ms, its label becomes "Rerouting…" with a spinner |
| 0–240 ms | The sheet springs down and the backdrop fades out |
| 160–360 ms | The old, affected leg segments fade to 30% and turn dashed |
| 300–900 ms | The new leg segments draw from top to bottom (SVG `pathLength` 0 to 1, or `scaleY` from the top), easing out |
| from 700 ms | Changed times flip like a railway split-flap board: each time rotates on the X axis out and back in, 180 ms per stop, 60 ms apart, in stop order |
| 900–2100 ms | Each changed time gets a yellow highlight that fades to transparent, its text fading from `--on-yellow` to `--ink` |
| 1000 ms | The status pill cross-fades and resizes from "Running late" to "Rerouted at 10:55", with the icon swapping |
| 1200 ms | The toast rises 16 px and fades in: "Day rerouted. All three tasks still happen today." with Undo |

**A task moves to tomorrow:** its stop row lifts (scale 1.02, toast-level shadow) and travels down into a new "Tomorrow, Wednesday 15 October" group using a shared `layoutId` (500 ms, in-out). Its station becomes hollow, and the gap it left closes smoothly.

**Undo:** everything reverses in about 400 ms, with no flip.

**Reduced motion:** nothing draws, flips or travels. Values swap instantly, the yellow highlight stays still for 2 seconds, and the toast appears without moving.

**Screen readers:** an `aria-live="polite"` region announces "Day rerouted. Bank now at 12:40. University office now at 15:55. Undo available."

## 10. All other motion

| Moment | Motion |
|---|---|
| A new plan appears (once per plan) | The line draws downward (600 ms) and stations pop in (scale 0.6 to 1 with a fade, 40 ms apart). The map route draws at the same time |
| Check in | The station ring fills (scale 0.8 to 1, 160 ms) and its check mark draws (200 ms). The row's text dims to `--ink-2`. A 10 ms vibration where supported. The Now bar glides to the next station (400 ms) |
| Last 10 minutes before leaving | A soft pulse ring on the Now station (opacity 0.6 to 0, scale 1 to 1.8, 1.6 s loop), and the Next card's time turns yellow. It stops on check-in or departure |
| Sheets | A spring up; drag down to dismiss using velocity; the backdrop fades in 160 ms |
| Choosing an option | The selection outline slides between cards (shared layout, 220 ms) |
| Switching tabs | A 160 ms cross-fade; no sliding pages |
| Opening Leg detail | Slides in from the right (240 ms, ease-out) on mobile; a cross-fade inside the right pane on desktop |
| Toasts | In over 240 ms, out over 160 ms |
| Map | Flies to the active leg (800 ms, in-out) when the active leg changes |
| Buttons | Press scale 0.97; on desktop, hover changes only the background |

**Never use:** parallax, a fade-up on every section as you scroll, bounces, confetti, auto-playing carousels or looping decoration.

## 11. Accessibility (WCAG 2.1 AA)

- Text contrast at least 4.5:1 (3:1 for text 24 px and larger, and for icons). Check every token pair in both themes.
- Every mode and every status uses an icon and words, never colour alone.
- Touch targets at least 48×48, with at least 8 px between them.
- A visible 3 px `--focus` ring with a 2 px offset on everything interactive, and a logical tab order. Sheets trap focus and give it back when they close.
- The timeline is an ordered list for screen readers. Stops read like "10:00, Meeting, Whitefield, fixed time, now". Legs read like "Metro, then shared auto, 80 minutes, 80 rupees". Decorative icons use `aria-hidden`; icon-only buttons get an `aria-label`.
- Works at 320 px wide and at 200% text zoom without losing anything. The time column stays put while the content wraps.
- Respect `prefers-reduced-motion` everywhere: nothing draws, flips, slides, pulses or flies, values swap instantly, and only short opacity fades remain (section 9 shows the reroute version). Respect `prefers-color-scheme` too.
- Hindi text gets `lang="hi"`, and layouts allow for strings about 30% longer.
- Labels are always visible; placeholders are never used as labels.

## 12. Copy and voice

- Plain, calm and specific. Sentence case. No exclamation marks, no "please", no "Oops".
- Use the traveller's words: leave, stand, shared auto, fare, last one.
- An action keeps its name through the whole flow:
  - "Reroute my day" leads to the toast "Day rerouted"
  - "Update my times" leads to "Times updated"
  - "Check in" leads to "Checked in at 12:38"
- Formats: 24-hour times (10:00), durations as "80 min" or "2 h 30 min", money as "₹80". Mark estimates with "about" or "around".
- Errors say what happened and what to do: "Couldn't load your plan. Check your connection and try again."
- Offline: "You're offline. Your plan still works, and changes sync when you're back."
- Empty states invite action: "No tasks yet. Add your first one, like a meeting or a bank visit."

## 13. Data shapes and demo fixtures

```ts
type Mode = 'walk' | 'metro' | 'bus' | 'shared_auto' | 'e_rickshaw' | 'cab';

interface Task {
  taskId: string; title: string;
  place: { name: string; area: string };
  durationMin: number;
  fixedStart?: string;                              // ISO time
  window?: { opensAt: string; closesAt: string };
  priority: 1 | 2 | 3;
  state: 'planned' | 'in_progress' | 'done' | 'skipped' | 'moved';
}

interface Leg {
  seq: number; taskId: string; label: string;       // "Metro, then shared auto"
  segments: { mode: Mode; minutes: number }[];
  leaveBy: string; arriveAt: string;
  travelMin: number; fareInr: number;
  raasta?: { routeId: string; status: 'verified' | 'unverified' | 'stale' };
}

interface Plan {
  planId: string; version: number;
  status: 'proposed' | 'active' | 'superseded';
  trigger: 'created' | 'late' | 'skipped' | 'edited';
  legs: Leg[]; reasonCodes: string[]; explanation: string;
  totals: { travelMin: number; fareInr: number };
}

interface ReplanOption {
  optionId: string; label: string; extraFareInr: number;
  movedTasks: string[]; consequence: string; reasonCodes: string[];
}

interface RaastaRoute {
  routeId: string; stands: { name: string }[];
  vehicleType: 'shared_auto' | 'e_rickshaw' | 'tempo';
  fareInr: number; frequencyMin: number; lastTrip: string;
  status: 'verified' | 'unverified' | 'stale'; lastConfirmedAt: string;
}
```

**Sample trip.** Bengaluru, Tuesday 14 October, day 1 of 2. Staying at a hotel near Majestic.

Tasks:
- Meeting, Whitefield: fixed 10:00, 1 h
- Bank, Koramangala: open till 16:00, 2 h 30 min
- University office, Jayanagar: closes 17:00, 45 min
- Train home, KSR Bengaluru: fixed tomorrow 21:00

**Demo clock:** 10:55, during the meeting. The traveller taps "Running late" at 10:55, so after a reroute the status pill reads "Rerouted at 10:55".

**Plan version 1:**
1. 08:50 Hotel, Majestic (left, done)
2. Metro, then shared auto: 60 min, ₹70 (done)
3. 10:00 Meeting, until 11:00 (now)
4. Metro, then shared auto: leave 11:05, 80 min, ₹80
5. 12:30 Bank
6. Shared auto from Raasta (verified): leave 15:05, 40 min, ₹30
7. 15:45 University office
8. Metro: leave 16:35, 20 min, ₹30
9. 16:55 Hotel, Majestic

**15-minute delay:** leave at 11:20. The later stops become 12:45, 16:00 and 17:10 (shift only, no question).

**40-minute delay** (the meeting runs until 11:40; leave at 11:45):
- **Option A, "Take a cab to the bank", +₹350:** cab for 50 min, ₹430. Stops become 12:40, 15:55 and 17:05.
- **Option B, "Keep it cheap":** the bank moves to 13:10, then metro (35 min, ₹30) to the hotel at 16:25. The university office moves to tomorrow at 10:00.

**Raasta leg:** Koramangala 5th Block stand to Jayanagar 4th Block stand (3rd stop). ₹30 a person, about every 10 min, last one around 21:30, last confirmed 3 days ago by 4 riders, verified.

**Summary (option A):**

| Leg | Mode | Fare |
|---|---|---|
| Hotel to Whitefield | Metro, then shared auto | ₹70 |
| Whitefield to Koramangala | Cab | ₹430 |
| Koramangala to Jayanagar | Shared auto | ₹30 |
| Jayanagar to Majestic | Metro | ₹30 |
| **Total** | 2 h 50 min travelling, rerouted once at 10:55 | **₹560** |

**Demo controls.** A developer-only "Simulate" panel, opened with `?demo=1`, can set the current time, trigger a 15- or 40-minute delay, go offline, and expire a share link. In demo mode the header shows a small "Demo" tag.

## 14. Do not

- No gradients, glassmorphism, neumorphism, glows, blurred backgrounds or noise textures.
- No cream and terracotta palette, and no black with a neon accent.
- No dashboard grids of identical rounded cards with soft grey shadows. Timeline rows are not cards.
- No all-caps labels or eyebrow text above headings. No "A · B · C" strings joined with middle dots. No "→" in button labels.
- No Inter, Roboto, Arial or SF as design fonts. No monospace for numbers; use tabular figures.
- No emoji, stock illustrations, 3D blobs or mascots.
- No fake phone status bar or device frame inside the app.
- No dead buttons or placeholder charts. If a feature isn't ready, don't show it.
- No meaning carried by colour alone, no text smaller than 13 px, no placeholder used as a label.
- Yellow is never decoration.

## 15. Build order and self-check

1. `tokens.css` (light and dark), the fonts, and the Tailwind theme mapping.
2. Basic components: Button, Tag, Pill, Input, Chip group, Sheet, Toast, and the icon set including the two custom auto icons.
3. The timeline system: Station, LegSegment, NowBar and Timeline, with layout animations.
4. Screens in this order:
   1. Today
   2. Running late
   3. Leg detail
   4. Plan your day
   5. Day summary
   6. Share and the family view
   7. Raasta (add a route, record a ride)
   8. Moderator queue
   9. Sign in
   10. Me
5. The signature choreography and its reduced-motion version.
6. The tablet and desktop layouts.
7. If you can run the app: run Playwright with axe and screenshot each screen at 390×844 and 1280×800 in both themes. Fix anything that breaks section 16.

After each screen, check it against section 14. If a detail doesn't help the traveller, remove it.

## 16. Definition of done

- Every screen in section 8 works with real loading, empty, error, offline and blocked states from the fixtures.
- The reroute choreography matches section 9, and the reduced-motion version works.
- Lighthouse on mobile: Accessibility 95 or higher, Performance 90 or higher, Best practices 95 or higher, and the app is installable.
- axe reports zero critical or serious issues.
- Works at 320, 390, 768, 1024 and 1280 px, and at 200% text zoom.
- Animations hold 60 fps on a mid-range Android phone (transform and opacity only).
- Every interactive element is at least 48 px, reachable by keyboard, and shows a visible focus ring.
- Both themes pass contrast.
- Nothing from section 14 appears anywhere.
