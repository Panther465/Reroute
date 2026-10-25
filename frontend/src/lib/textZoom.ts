// The phone's own text size. Inside the Android app, the web view grows every font by Android's text size (130% makes a
// 16 px font 20.8 px), but not the space around it, so big headings crowd the screen. Android's own apps grow big type
// less than body text (non-linear font scaling); the type scale in index.css does the same with --tz, the factor set
// here. In a browser it's 1: a browser's own text size setting changes rem, not this.

/** How much the web view grows text: a 100 px font measured as it's drawn. */
export function measureTextZoom(): number {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;visibility:hidden;font-size:100px'
  document.documentElement.appendChild(probe)
  const zoom = parseFloat(getComputedStyle(probe).fontSize) / 100
  probe.remove()
  return Number.isFinite(zoom) && zoom > 0 ? Math.round(zoom * 100) / 100 : 1
}

/** Sets --tz on the page, now and whenever the app comes back (the text size may have changed meanwhile). */
export function followTextZoom() {
  const apply = () => document.documentElement.style.setProperty('--tz', String(measureTextZoom()))
  apply()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') apply()
  })
}
