# Safety model (Loop · Companions · Agents)

Akorith's new features are local-first and deliberately conservative. Safety is **deterministic
and in-code** — the model never decides what is allowed.

## Companions — no actions at all

Companions **cannot** run commands, edit files, create commits, send terminal input, call
Agents or Loop, or change settings. Their system prompts declare this and forbid claiming to
have acted. Asserted by `npm run verify:companions`.

## Shared guardrails (`src/main/safety/`)

- **Path containment** (`paths.ts`) — writes must be relative and stay inside the selected
  root; no absolute paths, no `..` escape, no `.git`/`node_modules`, no secret/`.env`/key/pem
  files. (`verify-local-runtime` caught and fixed a real traversal bug here.)
- **Command allowlist** (`commands.ts`) — only typecheck/build/test/lint-style commands; hard
  denials for `rm -rf`, installs, `sudo`, `curl|wget`, chaining/redirection, `..`.
- **Patch validation** (`patch.ts`) — file-count + size caps; deletes off by default.
- **Git guards** (`git.ts`) — push requires explicit `pushEnabled` and is never forced;
  `reset --hard` / `clean -fd` / `rebase` / remote reconfig always denied.

## Loop

Runs never push (push is a separate, gated action). The local-executor validates every patch,
scores it, and rolls back non-commit-worthy attempts. Loop only writes inside the selected
project root.

## Agents

Default permission is **preview** (nothing written/run). Agents never delete files. Higher
modes allow root-contained writes and allowlisted commands only, with every action logged and
a risk level surfaced before running. Asserted by `npm run verify:agents`.

## Honesty

Unsupported capabilities are marked honestly in the UI and docs (e.g. PDF parsing). No
GPU/model/usage data is fabricated.
