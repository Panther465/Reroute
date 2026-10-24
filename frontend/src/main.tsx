import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { isNative } from './lib/platform'
import { handleStaleChunks } from './lib/reload'

handleStaleChunks()

function render() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

// Inside the Android app, Android's own pieces (sign-in token, voice, notifications, sharing, the back
// button) are put in place first. Only the Android build (`--mode android`) contains that code at all: a
// browser build drops it, and renders at once, as before.
if (import.meta.env.MODE === 'android' && isNative())
  void import('./native/boot')
    .then((m) => m.boot())
    .catch((err: unknown) => console.error('Reroute: the Android pieces failed to start', err))
    .finally(render)
else render()
