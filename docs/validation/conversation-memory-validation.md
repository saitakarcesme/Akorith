# Conversation memory & context reliability — validation (Phase 14.2)

## The original bug

The chat UI showed full message history, but the **model never received it**. In the
same visible session the model would say things like *"This is your first message"* or
*"We have not talked about anything in this conversation."* Memory appeared broken even
inside one chat.

## Root cause

`chat:send` in `src/main/providers/registry.ts` called:

```ts
const result = await provider.send(promptForProvider, …)
```

where `promptForProvider` was **only the current user prompt** (optionally with a repo
digest prepended). Prior session messages were never loaded or sent. Every provider is a
single-shot, stateless call (`claude -p` over stdin, `codex` CLI, Ollama `/api/chat` with
a single user message) — so with no history in the prompt, each turn was an isolated
one-off. The DB *did* persist messages per session; they were simply never read back into
the request.

## What changed

- **Session context is now assembled on every send.** `chat:send` loads the session's
  prior messages (`getSessionMessages`, strictly `WHERE session_id = ?`) **before**
  persisting the new one, then builds the provider prompt with the new electron-free core
  `src/main/conversation.ts` (`renderProviderPrompt`). The prompt is framed as an ongoing
  conversation with role-tagged turns and the new message last, so the model continues the
  same thread.
- **Memory is strictly per-session.** Only the active session's rows are read, so one chat
  cannot inherit another's history, and a project workspace chat cannot inherit a different
  project's chat — each is a distinct `session_id`. General Chat (`project_id = NULL`) and
  Workspace sessions remain separate exactly as before.
- **Bounded context policy.** `selectContextWindow` keeps the most recent turns verbatim,
  bounded by both count (`recentVerbatim = 24`) and a char budget (`maxChars = 48k`), always
  keeping at least the newest message. When a session grows past that, the older turns are
  compressed into a **cached session summary** via a meta call (`sendMetaPrompt` → **no
  `usage_events`**), stored on the session (`sessions.context_summary` +
  `context_summary_count`) and regenerated only when the older window grows. Recent turns
  are always sent verbatim, so the session keeps feeling like it remembers.
- **New Chat / restore are context-safe.** New Chat opens a brand-new `session_id` with no
  prior messages → genuinely fresh. Restoring a Recent Chat reloads that session's messages
  AND its real memory stats. Switching projects restores that project's session.
- **Memory indicator + reset control** near the composer (see below).
- **Agent summaries join session memory.** `agent:summarize` now accepts the active
  `sessionId` and persists the summary as an assistant message in that session (scoped to
  that one session), so later follow-ups in the same Workspace chat can reference what the
  agent did. Still a meta call — the summary text is stored as a message but writes no
  `usage_event`.

## Memory policy (bounded context)

| Aspect | Behavior |
|--------|----------|
| Recent turns | Up to 24 most-recent messages sent verbatim |
| Char budget | Verbatim transcript capped ~48k chars (always keeps newest) |
| Older turns | Compressed into a cached per-session summary (meta call, no usage_event) |
| Summary refresh | Only when the older (non-verbatim) window grows |
| Scope | Strictly per `session_id` — no cross-chat / cross-project leakage |
| Repo digest | Workspace only, opt-in, prepended as read-only context (unchanged) |

## Context indicator behavior

A compact bar sits directly under the composer text box:

- `Memory: N msgs` — number of messages in this session's memory.
- `· summarized K` — when older turns have been compressed into a summary.
- `· Repo on` — Workspace only, when the repo digest is also included.
- `Session memory on` / `New chat — memory on` before the first turn.
- Tooltip explains: recent messages are sent in full, older ones are summarized, with an
  approximate token count. Backed by the read-only `chat:contextInfo` IPC (no model call).
- **Reset context** button (two-click confirm) clears **only the active session's** messages
  and summary (`history:clearMessages`) — never other chats.

## Manual / behavioral validation

Because the GUI cannot be driven headlessly, the end-to-end memory behavior was validated
against the **real, logged-in `claude` CLI** using the exact prompt-assembly the app's
`chat:send` uses (`renderProviderPrompt` → `claude -p` over stdin). Script:
`scripts/memory-behavioral-check.ts`.

| Case | Prior turns sent | Model answer | Result |
|------|------------------|--------------|--------|
| General Chat memory — recall a fact set earlier in the session | 4 | "Green." | ✅ remembers |
| No-memory baseline — single prompt (the OLD bug) | 0 | "I don't have any stored memory of your favorite color…" | ✅ confirms the bug the fix removes |
| Chat separation — a different chat with no green history | 2 | "I don't know your favorite color… you've mentioned Svelte, but no color" | ✅ no leakage |
| Multi-turn recall — fact stated several turns earlier | 6 | "Falcon" | ✅ remembers across turns |

**4/4 passed.** The separation case is notable: the model explicitly knew only the *other*
session's fact (Svelte), proving sessions don't bleed into each other.

Headless unit verification of the assembly/bounded-context logic:
`scripts/verify-conversation-context.ts` (window bounding by count + chars, fresh vs ongoing
prompt shape, summary only when older context exists, digest preserved, indicator stats).

### Workspace + project-separation reasoning

Workspace chats are ordinary sessions with a non-null `project_id`; context is loaded by
`session_id` only. Switching projects selects that project's own session, so Project X's
facts cannot surface in Project Y's chat. Agent summaries are persisted into the active
session id, so a Workspace conversation that received an agent summary can reference it in
later turns of that same chat. (These are structurally guaranteed by the per-session query;
the behavioral script above exercises the same assembly path the workspace send uses.)

## Verification results

- `npm run typecheck` — pass
- `npm run build` — pass
- `node --experimental-strip-types scripts/verify-conversation-context.ts` — ok
- `node --experimental-strip-types scripts/verify-macro-loop.ts` — ok
- `node --experimental-strip-types scripts/verify-testlab.ts` — 19 passed, 0 failed
- `node --experimental-strip-types scripts/verify-agentic-loop.ts` — ok
- `node --experimental-strip-types scripts/memory-behavioral-check.ts` — 4/4 passed (real claude CLI)
- `npm run pack:mac` — built `dist/mac-arm64/Akorith.app` (unsigned dev build)

## Known limitations

- Older-context summarization is conservative and only triggers on long sessions; the
  summary is model-generated and could omit a detail (recent turns are always verbatim).
- The behavioral harness uses the `claude` CLI (the logged-in provider on this machine);
  Codex/Ollama follow the identical single-prompt assembly but were not separately scripted.
- The memory indicator's token figure is an approximation (`chars / 4`).
- Context is assembled as a transcript inside the prompt (the uniform approach for single-
  shot CLIs); it does not use any provider-specific multi-message API.
