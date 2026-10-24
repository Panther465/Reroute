import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const app = vi.hoisted(() => ({ addListener: vi.fn(async () => ({ remove: async () => {} })), minimizeApp: vi.fn(async () => {}) }))
const bars = vi.hoisted(() => ({ setStyle: vi.fn(async () => {}) }))
const edge = vi.hoisted(() => ({ setStatusBarColor: vi.fn(async () => {}), setNavigationBarColor: vi.fn(async () => {}) }))
vi.mock('@capacitor/app', () => ({ App: app }))
vi.mock('@capacitor/core', () => ({ SystemBars: bars, SystemBarsStyle: { Dark: 'DARK', Light: 'LIGHT', Default: 'DEFAULT' } }))
vi.mock('@capawesome/capacitor-android-edge-to-edge-support', () => ({ EdgeToEdge: edge }))

import { getState, setState } from '@/lib/store'
import { BARS, onBack, startShell, systemBars } from './shell'

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  document.body.innerHTML = ''
  setState({ rooChat: false })
})

describe("the app's frame", () => {
  it('colours the bars for the theme, with icons that stay readable', () => {
    systemBars(true)
    expect(bars.setStyle).toHaveBeenLastCalledWith({ style: 'DARK' })
    expect(edge.setStatusBarColor).toHaveBeenLastCalledWith({ color: BARS.dark.status })
    expect(edge.setNavigationBarColor).toHaveBeenLastCalledWith({ color: BARS.dark.navigation })
    systemBars(false)
    expect(bars.setStyle).toHaveBeenLastCalledWith({ style: 'LIGHT' })
    expect(edge.setStatusBarColor).toHaveBeenLastCalledWith({ color: '#EDF0EB' })
  })

  it('listens for the back button and for the app coming back', async () => {
    const resume = vi.fn()
    await startShell(resume)
    expect(app.addListener).toHaveBeenCalledWith('backButton', expect.any(Function))
    expect(app.addListener).toHaveBeenCalledWith('resume', resume)
  })
})

describe("Android's back button", () => {
  it('closes a sheet on top first, as Escape does', () => {
    document.body.innerHTML = '<div role="dialog" data-state="open"><button>Done</button></div>'
    const keys: string[] = []
    document.addEventListener('keydown', (e) => keys.push(e.key), { once: true })
    onBack(true)
    expect(keys).toEqual(['Escape'])
    expect(app.minimizeApp).not.toHaveBeenCalled()
  })

  it("closes Rico's chat", () => {
    setState({ rooChat: true })
    onBack(true)
    expect(getState().rooChat).toBe(false)
  })

  it('goes back a screen, as the browser does', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    onBack(true)
    expect(back).toHaveBeenCalled()
    back.mockRestore()
  })

  it('steps aside to the home screen from the first screen', () => {
    onBack(false)
    expect(app.minimizeApp).toHaveBeenCalled()
  })
})
