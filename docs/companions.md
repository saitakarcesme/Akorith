# Companions — long-memory local personalities

> **Think with Companions.** Athena and Zeus are memory-first local AI personalities. They
> talk and remember across all your conversations. **They never take actions.**

## Built-ins

- **Athena** — strategic, calm, wise, analytical. Architecture + product thinking; asks sharp
  questions; holds you to a coherent long-term direction.
- **Zeus** — bold, direct, decisive, motivational. Cuts hesitation and points at the next move;
  remembers your goals and momentum.

## Hard boundary (verified)

Companions **cannot** run commands, edit files, create commits, send terminal input, call
Agents or Loop, or change settings. They never claim to have acted. If you ask them to act,
they explain that **Agents** take actions and **Loop** builds projects. `npm run verify:companions`
asserts every built-in prompt declares this no-action boundary.

## Long-term memory

Talk to Athena across 30 chats over a month and she remembers what matters. Each reply:

1. relevant memories are retrieved (token-overlap scoring; pinned + importance boosted),
2. injected as a compact `MEMORY` block into the local-model prompt,
3. the exchange is saved,
4. a periodic **extraction pass** asks the local model for durable memories (preferences,
   projects, decisions, goals, technical context, …), deduped against what's already known.

Memory types: preference, project, decision, idea, goal, personal_context, writing_style,
technical_context, warning, relationship, recurring_topic. Each has importance + confidence.

Review UI (right panel): pinned + remembered memories, which ones were **recalled in the last
reply**, search, and pin / archive / forget / manual-add controls. You are in control of what
is remembered.

## Local-first & private

Companions default to the **local runtime** (Ollama / resolved endpoint). Conversations and
memories live in local SQLite (`companions`, `companion_sessions`, `companion_messages`,
`companion_memories`). No vector DB required — simple token scoring for the MVP.

## Verify

`npm run verify:companions` (boundary + identity assertions; electron-free).
