# 046 — Companion: chat-level memory isolation + honesty

- **Date/time:** 2026-07-01 · **App commit:** cb5c2e7 · **Surface:** Companions (Athena)

## Action
Asked Athena: *"What is my product launch deadline month? Only answer if you actually remember it."*
(The "Ship Akorith 1.0 by August" memory belongs to **Zeus**, not Athena — see tests 034/035.)

## Actual — PASS (isolation + no hallucination)
- `usedMemories`: Development Workflow, Primary stack — only Athena's own memories; Zeus's launch
  memory was not (and cannot be) retrieved.
- Athena answered honestly:
  > "I do not recall a product launch deadline month. This specific constraint is not present in
  > our stored memory context… If you have a target in mind, please provide it now…"

She did NOT fabricate "August" — proving both cross-companion isolation (at the chat/retrieval
level, complementing the search-level check in 035) and the "never invent" memory discipline in
the system prompt.

## Persistent artifact
The exchange persisted in Athena's session.

## Pass/fail
**PASS** — Athena cannot see Zeus's memory and refuses to hallucinate it.
