// A small i18n layer. English is the source; Hindi covers the chrome and core flows.
import { useCallback } from 'react'
import { useStore } from './store'

const hi: Record<string, string> = {
  Today: 'आज',
  Plan: 'योजना',
  Raasta: 'रास्ता',
  Me: 'मैं',
  'On time': 'समय पर',
  Offline: 'ऑफ़लाइन',
  Blocked: 'रुकावट',
  'Running late': 'देर हो रही है',
  'Check in': 'चेक इन',
  'Leave by': 'निकलें',
  'Leave now': 'अभी निकलें',
  'Reroute my day': 'मेरा दिन बदलें',
  'Update my times': 'मेरे समय बदलें',
  'Keep the current plan': 'मौजूदा योजना रखें',
  'Rerouting…': 'बदल रहे हैं…',
  Undo: 'वापस लें',
  Share: 'साझा करें',
  'Reroute log': 'बदलावों का रिकॉर्ड',
  'Try again': 'फिर कोशिश करें',
  "You're offline. Your plan still works, and changes sync when you're back.":
    'आप ऑफ़लाइन हैं। आपकी योजना काम करती रहेगी, और वापस आने पर बदलाव सिंक हो जाएंगे।',
  "Couldn't load your plan. Check your connection and try again.": 'आपकी योजना लोड नहीं हो सकी। कनेक्शन जांचें और फिर कोशिश करें।',
  'Language': 'भाषा',
  'Theme': 'थीम',
  System: 'सिस्टम',
  Light: 'हल्की',
  Dark: 'गहरी',
  Notifications: 'सूचनाएं',
  'Sign out': 'साइन आउट करें',
  'Delete my location history': 'मेरा लोकेशन इतिहास मिटाएं',
  'New trip': 'नई यात्रा',
  'Your tasks': 'आपके काम',
  'Add a task': 'काम जोड़ें',
  'Plan my day': 'मेरा दिन प्लान करें',
  'Planning your day…': 'आपका दिन प्लान हो रहा है…',
  'Start this leg': 'यह सफ़र शुरू करें',
  'It still runs': 'यह अब भी चलता है',
  'Report a fare': 'किराया बताएं',
  Fare: 'किराया',
  'How often': 'कितनी बार',
  'Last one': 'आखिरी',
  'Last confirmed': 'आखिरी पुष्टि',
  Verified: 'पुष्ट',
  Unverified: 'अपुष्ट',
  Now: 'अभी',
  'Add a route': 'रास्ता जोड़ें',
  'Nearby stands': 'पास के स्टैंड',
  'Where from?': 'कहां से?',
  'Where to?': 'कहां तक?',
  'Day summary': 'दिन का सार',
  'Your day is done': 'आपका दिन पूरा हुआ',
  'Profile': 'प्रोफ़ाइल',
}

export function useT() {
  const lang = useStore((s) => s.lang)
  return useCallback(
    (en: string, vars?: Record<string, string | number>) => {
      let out = lang === 'hi' ? (hi[en] ?? en) : en
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v))
      return out
    },
    [lang],
  )
}

/** Props for text that may render in Hindi. */
export function useLangAttr(en: string) {
  const lang = useStore((s) => s.lang)
  return lang === 'hi' && hi[en] ? { lang: 'hi' } : {}
}
