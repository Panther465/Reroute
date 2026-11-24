import type { ReactNode } from 'react'
import { Bullets, ContactUs, Lead, LegalPage, LegalTable, SubHeading, TextLink, type LegalSection } from '@/components/LegalPage'

// The public privacy policy (Google Play links here). Every fact comes from docs/data-and-privacy.md: change that
// record first, then this page, and move the effective date.

const KEEP: ReactNode[][] = [
  [
    'Your account',
    <>Name, email, role, and your Google account ID if you sign in with Google. For an email account, a salted scrypt hash of your password, never the password itself.</>,
    'Signing you in, and your role',
    'Until you delete your account',
  ],
  ['Sign-in sessions', 'Refresh tokens, stored only as a hash', 'Keeping you signed in', '30 days, and replaced every time one is used'],
  [
    'Expenses',
    'What you spent, the amount, the day, the shop, how you paid, the GST and the seller’s GSTIN, your note; the budget and limits you set; your claims; and the receipt photos you attach',
    'The expense manager, and claiming expenses back from your office',
    'With the trip, or until you delete your account',
  ],
  [
    'Email links',
    'A single-use token for verifying your email or resetting your password, stored only as a hash',
    'Checking the email is yours, or letting you choose a new password',
    'Works once: for 1 hour (password reset) or 3 days (verification)',
  ],
  ['Trips', 'Your trips, their tasks, and the places you chose', 'Planning your day', 'Until you delete the trip'],
  ['Plans', 'Each version of a plan, with what went into it and the reasons for it', 'Explaining and replaying every change', 'With the trip'],
  ['Check-ins', 'Done, skipped, or a delay', 'Following the day', 'With the trip'],
  ['The Reroute log', 'What Reroute changed in your day', 'Showing you what changed, with Undo', 'With the trip'],
  [
    'Places you added',
    'The name, kind, your note, the pin, whether you shared it, and a moderator’s decision',
    'Finding them again, planning with them, and showing the ones you share',
    'Until you delete it or your account. If a trip still goes there, it stays with that trip, without its note, until nothing goes there',
  ],
  ['Share links', 'The family view links you make, stored only as a hash', 'Family view', 'They expire when the trip ends; you can stop one at any time'],
  [
    'Simulated bookings',
    'Passenger names and ages for a train ticket or a flight; the ride for a cab; the sight and how many are going for entry tickets',
    'The booking demo. Nothing real is booked',
    'With the trip; resetting the demo trip deletes them',
  ],
  [
    'Wallet entries',
    'Each top-up, booking and refund, with its amount and label. The money is simulated: no card or bank is involved',
    'The wallet that pays for simulated bookings',
    'Until you delete your account; resetting the demo resets the demo wallet',
  ],
  ['Raasta rides', 'Rides you record, trimmed: the first and last 200 m are never stored', 'Building shared-auto routes', 'With the route, until you delete your account'],
  [
    'What you add to Raasta',
    'Routes you add, routes you confirm and fares you report, with your rider ID',
    'Building and checking the shared-auto map',
    'The routes stay; when you delete your account, your ID on them is replaced by an anonymous stand-in',
  ],
  [
    'Your phone, for alerts',
    'The Android app’s notification token (an app-install identifier, no location), only with phone notifications on',
    'Sending leave-by alerts, the morning plan and Rico’s check-ins',
    'Until you turn notifications off or sign out (more under “The Android app”)',
  ],
]

const CACHE: ReactNode[][] = [
  ['Safety and live state', 'Rate-limit counters, idempotency keys, live state, reported delays', 'Safety and live updates', '1 minute to 36 hours'],
  ['Place searches', 'What was searched for, and the results', 'Fewer calls to OpenStreetMap', '24 hours'],
  ['Road shapes', 'The two stops of a leg, and the path between them', 'Drawing legs on the map', '30 days'],
  ['Read-aloud clips', 'The alert’s text and its audio', 'Not asking for the same clip twice', '7 days'],
  [
    'Rico’s guide',
    'City guides; places near an area about a kilometre across; web answers, kept under a hash of the question',
    'Not asking Wikivoyage, OpenStreetMap or Google the same thing twice',
    'City guides 7 days, places a day, web answers an hour',
  ],
]

