// The Android app's frame: the status and navigation bars follow the theme (a browser follows theme-color),
// and Android's back button works the way the browser's back does, closing what's open on top first.
import { App } from '@capacitor/app'
import { SystemBars, SystemBarsStyle } from '@capacitor/core'
import { EdgeToEdge } from '@capawesome/capacitor-android-edge-to-edge-support'
import { getState, setState } from '@/lib/store'

/** The status bar takes the page's ground colour; the navigation bar the tab bar's surface below it. */
export const BARS = {
  light: { status: '#EDF0EB', navigation: '#FFFFFF' },
  dark: { status: '#10161F', navigation: '#18202B' },
}

export function systemBars(dark: boolean) {
  const colors = dark ? BARS.dark : BARS.light
  // Dark bars carry light icons, and light bars dark ones.
  void SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {})
  void EdgeToEdge.setStatusBarColor({ color: colors.status }).catch(() => {})
  void EdgeToEdge.setNavigationBarColor({ color: colors.navigation }).catch(() => {})
}

/** Something open on top: a sheet, a dialog, Rico's chat or a popover. */
const OPEN_LAYER = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
/** Their own close buttons: "Close", "Close the chat", "Close Rico’s message". */
const CLOSE = 'button[aria-label^="Close"]'

/**
 * Android's back button. A sheet or dialog on top closes (as its close button or Escape closes it); otherwise
 * the app goes back a screen, as a browser does; on the first screen it steps aside to the home screen, as
 * Android apps do.
 */
export function onBack(canGoBack: boolean) {
  const open = document.querySelectorAll<HTMLElement>(OPEN_LAYER)
  const top = open[open.length - 1]
  if (top) {
    // Its own close button where it has one. Escape goes to the newest layer, so with a toast showing it would
    // close the toast and leave the sheet; Android's back leaves a toast be (as a snackbar), Undo and all.
    const close = top.querySelector<HTMLElement>(CLOSE)
    if (close) close.click()
    else (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    return
  }
  if (getState().rooChat) {
    setState({ rooChat: false })
    return
  }
  if (canGoBack) window.history.back()
  else void App.minimizeApp()
}

export async function startShell(onResume: () => void) {
  await App.addListener('backButton', ({ canGoBack }) => onBack(canGoBack))
  await App.addListener('resume', onResume)
}
