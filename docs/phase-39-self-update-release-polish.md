# Phase 39 — Self-Update · Release Polish · README · One-Command Setup

Branched from `main` (`4828d86`, Phase 38). Makes Akorith feel closer to a public-ready
desktop product: an in-app **source updater**, a **Settings → Update** page, **composer
declutter**, **bigger user bubbles**, honest **Claude/Codex usage-limit** cards,
**Akorith app identity** (no "Electron" branding where fixable), a refreshed **README**
with screenshots, and **one-command setup** scripts. No website/release distribution yet.

## Environment note (acted on)

The repo lives in an **iCloud-synced** folder (`~/Desktop/...`). iCloud was evicting
`node_modules` into "dataless" placeholders, which hung `tsc`/`vite`/`npm` across phases
(and produced the recurring `" 2"` artifacts). Phase 39 relocates `node_modules` **out of
the iCloud tree** via a symlink to `~/Library/Application Support/akorith-dev/node_modules`
(never synced) and reinstalls there — npm reads/writes no longer hit iCloud. The new setup
script detects this and offers the same fix, so PC/Mac installs stay healthy.

## Plan & commits

- `39.1` Audit + plan (this doc) + relocate node_modules off iCloud.
- `39.2` Update manager types + config.
- `39.3` GitHub `origin/main` update checker (read-only git).
- `39.4` Safe update runner (fetch → switch main → ff-pull → optional install/build; never resets/discards).
- `39.5` Settings → Update page + Dashboard update card.
- `39.6` Update progress + logs UI (token-masked, no secrets).
- `39.7` Declutter composer secondary actions into a "More" popover.
- `39.8` Bigger user-message bubble radius (22–26px).
- `39.9` Usage-limit config model (honest; user-configured + local-usage estimate).
- `39.10` Dashboard Claude/Codex usage-limit cards + Settings config.
- `39.11` Akorith app identity (menu/title/About; no "Electron" where fixable).
- `39.12` One-command setup scripts (`setup-akorith.sh`/`.ps1`) + doctor.
- `39.13` Setup docs + machine bootstrap checklist.
- `39.14` README refresh (modern description, quick start, summaries).
- `39.15` Screenshot checklist + capture where possible.
- `39.16` macOS app cleanup/refresh tooling (reuse Phase 36 script).
- `39.17` Package/install latest macOS app.
- `39.18` Final validation + public-ready QA.

## Update safety contract

Read-only check first. Update **only** when: working tree clean, on/able-to-switch to
`main`, `origin/main` reachable, and the user confirms. The runner does `git fetch` →
`git switch main` → `git pull --ff-only` (+ optional `npm install` / `npm run build`).
**Never** `reset --hard`, discard changes, force-push, delete branches, touch other repos,
or run remote-supplied commands. Packaged (non-git) installs get an honest "source updater
only — packaged release updates coming later" message.

## Usage-limit honesty

Akorith has no official access to Claude/Codex remaining subscription limits. It **never
scrapes accounts, reads cookies, stores tokens, or fabricates remaining values**. The cards
show: Akorith's own recorded local usage in the window, the user-configured limit (if set),
the reset-window label, and an honest "exact remaining not exposed by the CLI" note.

## Preservation

No change to Claude/Codex/Ollama/OpenCode runtime/prompts/returns, token accounting, usage
logging, `bridgeSend → PtyManager.write`, PTY kinds, Olympus/Gaia/Atlantis, controller
security, `loopex.db`/`loopex.config.json`, AkorithLoop. No mission execution, no secrets.

## Validation

`typecheck`, `verify:local-executor`, `verify:workspace-loop`, `verify:controller`,
`build`, `npm run doctor --check`, `git diff --check`; manual smoke; then merge to main.
