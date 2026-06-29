import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProviderInfo } from '../../../preload/index.d'
import { ChevronIcon } from './icons'

interface ModelPickerProps {
  providers: ProviderInfo[] | null
  providerId: string
  model: string
  disabled?: boolean
  /** Selecting a model also selects its provider (one call for both). */
  onSelect: (providerId: string, model: string) => void
  onRefresh?: () => void
  /** Phase 33.15: optional per-model source label (e.g. "Local", "Remote: PC"). */
  modelSource?: (providerId: string, model: string) => string | undefined
}

interface FlatOption {
  providerId: string
  model: string
}

/**
 * Phase 33.8/33.9/33.15: composer-integrated, custom-styled model/provider
 * picker. Replaces the native `<select>` controls (which rendered as a white
 * browser dropdown on the dark UI) with a compact dark popover/listbox:
 * provider-grouped, source-labelled, keyboard + mouse friendly. It owns no
 * model state — it only reports the chosen (providerId, model) upward.
 */
export default function ModelPicker({
  providers,
  providerId,
  model,
  disabled,
  onSelect,
  onRefresh,
  modelSource
}: ModelPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [dropUp, setDropUp] = useState(false)

  const selected = providers?.find((p) => p.id === providerId) ?? null
  const available = providers?.filter((p) => p.available.ok) ?? []

  // Flattened, ordered list of selectable (provider, model) pairs for keyboard
  // navigation. Providers with no models are still selectable (model = '').
  const flat = useMemo<FlatOption[]>(() => {
    const out: FlatOption[] = []
    for (const provider of providers ?? []) {
      if (!provider.available.ok) continue
      if (provider.models.length === 0) out.push({ providerId: provider.id, model: '' })
      else for (const m of provider.models) out.push({ providerId: provider.id, model: m })
    }
    return out
  }, [providers])

  const currentIndex = flat.findIndex((o) => o.providerId === providerId && o.model === (model || ''))

  useEffect(() => {
    if (!open) return
    setActiveIndex(currentIndex >= 0 ? currentIndex : 0)
  }, [open, currentIndex])

  // Open upward when there isn't room below (the composer sits near the bottom).
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return
    const rect = rootRef.current.getBoundingClientRect()
    setDropUp(window.innerHeight - rect.bottom < 320)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDocKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        rootRef.current?.querySelector<HTMLButtonElement>('.model-picker-trigger')?.focus()
      }
    }
    document.addEventListener('keydown', onDocKey)
    return () => document.removeEventListener('keydown', onDocKey)
  }, [open])

  const choose = (option: FlatOption): void => {
    onSelect(option.providerId, option.model)
    setOpen(false)
    rootRef.current?.querySelector<HTMLButtonElement>('.model-picker-trigger')?.focus()
  }

  const onListKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((i) => Math.min(flat.length - 1, i + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const option = flat[activeIndex]
      if (option) choose(option)
    }
  }

  const triggerLabel = ((): string => {
    if (!providers) return 'Loading…'
    if (!selected) return available.length ? 'Select model' : 'No providers'
    return model || selected.label
  })()
  const triggerSub = selected ? selected.label : undefined
  const unavailable = Boolean(selected && !selected.available.ok)

  return (
    <div className={`model-picker ${open ? 'is-open' : ''} ${unavailable ? 'is-unavailable' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="model-picker-trigger"
        disabled={disabled || !providers?.length}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Provider and model for this chat"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="model-picker-dot" />
        <span className="model-picker-label">
          {triggerSub && triggerSub !== triggerLabel && <span className="model-picker-provider">{triggerSub}</span>}
          <span className="model-picker-model">{triggerLabel}</span>
        </span>
        <ChevronIcon size={12} direction={open ? 'up' : 'down'} />
      </button>

      {open && (
        <>
          <div className="model-picker-backdrop" onClick={() => setOpen(false)} />
          <div
            className={`model-picker-pop ${dropUp ? 'is-up' : ''}`}
            role="listbox"
            ref={popRef}
            tabIndex={-1}
            onKeyDown={onListKeyDown}
          >
            <div className="model-picker-pop-head">
              <span>Model</span>
              {onRefresh && (
                <button type="button" className="model-picker-refresh" title="Refresh providers" onClick={() => onRefresh()}>
                  ↻
                </button>
              )}
            </div>
            <div className="model-picker-pop-list">
              {(providers ?? []).map((provider) => {
                const isUnavail = !provider.available.ok
                return (
                  <div className={`model-picker-group ${isUnavail ? 'is-unavailable' : ''}`} key={provider.id}>
                    <div className="model-picker-group-head">
                      <span className="model-picker-group-name">{provider.label}</span>
                      {isUnavail && <span className="model-picker-group-tag">unavailable</span>}
                    </div>
                    {isUnavail
                      ? provider.available.reason && (
                          <div className="model-picker-group-reason">{provider.available.reason}</div>
                        )
                      : (provider.models.length ? provider.models : ['']).map((m) => {
                          const idx = flat.findIndex((o) => o.providerId === provider.id && o.model === m)
                          const isSel = provider.id === providerId && (model || '') === m
                          const source = modelSource?.(provider.id, m)
                          return (
                            <button
                              type="button"
                              role="option"
                              aria-selected={isSel}
                              key={`${provider.id}-${m || 'default'}`}
                              className={`model-picker-option ${isSel ? 'is-selected' : ''} ${idx === activeIndex ? 'is-active' : ''}`}
                              onMouseEnter={() => idx >= 0 && setActiveIndex(idx)}
                              onClick={() => choose({ providerId: provider.id, model: m })}
                            >
                              <span className="model-picker-option-name">{m || provider.label}</span>
                              {source && <span className="model-picker-source">{source}</span>}
                              {isSel && <span className="model-picker-check">✓</span>}
                            </button>
                          )
                        })}
                  </div>
                )
              })}
              {!providers?.length && <div className="model-picker-empty">No providers configured.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