const SERVICES: ReactNode[][] = [
  ['Our email provider', 'Your email address, and the email itself: its words contain only the link and your name', 'When we send you a link to verify your email or reset your password'],
  [
    'Sentry (error reports)',
    'The error, the screen or API path, the browser or phone model, and a trace ID. Never names, emails, passwords, tokens, query strings or location',
    'Only if we switch error reports on for our server. They’re off unless we do',
  ],
  ['Google (sign-in and Calendar)', 'The sign-in code; the Calendar code if you import appointments', 'Only when you use Google sign-in or Calendar import'],
  [
    'Google Gemini (receipts)',
    'The photo of a receipt you choose to scan, to read its shop, date, total and GST. A receipt can show a card’s last digits or a name, as on paper',
    'Only when you tap Scan a receipt, with our AI helper switched on. A photo you attach without scanning goes nowhere but our database',
  ],
  ['Google Maps Platform', 'The text you type in place search and the trip’s city; the area Rico’s guide looks around; the map tiles your phone loads, so the area you look at', 'Only when our server has a Google Maps key; otherwise OpenStreetMap’s services above'],
  [
    'Microsoft Azure AI Speech',
    <>The text of an alert, or of a chat reply Rico reads out, such as “Time to leave for the bank”</>,
    'Only with natural voices on and an Azure key set on our server. Otherwise your phone’s own voice reads it and nothing is sent. Rico reads his chat replies by default; the speaker button or Me turns that off',
  ],
  ['Microsoft Edge’s read-aloud service (through the edge-tts library)', 'The same text', 'Only with natural voices on, when no Azure key is set or Azure doesn’t answer'],
  [
    'Your browser’s or phone’s speech service (Google’s in Chrome, and on most Android phones)',
    'The sound of the one sentence you say to Rico. Reroute never gets the recording, only the words',
    <>Only while Rico shows “Listening”, after you tap “Talk to Rico”. The microphone goes off when you finish the sentence, after 8 seconds of silence, or when you close Rico</>,
  ],
  ['OpenStreetMap Nominatim', 'The text you type in place search, and the city', 'When you search for a place Reroute doesn’t already know'],
  [
    'OpenFreeMap (map tiles)',
    <>Which map tiles your phone loads: the area you look at, including around your position while “Follow me” is on</>,
    'Whenever a map is shown. Your phone fetches the tiles directly',
  ],
  [
    'FOSSGIS routing servers (routing.openstreetmap.de)',
    'The coordinates of a leg’s stops, and of the metro stations and shared-auto stands it passes. Never your live position',
    'When our server draws a plan’s legs along the roads (kept 30 days), and once per plan in a city without sample data, for road distances',
  ],
  ['Raasta (Reroute’s own route service)', 'The coordinates of a leg’s two stops', 'When our server plans a day'],
  ['Google Maps', 'Your starting point and the leg’s destination', 'Only when you tap Open in Google Maps. Google’s own privacy policy applies there'],
  [
    'Google Gemini',
    <>
      The text you type in “Describe your day”. A message to Rico the phone couldn’t understand by itself, with the last few messages and your trip’s task titles, areas, times and today’s plan. With Rico’s agent, also what it
      looks up to answer: place names and areas, ride options and fares, your bookings and wallet balance, your trip’s expenses when you ask about money (each one’s title, amount, kind, how it was paid and day, the totals and the budget; never a receipt photo), and what it read in a city’s guide. Never your name, email or location
    </>,
    'Only if the AI helper is on (it’s off by default). Rico answers most messages on the phone, sending nothing',
  ],
  [
    'Google Gemini Live',
    'What the microphone hears while Rico’s voice screen is open, and your day in words (the same as the chat sends) when it starts',
    'Only while the voice screen is open (the Talk button). Our server never receives or keeps the audio',
  ],
  [
    'Google Search, through Gemini',
    <>The question Rico asks the web, such as “When is Lalbagh Botanical Garden open?”. Rico is told never to put your name or where you stay in it</>,
    'Only with the AI helper and a Gemini key, when Rico looks something up (at most 3 times a message)',
  ],
  ['Wikivoyage (Wikimedia Foundation)', 'The name of the city, or the place, Rico reads a guide for', 'Only with Rico’s agent, when it reads a city’s guide'],
  [
    'Wikimedia Commons (Wikimedia Foundation)',
    'The name of a place, and its city, that Rico shows photos of. Your phone then loads the photos from Wikimedia’s servers, which see its address as any website does',
    'Only while you talk with Rico out loud, when he shows photos',
  ],
  ['OpenStreetMap’s Overpass server', 'The area Rico looks around: a point rounded to about a kilometre, never the exact place you stay or your position', 'Only with Rico’s agent, when it looks for places to see, eat or do'],
  [
    'Google Firebase Cloud Messaging (Android app)',
    <>The words of each alert, such as “Leave in 9 min. Metro, then shared auto.”, and with a check-in, the leg’s leave-by time, its mode and how much earlier to leave</>,
    'Only with phone notifications on in Me',
  ],
  ['Alpha Cephei, the makers of Vosk (Android app)', 'A request for the “Hey Rico” speech model, and nothing else', <>Once, only with “Hey Rico” on</>],
]

