# Loopex

A desktop workspace that orchestrates coding agents without API keys — planner chat on
the right, real executor terminals in the center, session history on the left.

Built with Electron + TypeScript + React via electron-vite.

## Status

- **Phase 1** — static three-region shell (sidebar / two xterm panes / planner chat): done
- **Phase 2** — real interactive PTY terminals via node-pty: done
- **Phase 3** — pluggable provider registry (Claude / ChatGPT / Ollama, API-key-free) + working planner chat: done

See [AGENTS.md](AGENTS.md) for architecture, the provider contract, and how to add a provider.

## Develop

```powershell
npm install
npm run dev
```

`npm run typecheck` type-checks main, preload, and renderer.

### Native modules (node-pty)

node-pty 1.1.0 ships **N-API prebuilt binaries** (`prebuilds/win32-x64`), which load in
Electron's main process without an ABI rebuild — verified at runtime; a clean
`npm install && npm run dev` just works. There is deliberately **no postinstall rebuild**:
`@electron/rebuild` cannot compile node-pty 1.1.0 from the npm tarball (it lacks winpty's
git metadata — `GetCommitHash.bat` fails), so wiring it into postinstall would break
clean installs for zero benefit.

If a future native module *does* need an Electron ABI rebuild, the escape hatch is wired:

```powershell
npm run rebuild   # electron-rebuild -f -w node-pty (extend -w as needed)
```

node-pty must stay in `dependencies` (electron-vite's `externalizeDepsPlugin` externalizes
it from the main bundle) and is only ever imported by the main process.
