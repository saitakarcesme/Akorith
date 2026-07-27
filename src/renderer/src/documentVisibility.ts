import { useSyncExternalStore } from 'react'

type VisibilityListener = () => void

const listeners = new Set<VisibilityListener>()
let listening = false

function visibleSnapshot(): boolean {
  return typeof document === 'undefined' || !document.hidden
}

function publishVisibility(): void {
  for (const listener of listeners) listener()
}

function subscribeVisibility(listener: VisibilityListener): () => void {
  listeners.add(listener)
  if (!listening && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', publishVisibility)
    listening = true
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && listening && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', publishVisibility)
      listening = false
    }
  }
}

/**
 * Shares one document visibility listener across every mounted feature.
 * Expensive renderer polling can pause while the Electron window is hidden,
 * while main-process agents continue running independently.
 */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, visibleSnapshot, () => true)
}