const SECTIONS: LegalSection[] = [
  {
    id: 'short',
    title: 'The short version',
    body: (
      <Bullets
        items={[
          'We keep what Reroute needs to plan and follow your day: your account, your trips and what happens on them.',
          'We never collect payment details, government ID numbers, your contacts, or your location outside an active trip.',
          'Your live position stays on your phone. Family you share a trip with see your stops and progress, never where you are.',
          'Outside services get only what they need for their one job. Apart from the email provider that delivers our emails, none of them gets your name or email from us.',
          'Bookings, the wallet and the partner services are simulated. No card or bank is ever involved.',
          <>
            You can download your data, or delete your account, at any time in Me → Account (<TextLink to="#your-data">how</TextLink>).
          </>,
        ]}
      />
    ),
  },
  {
    id: 'who',
    title: 'Who runs Reroute',
    body: (
      <>
        <p>Reroute, and Raasta, its map of shared-auto routes, are run by the Reroute team, a student project.</p>
        <p>Your data is stored on our servers in Microsoft Azure’s Central India region.</p>
        <p>
          To reach us, see <TextLink to="#contact">Contact us</TextLink>.
        </p>
      </>
    ),
  },
  {
    id: 'keep',
    title: 'What we keep',
    body: (
      <>
        <p>What Reroute’s servers keep about you, why, and for how long:</p>
        <LegalTable label="What we keep" columns={['What', 'In detail', 'Why', 'How long']} widths={['20%', '30%', '24%', '26%']} rows={KEEP} />
        <p>This version of Reroute doesn’t keep a history of where you’ve been.</p>
        <SubHeading>Short-lived copies</SubHeading>
        <p>So that Reroute stays quick and doesn’t ask other services the same thing twice, our server keeps some copies for a short time in its cache. They expire on their own.</p>
        <LegalTable label="Short-lived copies" columns={['What', 'In detail', 'Why', 'Kept for']} widths={['20%', '30%', '26%', '24%']} rows={CACHE} />
        <SubHeading>Server logs</SubHeading>
        <p>
          Our web server and the API log each request: its method, path, status, how long it took, and a trace ID. We use them to run and debug the service, and they’re kept as long as the server keeps its logs.
        </p>
        <p>
          The logs never hold a query string (where place searches and read-aloud text travel) or a share link’s token: a share link shows in them as <span className="whitespace-nowrap">/shared/***</span>.
        </p>
      </>
    ),
  },
  {
    id: 'never',
    title: 'What we never collect',
    body: <p>Payment details, passwords, government ID numbers, your contacts, or your location outside an active trip. (For an email account we keep only a hash of your password, as above.)</p>,
  },
  {
    id: 'services',
    title: 'Other services that see some of your data',
    body: (
      <>
        <p>
          Reroute uses outside services for some jobs. Each sees only what it needs. Apart from the email provider, which needs your address to deliver our emails, none of them gets your name or email from us.
        </p>
        <LegalTable label="Other services that see some of your data" columns={['Service', 'What it receives', 'When']} widths={['30%', '38%', '32%']} rows={SERVICES} />
      </>
    ),
  },
  {
    id: 'location',
    title: 'Your location',
    body: (
      <>
        <p>
          “Show me on the map” (in Me, or when you tap “I’ve left”) follows your phone’s location while Reroute is open, to draw the blue dot, measure the distance left and say when you’re nearly there.
        </p>
        <p>
          <Lead>Your position stays on your phone.</Lead> It is never sent to Reroute’s servers or stored. Browsers stop following it when the phone locks or the app is closed, and you can turn it off in Me at any time. The
          map tiles around you still come from OpenFreeMap, which can tell the area you’re looking at.
        </p>
        <p>
          <Lead>Turn by turn</Lead> follows your position on the phone only. The directions are worked out on the phone and the turns are spoken in the phone’s own voice, so no street name ever goes to a server along with where
          you are.
        </p>
        <p>
          Roads for the map and the directions come from FOSSGIS’s routing servers, through our server. Only the coordinates of a leg’s stops, and of the stations and stands it passes, are sent: never your live position.
        </p>
      </>
    ),
  },
  {
    id: 'places',
    title: 'Places you add',
    body: (
      <>
        <p>A place you add (press and hold a map, or “Add it as your own place” in place search) is personal data: what you call it, where it is and your note can say a lot about you.</p>
        <Bullets
          items={[
            <>
              <Lead>Only you see it</Lead> unless you turn on “Share with everyone”. Nobody else finds it in search or on a map, and nobody else’s trip can use it.
            </>,
            <>
              <Lead>Sharing asks a moderator first.</Lead> A moderator sees its name, kind, city, area and pin, and who added it only as an account ID: never your name, email or note. Once they approve it, every traveller
              can find its name, kind, area and pin, never your note or who added it. Until then, and if they say no (you’ll see why), it stays yours alone.
            </>,
            <>
              <Lead>Your note is yours alone</Lead>, shared or not, moderators included.
            </>,
            <>
              <Lead>Nothing is sent anywhere else:</Lead> adding a place asks no outside service. The map you place the pin on loads its tiles from OpenFreeMap, as every map does.
            </>,
          ]}
        />
      </>
    ),
  },
  {
    id: 'family',
    title: 'Family view',
    body: (
      <p>
        A share link shows your stops and progress. It never shows coordinates or your exact location. Links are 128 random bits, stored only as a hash. They expire when the trip ends, and stop working the moment you stop
        sharing. Server logs show the link as <span className="whitespace-nowrap">/shared/***</span>.
      </p>
    ),
  },
  {
    id: 'rico',
    title: 'Rico and the AI helper',
    body: (
      <>
        <p>
          Rico, Reroute’s companion, understands common requests on your phone, sending nothing: running late, move, skip, change a time or a length, plan again, undo, and what’s next. The chat itself is kept in your browser
          for the session only.
        </p>
        <p>
          <Lead>The AI helper is off by default.</Lead> When it’s on, only what you type goes to the provider, Google Gemini, with no name, email or location:
        </p>
        <Bullets
          items={[
            <>
              A message the phone can’t place goes to Gemini with the day it needs to answer (see <TextLink to="#services">the table above</TextLink>). Gemini’s answer is only an offer: our server checks it against your
              trip, and the app asks you before changing anything.
            </>,
            'With a Gemini key, Rico’s agent can also read your trip, rides and wallet through Reroute’s own API, signed in as you, and put several changes on one card. Nothing changes until you tap Do all, and Undo takes it back.',
            'As a local guide, Rico reads Wikivoyage and OpenStreetMap and asks Google Search, sending only a city’s name, an area about a kilometre across, or its question.',
          ]}
        />
        <SubHeading>Talking with Rico out loud</SubHeading>
        <p>
          Only while the voice screen is open (the Talk button), what the microphone hears goes straight from your phone to Google’s Gemini Live, which turns it into words and answers in Rico’s voice. Google also gets your day in
          words when the conversation starts. Our server never receives or keeps the audio, and the captions live on the screen only. Closing the screen turns the microphone off.
        </p>
      </>
    ),
  },
  {
    id: 'android',
    title: 'The Android app',
    body: (
      <>
        <p>The Android app is the same app, so everything above applies to it. What differs:</p>
        <Bullets
          items={[
            <>
              <Lead>Staying signed in.</Lead> A browser keeps your sign-in token in a cookie the page never sees. The app keeps it in the Android Keystore, encrypted with a key that never leaves the phone, and sends it only to
              Reroute’s server. It never goes to the phone’s log. Signing out deletes it from the phone and ends the session on the server.
            </>,
            <>
              <Lead>What stays on the phone.</Lead> The saved plan, check-ins waiting to sync, and your settings are kept in the app’s own storage. Android’s backup is turned off for Reroute, so none of it is copied to Google
              Drive or a new phone.
            </>,
            <>
              <Lead>Permissions</Lead>, each asked the first time it’s needed: location for “Show me on the map” and turn by turn, only while Reroute is open; the microphone for talking to Rico; and notifications for leave-by
              alerts (Android 13 and later). Say no, and the rest of the app still works.
            </>,
            <>
              <Lead>Speech.</Lead> Talking to Rico uses Android’s speech recognizer: on most phones that’s Google’s speech service, which hears the one sentence you say. Reroute receives only the words. The phone’s own voice is
              Android’s text-to-speech.
            </>,
            <>
              <Lead>Google sign-in</Lead> goes through Android’s own Google account picker. Our server receives the same one-time code as from the web.
            </>,
            <>
              <Lead>“Hey Rico”</Lead>, only with Me → “Hey Rico” on. The phone listens for Rico’s name with a speech model that runs on the phone, downloaded once from Alpha Cephei’s site. What the microphone hears is never
              recorded, kept or sent anywhere. Hearing “Hey Rico” opens the voice screen (see <TextLink to="#rico">Talking with Rico out loud</TextLink>). With “Even when Reroute is closed” on, a notification shows the whole
              time it listens; with it off, it listens only while Reroute is on screen. Turning “Hey Rico” off stops the microphone at once.
            </>,
            <>
              <Lead>Popping up over other apps</Lead> (Me → Pop up over other apps, with Android’s “Display over other apps” allowed) shows Rico’s card over the app on screen when he’s called, and nothing else. Reroute doesn’t
              see or read what’s in other apps.
            </>,
            <>
              <Lead>Push notifications</Lead>, only with Me → Phone notifications on. Our server keeps your phone’s Firebase token (an app-install identifier, no location) to send leave-by alerts, the morning plan and Rico’s
              check-ins, and the words of each alert pass through Google’s Firebase Cloud Messaging. The phone gets a token only once you turn notifications on. Turning them off or signing out deletes it from our server; so does
              the sign-in that registered it ending or expiring, and Firebase reporting the app uninstalled.
            </>,
          ]}
        />
      </>
    ),
  },
  {
    id: 'emails',
    title: 'Emails from us',
    body: (
      <>
        <p>We send two kinds of email: a link to verify your email address, and a link to reset your password when you ask for one.</p>
        <p>Our server keeps each link’s token only as a hash. A link works once, and only for 1 hour (password reset) or 3 days (verification).</p>
        <p>The email goes out through our email provider. Its words contain only the link and your name.</p>
      </>
    ),
  },
  {
    id: 'errors',
    title: 'Error reports',
    body: (
      <>
        <p>
          Error reports are off unless we switch them on for our server. When they’re on, crashes and errors from the app and the server go to Sentry, an error-tracking service: the error, the screen or API path, the browser or
          phone model, and a trace ID.
        </p>
        <p>They never include names, emails, passwords, tokens, query strings or your location.</p>
      </>
    ),
  },
  {
    id: 'simulated',
    title: 'Bookings, the wallet and partners',
    body: (
      <>
        <p>
          The partners in Me → Connected services (RideNow, AutoGo, ZipBike, RailGo and SkyHop) are invented and simulated. Connecting one only flips a switch on your phone: nothing is sent to anyone, and no real account is
          linked.
        </p>
        <p>
          The wallet holds simulated money. Adding money charges no card or bank, and bookings paid from it book nothing real. A booking keeps the details you enter with the trip, as <TextLink to="#keep">What we keep</TextLink>{' '}
          says.
        </p>
      </>
    ),
  },
  {
    id: 'your-data',
    title: 'Download or delete your data',
    body: (
      <>
        <SubHeading>Download a copy</SubHeading>
        <p>
          <Lead>Me → Account → Download your data</Lead> gives you a JSON file of your account, trips, tasks, plans, check-ins, bookings, wallet, places, and the phones registered for alerts.
        </p>
        <SubHeading>Delete your account</SubHeading>
        <p>
          <Lead>Me → Account → Delete my account</Lead> deletes your account and the data in the first table under <TextLink to="#keep">What we keep</TextLink>, all at once, in both Reroute and Raasta. What’s left afterwards:
        </p>
        <Bullets
          items={[
            'Your recorded Raasta rides are deleted. On routes, confirmations and fare reports, your ID is replaced by an anonymous stand-in, so route counts stay right.',
            'Places you shared that a moderator approved stay, with no link to you and without your note.',
            'A place other travellers’ trips still go to stays for those trips, without your note or any link to you.',
            'Copies in our cache expire on their own, within 30 days.',
            <>
              Server logs keep their request lines, as <TextLink to="#keep">Server logs</TextLink> describes.
            </>,
          ]}
        />
        <SubHeading>Delete one thing</SubHeading>
        <Bullets
          items={[
            <>
              <Lead>A share link:</Lead> Share → Stop sharing.
            </>,
            <>
              <Lead>A place you added:</Lead> tap its pin on a map → Delete this place. It’s gone at once, unless a task or a stay of a trip still goes there: that trip keeps it until nothing goes there, but its note goes at once
              and it leaves search, the map and your places. A plan made before then calls it “A deleted place”.
            </>,
            <>
              <Lead>A booking:</Lead> cancelling keeps the simulated record with the trip; resetting the demo trip deletes it.
            </>,
            <>
              <Lead>Location history:</Lead> Me → Delete my location history removes it at once (this version doesn’t keep one).
            </>,
          ]}
        />
        <SubHeading>Turn things off</SubHeading>
        <p>
          At any time: Rico reading his replies aloud (the speaker button, or Me), “Show me on the map” (Me), and in the Android app, phone notifications and “Hey Rico” (Me). For anything else, <TextLink to="#contact">ask us</TextLink>.
        </p>
      </>
    ),
  },
  {
    id: 'children',
    title: 'Children',
    body: (
      <p>
        Reroute plans work trips. It isn’t meant for anyone under 18 without a parent or guardian. A parent or guardian with a question about a child’s data can <TextLink to="#contact">contact us</TextLink>.
      </p>
    ),
  },
  {
    id: 'changes',
    title: 'Changes to this policy',
    body: (
      <p>
        When we change this policy, we update this page and the effective date at the top. If you don’t agree with a change, you can download your data and delete your account at any time.
      </p>
    ),
  },
  { id: 'contact', title: 'Contact us', body: <ContactUs /> },
]

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy policy"
      effective="2026-11-23"
      lead={
        <>
          <p>
            Reroute is a work-trip planner for Indian cities. This page says what we keep about you, why, for how long, which outside services see what, and how to delete it. We wrote it in line with India’s Digital Personal
            Data Protection Act, 2023.
          </p>
          <p>The Android app is the same app, so all of this applies there too.</p>
        </>
      }
      sections={SECTIONS}
      other={{ to: '/terms', label: 'Terms of use' }}
    />
  )
}
