# Loopex

A desktop workspace that orchestrates coding agents without API keys — planner chat on
the right, real executor terminals in the center, session history on the left.

Built with Electron + TypeScript + React via electron-vite.

## Status

- **Phase 1** — static three-region shell (sidebar / two xterm panes / planner chat): done
- **Phase 2** — real interactive PTY terminals via node-pty: done

## Develop

```powershell
npm install   # postinstall rebuilds native modules against Electron's ABI
npm run dev
```

`npm run typecheck` type-checks main, preload, and renderer.
