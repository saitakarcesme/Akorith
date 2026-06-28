# Agent OS Foundation

Phase 28 adds a behavior-preserving foundation for turning Akorith into a local-first AI Agent Control Center. This phase does not replace the existing provider registry, PTY manager, macro loop, local executor, Test Lab, settings, or current user workflow.

## What Agent OS Means

Agent OS means Akorith can eventually coordinate multiple coding and automation agents through one local-first control center:

- Codex CLI
- Claude Code / Claude CLI
- Ollama and other local models
- OpenCode
- Future Hermes-style memory, skills, workflow memory, and automations
- Akorith's existing terminals, workspace projects, Test Lab, macro loop, autonomous loop, local executor, and AkorithLoop workspace concepts

The near-term goal is not a rewrite. The first step is a small typed foundation that can describe, detect, and later launch or orchestrate agents without disturbing existing runtime paths.

## Added In This Phase

- `src/main/agents/types.ts` defines Agent OS metadata, detection, status, and capability types.
- `src/main/agents/capabilities.ts` defines human-readable capability labels.
- `src/main/agents/status.ts` adds shared safe detection helpers.
- `src/main/agents/registry.ts` lists adapters and exposes read-only detection functions.
- `src/main/agents/adapters/claude.ts` documents the existing Claude provider and PTY integration.
- `src/main/agents/adapters/codex.ts` documents the existing Codex provider and PTY integration.
- `src/main/agents/adapters/ollama.ts` documents the existing Ollama/local provider and uses a conservative HTTP reachability check.
- `src/main/agents/adapters/opencode.ts` adds a future-ready OpenCode metadata/detection placeholder.
- `src/main/agents/adapters/memory.ts` adds a future internal Memory / Skills placeholder.
- `src/main/loops/types.ts` centralizes main-process macro loop status, mode, and executor type aliases.
- The existing preload `agent` namespace now includes read-only `list`, `detect`, and `detectAll` calls.
- Settings now includes a minimal Agent Hub surface for metadata and detection.
- `src/renderer/src/styles.css` includes unused future monochrome token notes for the eventual black-and-white identity.

## Intentionally Not Changed

- Existing Claude, Codex, and Ollama provider behavior remains in `src/main/providers/*`.
- Existing provider/model selectors remain unchanged.
- Existing PTY command kinds and terminal startup remain unchanged.
- The chat-to-terminal invariant remains `bridgeSend()` to `PtyManager.write()`.
- The DB filename remains `loopex.db`.
- The config filename remains `loopex.config.json`.
- AkorithLoop remains separate.
- The app was not globally redesigned and logo/icon assets were not replaced.
- No OpenCode execution path was added.
- No durable memory or skills store was added.

## Existing Providers And New Adapters

The new Agent OS adapters are parallel metadata and detection objects. They do not send prompts and do not start sessions.

- Claude still runs through `src/main/providers/claude.ts` for chat/meta calls and `src/main/pty.ts` for terminal sessions.
- Codex still runs through `src/main/providers/chatgpt.ts` for chat/meta calls and `src/main/pty.ts` for terminal sessions.
- Ollama still runs through `src/main/providers/local.ts`, `src/main/ollama-connection.ts`, and local executor paths.
- The new adapters only describe those integrations and provide safe detection results for the future Agent Hub.

## OpenCode Later

OpenCode should be added as a true AgentAdapter after its CLI behavior, session model, output format, permission prompts, and file-editing semantics are verified. The placeholder adapter only runs `opencode --version` and clearly reports that OpenCode is not connected to chat, PTY, or loop execution yet.

## Memory And Skills Later

The Memory / Skills adapter represents a future internal layer for project memory, reusable skills, workflow recipes, and automation memory. It does not replace SQLite chat history or conversation summaries in this phase. Future memory should be local, auditable, permissioned, and wired into the Mission Engine deliberately.

## AkorithLoop Relationship

AkorithLoop should remain separate for now. The current Akorith structure already treats AkorithLoop as a workspace/output repository for generated loop projects and automation artifacts. If a headless loop runtime is needed later, it should be extracted deliberately from Akorith's loop core instead of merging the AkorithLoop workspace repository into the app.

## Future Monochrome UI Direction

Akorith is expected to move toward a radical black-and-white identity: mostly black, white, and dark gray, with no colorful provider branding unless absolutely necessary. This phase only adds future token notes. The existing provider colors, logo assets, dashboard colors, loop status colors, and terminal theme are intentionally unchanged.

## Branch Strategy

This work lives on `feature/phase-28-agent-os-foundation`.

`main` must remain untouched until this branch is reviewed and merged later.
