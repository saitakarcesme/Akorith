// Phase 56: CJS bootstrap for the live-test harness. Electron loads this (a real
// .cjs entry), which registers tsx's require hook so the TypeScript harness (and
// the real src/main/*.ts modules it imports) transpile on the fly.
require('tsx/cjs')
require('./harness.ts')
