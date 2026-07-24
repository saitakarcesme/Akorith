import type { BrowserWindow, Event, Input } from 'electron'

/**
 * Akorith deliberately starts one step above Chromium's 100% default. Keep UI
 * zoom bounded so an accidental key repeat cannot make the interface unusable.
 */
export const DEFAULT_UI_ZOOM_FACTOR = 1.1
export const MIN_UI_ZOOM_FACTOR = 0.7
export const MAX_UI_ZOOM_FACTOR = 2
export const UI_ZOOM_STEP = 0.1

export type UiZoomAction = 'in' | 'out' | 'reset'

export interface UiZoomInput {
  type: Input['type']
  key: string
  code: string
  control: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

const windowZoomFactors = new WeakMap<BrowserWindow, number>()

function roundedFactor(value: number): number {
  return Math.round(value * 100) / 100
}

function clampedFactor(value: number): number {
  return Math.min(MAX_UI_ZOOM_FACTOR, Math.max(MIN_UI_ZOOM_FACTOR, roundedFactor(value)))
}

/** Pure calculation kept separate so the shortcut contract can be verified without Electron. */
export function calculateUiZoomFactor(current: number, action: UiZoomAction): number {
  if (action === 'reset') return DEFAULT_UI_ZOOM_FACTOR
  const safeCurrent = Number.isFinite(current) ? current : DEFAULT_UI_ZOOM_FACTOR
  return clampedFactor(safeCurrent + (action === 'in' ? UI_ZOOM_STEP : -UI_ZOOM_STEP))
}

/**
 * Resolve the platform's primary-modifier zoom chord. `=` is accepted because
 * the `+` glyph shares that physical key on common layouts; numpad codes are
 * handled explicitly. Alt-modified chords are left alone for AltGr/layout use.
 */
export function resolveUiZoomAction(
  input: UiZoomInput,
  platform: NodeJS.Platform = process.platform
): UiZoomAction | null {
  const primaryDown = platform === 'darwin' ? input.meta : input.control
  const otherPrimaryDown = platform === 'darwin' ? input.control : input.meta
  if (!primaryDown || otherPrimaryDown || input.alt) return null

  if (input.code === 'NumpadAdd' || input.key === '+' || input.key === '=') return 'in'
  if (input.code === 'NumpadSubtract' || input.key === '-') return 'out'
  if (!input.shift && (input.code === 'Digit0' || input.code === 'Numpad0' || input.key === '0')) {
    return 'reset'
  }
  return null
}

function setWindowZoomFactor(window: BrowserWindow, factor: number): boolean {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return false
  windowZoomFactors.set(window, factor)
  window.webContents.setZoomFactor(factor)
  return true
}

/** Called by both the application menu and the keyboard-event fallback. */
export function performUiZoom(window: BrowserWindow | null, action: UiZoomAction): boolean {
  if (!window || !windowZoomFactors.has(window)) return false
  const current = windowZoomFactors.get(window) ?? DEFAULT_UI_ZOOM_FACTOR
  return setWindowZoomFactor(window, calculateUiZoomFactor(current, action))
}

/**
 * Install app-local shortcuts on the main BrowserWindow. `before-input-event`
 * is preferable to a globalShortcut here: it works only while Akorith is
 * focused, can cover keyboard-layout/numpad variants, and lets us prevent the
 * chord from leaking into an editor or terminal input.
 */
export function installUiZoom(window: BrowserWindow, platform: NodeJS.Platform = process.platform): void {
  windowZoomFactors.set(window, DEFAULT_UI_ZOOM_FACTOR)

  window.webContents.on('before-input-event', (event: Event, input: Input) => {
    const action = resolveUiZoomAction(input, platform)
    if (!action) return

    // Consume every part of a recognized chord so it cannot type into focused
    // inputs. Apply once on keyDown; keyUp/char events are only suppressed.
    event.preventDefault()
    if (input.type === 'keyDown') performUiZoom(window, action)
  })

  // Renderer reloads/HMR reset Chromium's visual zoom. Preserve the current
  // per-window factor rather than silently snapping back to the default.
  window.webContents.on('did-finish-load', () => {
    setWindowZoomFactor(window, windowZoomFactors.get(window) ?? DEFAULT_UI_ZOOM_FACTOR)
  })

  window.once('closed', () => {
    windowZoomFactors.delete(window)
  })

  setWindowZoomFactor(window, DEFAULT_UI_ZOOM_FACTOR)
}
