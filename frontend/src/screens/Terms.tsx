import { Bullets, ContactUs, Lead, LegalPage, TextLink, type LegalSection } from '@/components/LegalPage'

// The public terms of use. What the service does, and what's simulated, follows README.md, docs/known-limits.md
// and docs/data-and-privacy.md; when the rules change, move the effective date.

const SECTIONS: LegalSection[] = [
  {
    id: 'service',
    title: 'What Reroute is',
    body: (
      <>
        <p>
          Reroute is a work-trip planner for Indian cities, made by the Reroute team as a student project. It plans your day (the order, when to leave, how to get there and what it costs) and plans the rest of it again when you
          run late. Raasta, part of Reroute, is a map of shared-auto, e-rickshaw and tempo routes, added by riders and checked by moderators.
        </p>
        <p>
          <Lead>Plans, times and fares are estimates.</Lead> Every travel time and fare is an estimate, and the app says so. The demo day uses sample places and travel times, and Raasta’s routes come from riders. Check
          anything that matters, such as when a meeting starts or when the last train leaves, before you rely on it.
        </p>
      </>
    ),
  },
  {
    id: 'simulated',
    title: 'Bookings and the wallet are simulated',
    body: (
      <>
        <p>
          Bookings, the wallet and the partners in Me → Connected services (RideNow, AutoGo, ZipBike, RailGo and SkyHop) are a demo. <Lead>Nothing real is booked or charged.</Lead> No ticket is issued, no driver is sent,
          and no card or bank is involved. The partners are invented, and connecting one links no real account.
        </p>
        <p>A simulated ticket isn’t a ticket: don’t travel on one. The wallet’s money is pretend. It has no value and can’t be paid out.</p>
      </>
    ),
  },
  {
    id: 'account',
    title: 'Your account',
    body: (
      <Bullets
        items={[
          'Give accurate information when you make an account, and use an email address that’s yours.',
          'Keep your password to yourself, and don’t share your account. What’s done with it is your responsibility. If you think someone else knows your password, reset it by email.',
          'If you’re under 18, use Reroute with a parent or guardian.',
        ]}
      />
    ),
  },
  {
    id: 'use',
    title: 'Using Reroute fairly',
    body: (
      <>
        <p>Use Reroute lawfully, and for what it’s for. Don’t:</p>
        <Bullets
          items={[
            'break the law through Reroute, or help anyone else to;',
            'try to get into other people’s accounts or data, or into parts of the service you aren’t meant to reach;',
            'overload, attack or disrupt the service, or get round its limits;',
            'add places, routes or fare reports you know are false, or that hold someone else’s personal details;',
            'use Reroute to harass anyone.',
          ]}
        />
      </>
    ),
  },
  {
    id: 'content',
    title: 'What you add',
    body: (
      <>
        <p>You can add places of your own, and add routes, confirmations and fare reports to Raasta. Only add what you have the right to share and believe is accurate.</p>
        <p>
          <Lead>What you share, you let us show.</Lead> When you share a place (“Share with everyone”) or add to Raasta, you give us free permission to store it, show it to other travellers and use it in their plans, for as long
          as Reroute runs. That includes after you delete your account, in the way the <TextLink to="/privacy#your-data">privacy policy</TextLink> describes: an approved place stays without your note or any link to you, and
          routes stay with an anonymous stand-in for your ID. Your note on a place is never shown to anyone else.
        </p>
        <p>
          <Lead>Moderators check what’s shared.</Lead> They may refuse a place or a route; a refused place stays yours alone. A Raasta route counts only once a moderator or two different riders confirm it. We may remove
          anything that breaks these terms.
        </p>
      </>
    ),
  },
  {
    id: 'privacy',
    title: 'Your privacy',
    body: (
      <p>
        What we keep about you, who else sees what, and how to delete it are in our <TextLink to="/privacy">privacy policy</TextLink>.
      </p>
    ),
  },
  {
    id: 'no-warranty',
    title: 'No guarantees',
    body: (
      <>
        <p>
          Reroute is a student project. We try to make it useful and reliable, but we provide it as it is, with no promise that it’s accurate, complete, always available, or right for your trip. It may change, pause or stop at
          any time.
        </p>
        <p>
          As far as the law allows, the Reroute team isn’t responsible for any loss that comes from using Reroute or relying on it: for example a missed meeting, train or flight, a fare that turned out higher, or a route that had
          changed. Nothing in these terms takes away rights you have under Indian law that can’t be taken away.
        </p>
      </>
    ),
  },
  {
    id: 'ending',
    title: 'Ending your account',
    body: (
      <>
        <p>
          You can delete your account at any time in Me → Account. The <TextLink to="/privacy#your-data">privacy policy</TextLink> says what goes and what stays.
        </p>
        <p>We may suspend or close an account that abuses Reroute or breaks these terms.</p>
      </>
    ),
  },
  {
    id: 'law',
    title: 'Governing law',
    body: <p>These terms are governed by the laws of India, and the courts of India decide any dispute about them.</p>,
  },
  {
    id: 'changes',
    title: 'Changes to these terms',
    body: (
      <p>
        We may change these terms. When we do, we update this page and the effective date at the top, and the new terms apply from then on. If you don’t agree with them, stop using Reroute and delete your account.
      </p>
    ),
  },
  { id: 'contact', title: 'Contact us', body: <ContactUs /> },
]

export default function Terms() {
  return (
    <LegalPage
      title="Terms of use"
      effective="2026-11-23"
      lead={
        <p>
          These are the rules for using Reroute and Raasta, on the web and in the Android app. They’re short, and by using Reroute you agree to them.
        </p>
      }
      sections={SECTIONS}
      other={{ to: '/privacy', label: 'Privacy policy' }}
    />
  )
}
