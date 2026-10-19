// A small i18n layer. English is the source; Hindi covers the chrome and core flows.
import { createElement, Fragment, useCallback } from 'react'
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
  "You're offline. Try again when you have signal.": 'आप ऑफ़लाइन हैं। सिग्नल मिलने पर फिर कोशिश करें।',
  'Done with the {task}': '{task} पूरा हुआ',
  'Check in at the {task}': '{task} पर चेक इन करें',
  'Check in now': 'अभी चेक इन करें',
  'Not yet': 'अभी नहीं',
  'Choose how to fix your day': 'अपना दिन ठीक करने का तरीका चुनें',
  'Edit the {task}': '{task} बदलें',
  'Skip the {task}': '{task} छोड़ें',
  'Skip it': 'छोड़ दें',
  Cancel: 'रद्द करें',
  Edit: 'बदलें',
  'Saving…': 'सेव हो रहा है…',
  'Re-planning…': 'फिर से प्लान हो रहा है…',
  'Save changes': 'बदलाव सेव करें',
  'Add this task': 'यह काम जोड़ें',
  'Edit this task': 'यह काम बदलें',
  'Share your trip': 'अपनी यात्रा साझा करें',
  'Share live trip': 'लाइव यात्रा साझा करें',
  'Stop sharing': 'साझा करना बंद करें',
  Copy: 'कॉपी करें',
  'See the options': 'विकल्प देखें',
  Dismiss: 'हटाएं',
  'Something went wrong on this screen.': 'इस स्क्रीन पर कुछ गड़बड़ हो गई।',
  Reload: 'फिर से लोड करें',
  'Skip to content': 'मुख्य सामग्री पर जाएं',
  'See the day summary': 'दिन का सार देखें',
  'Find routes': 'रास्ते खोजें',
  'Submit for checking': 'जांच के लिए भेजें',
  'Send the fare': 'किराया भेजें',
  'Your trip': 'आपकी यात्रा',
  'Your activity': 'आपकी गतिविधि',
  'Time to leave': 'निकलने का समय',
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

/** Text and its language: `lang` is "hi" only when a Hindi string was found. */
export interface Translated {
  text: string
  lang?: 'hi'
}

/** Like useT, but says which language came back, for props such as a sheet's titleLang. */
export function useTl() {
  const lang = useStore((s) => s.lang)
  return useCallback(
    (en: string, vars?: Record<string, string | number>): Translated => {
      const found = lang === 'hi' ? hi[en] : undefined
      let text = found ?? en
      if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, String(v))
      return found ? { text, lang: 'hi' } : { text }
    },
    [lang],
  )
}

/** Translated UI text. Hindi renders in a span with lang="hi" (UI brief 11); English renders as plain text. */
export function T({ k, vars }: { k: string; vars?: Record<string, string | number> }) {
  const { text, lang } = useTl()(k, vars)
  return lang ? createElement('span', { lang }, text) : createElement(Fragment, null, text)
}

/** Props for text that may render in Hindi. */
export function useLangAttr(en: string) {
  const lang = useStore((s) => s.lang)
  return lang === 'hi' && hi[en] ? { lang: 'hi' } : {}
}
