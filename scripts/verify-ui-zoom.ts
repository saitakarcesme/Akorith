import {
  DEFAULT_UI_ZOOM_FACTOR,
  MAX_UI_ZOOM_FACTOR,
  MIN_UI_ZOOM_FACTOR,
  calculateUiZoomFactor,
  installUiZoom,
  resolveUiZoomAction,
  type UiZoomInput
} from '../src/main/ui-zoom'
import type { BrowserWindow, Event, Input } from 'electron'

function assert(value: unknown, label: string): void {
  if (!value) throw new Error(`[fail] ${label}`)
  console.log(`[ok] ${label}`)
}

function key(overrides: Partial<UiZoomInput>): UiZoomInput {
  return {
    type: 'keyDown',
    key: '',
    code: '',
    control: false,
    meta: false,
    shift: false,
    alt: false,
    ...overrides
  }
}

assert(resolveUiZoomAction(key({ control: true, key: '+' }), 'win32') === 'in', 'Windows Ctrl++ zooms in')
assert(resolveUiZoomAction(key({ control: true, key: '=' }), 'win32') === 'in', 'Windows Ctrl+= zooms in')
assert(resolveUiZoomAction(key({ control: true, code: 'NumpadAdd' }), 'win32') === 'in', 'Windows Ctrl+numpad plus zooms in')
assert(resolveUiZoomAction(key({ control: true, key: '-' }), 'linux') === 'out', 'Linux Ctrl+- zooms out')
assert(resolveUiZoomAction(key({ control: true, code: 'NumpadSubtract' }), 'win32') === 'out', 'Windows Ctrl+numpad minus zooms out')
assert(resolveUiZoomAction(key({ meta: true, key: '+' }), 'darwin') === 'in', 'macOS Cmd++ zooms in')
assert(resolveUiZoomAction(key({ meta: true, key: '=' }), 'darwin') === 'in', 'macOS Cmd+= zooms in')
assert(resolveUiZoomAction(key({ meta: true, key: '-' }), 'darwin') === 'out', 'macOS Cmd+- zooms out')
assert(resolveUiZoomAction(key({ meta: true, code: 'Digit0' }), 'darwin') === 'reset', 'macOS Cmd+0 resets')
assert(resolveUiZoomAction(key({ control: true, code: 'Numpad0' }), 'win32') === 'reset', 'Windows Ctrl+numpad 0 resets')

assert(resolveUiZoomAction(key({ key: '+' }), 'win32') === null, 'plain plus is not intercepted')
assert(resolveUiZoomAction(key({ meta: true, key: '+' }), 'win32') === null, 'Windows Meta+plus is not intercepted')
assert(resolveUiZoomAction(key({ control: true, key: '+' }), 'darwin') === null, 'macOS Control+plus is not intercepted')
assert(resolveUiZoomAction(key({ control: true, alt: true, key: '=' }), 'win32') === null, 'AltGr-style chord is not intercepted')
assert(resolveUiZoomAction(key({ control: true, key: 'a' }), 'win32') === null, 'unrelated primary-modifier chord is not intercepted')

assert(calculateUiZoomFactor(DEFAULT_UI_ZOOM_FACTOR, 'in') === 1.2, 'zoom increases in stable 10% steps')
assert(calculateUiZoomFactor(1.2, 'out') === DEFAULT_UI_ZOOM_FACTOR, 'zoom decreases without floating-point drift')
assert(calculateUiZoomFactor(MAX_UI_ZOOM_FACTOR, 'in') === MAX_UI_ZOOM_FACTOR, 'zoom is capped at 200%')
assert(calculateUiZoomFactor(MIN_UI_ZOOM_FACTOR, 'out') === MIN_UI_ZOOM_FACTOR, 'zoom is capped at 70%')
assert(calculateUiZoomFactor(1.7, 'reset') === DEFAULT_UI_ZOOM_FACTOR, 'reset restores Akorith default 110%')
assert(calculateUiZoomFactor(Number.NaN, 'in') === 1.2, 'invalid factor safely falls back to the default')

const listeners = new Map<string, (...args: unknown[]) => void>()
const zoomFactors: number[] = []
let closedListener: (() => void) | undefined
const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    setZoomFactor: (factor: number) => zoomFactors.push(factor),
    on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)
  },
  once: (event: string, listener: () => void) => {
    if (event === 'closed') closedListener = listener
  }
} as unknown as BrowserWindow

installUiZoom(fakeWindow, 'win32')
assert(zoomFactors.at(-1) === DEFAULT_UI_ZOOM_FACTOR, 'window installation applies the default zoom')
let prevented = 0
listeners.get('before-input-event')?.(
  { preventDefault: () => { prevented += 1 } } as Event,
  key({ control: true, key: '+' }) as Input
)
assert(prevented === 1, 'recognized zoom input is kept out of focused editors and terminals')
assert(zoomFactors.at(-1) === 1.2, 'installed before-input handler applies one zoom step')
listeners.get('did-finish-load')?.()
assert(zoomFactors.at(-1) === 1.2, 'renderer reload preserves the per-window zoom factor')
closedListener?.()

console.log('UI zoom verification passed.')
