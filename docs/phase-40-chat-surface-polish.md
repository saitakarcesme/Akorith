# Phase 40 — Chat Surface Polish

Branched from `main` (`601d78b`, post-Phase-39). UI-only polish of three chat-surface
issues found in visual testing. No feature, provider, runtime, token, controller, PTY,
or mission changes.

## Audit findings (root causes)

`styles.css` has accumulated several same-specificity `.chat-msg.user` rules across phases;
**later rules win per-property**, so earlier intent was silently overridden:

- **Bubble looked square** — `.chat-msg.user { border-radius: var(--radius) }` at the late
  rule (~L7912) overrode Phase 39.8's `24px` radius. `--radius` is only **5px**.
- **Bubble felt too tall** — effective padding was `12px 16px` (~L7661) with `line-height: 1.6`.
- **Code/markdown blocks overflowed** — `.chat-msg` (the Codex-style row) had no `min-width: 0`,
  so a wide `<pre>` (which used `overflow-x: auto` / no wrapping) stretched the row and clipped
  content on the right instead of fitting the 760px column.
- **Composer felt square** — `.composer-box { border-radius: var(--radius-lg) }` = **8px**.

## Changes (all in `src/renderer/src/styles.css`)

- **User bubble (40.2):** effective rule → `border-radius: 26px 26px 10px 26px`,
  `line-height: 1.5`; effective padding → `9px 18px`. Still right-aligned, white in dark mode,
  dark text, ~74% max-width. Assistant rows untouched.
- **Code/markdown overflow (40.3):** `.chat-msg { min-width: 0; overflow-wrap: break-word }`;
  `.chat-code` + `.chat-code pre { max-width: 100%; box-sizing: border-box }`; `.chat-code pre`
  now `white-space: pre-wrap; overflow-wrap: break-word; word-break: normal` (wrap, preserving
  indentation + copy content) with `overflow-x: auto` as a fallback for unbreakable tokens;
  `.chat-msg-text` wraps long prose/URLs. Copy header/buttons unaffected; nothing clips.
- **Composer (40.4):** `.composer-box { border-radius: 22px }` (both the hero/general and
  docked/workspace variants share this surface). Focus stays subtle (background shift only,
  no outline); no separator line above the composer.

## Unchanged

Assistant/output message style, provider runtime, token accounting, controller security,
PTY/bridge, Agent/Mission/Loop behavior. No new features.

## Validation

`typecheck`, `build`, `git diff --check` (+ verify scripts); manual smoke; then merge to main.
