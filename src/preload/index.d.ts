// Shape of the preload bridge as seen from the renderer.
// Phase 1 exposes an empty object; later phases extend this interface in
// lockstep with src/preload/index.ts.
export interface PreloadApi {
  // TODO(phase 2): terminal session methods
  // TODO(phase 3): planner chat + prompt-bridge methods
  // TODO(phase 4): session history methods
}

declare global {
  interface Window {
    api: PreloadApi
  }
}

export {}
