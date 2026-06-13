// Headless verification of the Phase 14.2 conversation-memory CORE (electron-free).
// Run: node --experimental-strip-types scripts/verify-conversation-context.ts
//
// Proves, without the GUI: the verbatim window is bounded by count + chars and
// always keeps the newest turn; a fresh session sends the clean prompt; an
// ongoing session sends prior turns (so the model has memory); the summary block
// is included only when older context exists; the digest is preserved; and the
// memory indicator stats line up with what is actually sent.

import assert from 'node:assert/strict'
import {
  DEFAULT_CONTEXT_POLICY,
  buildOlderSummaryPrompt,
  describeContext,
  renderProviderPrompt,
  renderTranscript,
  selectContextWindow,
  type ConvMessage
} from '../src/main/conversation.ts'

const mk = (role: ConvMessage['role'], content: string): ConvMessage => ({ role, content })

// ---------- selectContextWindow: bounded by count ----------
{
  const msgs: ConvMessage[] = Array.from({ length: 40 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `m${i}`))
  const w = selectContextWindow(msgs, { recentVerbatim: 10, maxChars: 100_000, summarizeAfter: 10 })
  assert.equal(w.verbatim.length, 10, 'verbatim capped to recentVerbatim')
  assert.equal(w.older.length, 30, 'remaining go to older')
  assert.equal(w.verbatim[w.verbatim.length - 1].content, 'm39', 'keeps the newest message')
  assert.equal(w.verbatim[0].content, 'm30', 'window is the most recent N')
}

// ---------- selectContextWindow: bounded by chars, always keeps newest ----------
{
  const big = 'x'.repeat(5000)
  const msgs = [mk('user', big), mk('assistant', big), mk('user', big)]
  const w = selectContextWindow(msgs, { recentVerbatim: 24, maxChars: 6000, summarizeAfter: 24 })
  assert.ok(w.verbatim.length >= 1, 'always includes at least the newest message')
  assert.equal(w.verbatim[w.verbatim.length - 1].content, big, 'newest message included even when oversized')
  assert.ok(w.older.length >= 1, 'older messages overflow into the summary set')
}

// ---------- fresh session: clean prompt, no framing ----------
{
  const built = renderProviderPrompt({ priorMessages: [], currentPrompt: 'hello there' })
  assert.equal(built.prompt, 'hello there', 'no prior → clean prompt')
  assert.equal(built.includedVerbatim, 0)
  assert.equal(built.usedSummary, false)
  assert.equal(built.summarizedCount, 0)
}

// ---------- fresh session with digest: digest preserved ----------
{
  const built = renderProviderPrompt({ priorMessages: [], currentPrompt: 'q', digest: '## Repo context\nfiles' })
  assert.match(built.prompt, /## Repo context/, 'digest is included')
  assert.match(built.prompt, /q$/, 'prompt follows the digest')
  assert.equal(built.usedDigest, true)
}

// ---------- ongoing session: prior turns are actually sent (THE BUG FIX) ----------
{
  const prior = [mk('user', 'Remember: my favorite color is green.'), mk('assistant', 'Got it — green.')]
  const built = renderProviderPrompt({ priorMessages: prior, currentPrompt: 'What is my favorite color?' })
  assert.match(built.prompt, /favorite color is green/, 'prior user turn is included')
  assert.match(built.prompt, /Got it — green/, 'prior assistant turn is included')
  assert.match(built.prompt, /ongoing session/i, 'prompt is framed as a continuing conversation')
  assert.match(built.prompt, /What is my favorite color\?/, 'the new message is included last')
  assert.equal(built.includedVerbatim, 2)
  assert.equal(built.summarizedCount, 0, 'short history needs no summary')
  assert.equal(built.usedSummary, false)
}

// ---------- long session: older summarized, recent verbatim ----------
{
  const prior: ConvMessage[] = Array.from({ length: 30 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `turn ${i}`))
  const built = renderProviderPrompt({
    priorMessages: prior,
    currentPrompt: 'continue',
    summary: 'Earlier we set up the project and discussed X.',
    policy: { recentVerbatim: 6, maxChars: 100_000, summarizeAfter: 6 }
  })
  assert.equal(built.usedSummary, true, 'summary used when older context exists')
  assert.equal(built.summarizedCount, 24, 'older count = total - verbatim')
  assert.match(built.prompt, /Summary of earlier conversation/, 'summary block present')
  assert.match(built.prompt, /set up the project/, 'summary text present')
  assert.match(built.prompt, /turn 29|turn 28/, 'recent turns present verbatim')
  assert.ok(!built.prompt.includes('turn 0'), 'oldest turn is not sent verbatim')
}

// ---------- summary not shown if older exists but no summary text yet ----------
{
  const prior: ConvMessage[] = Array.from({ length: 10 }, (_, i) => mk('user', `t${i}`))
  const built = renderProviderPrompt({
    priorMessages: prior,
    currentPrompt: 'x',
    summary: null,
    policy: { recentVerbatim: 4, maxChars: 100_000, summarizeAfter: 4 }
  })
  assert.equal(built.usedSummary, false, 'no summary text → no summary block')
  assert.ok(!built.prompt.includes('Summary of earlier conversation'), 'no empty summary header')
  // recent turns still carry the conversation
  assert.match(built.prompt, /t9/, 'recent turns still present')
}

// ---------- describeContext mirrors what is sent ----------
{
  const prior: ConvMessage[] = Array.from({ length: 30 }, (_, i) => mk('user', `c${i}`))
  const info = describeContext(prior, 24, { recentVerbatim: 6, maxChars: 100_000, summarizeAfter: 6 })
  assert.equal(info.totalMessages, 30)
  assert.equal(info.includedVerbatim, 6)
  assert.equal(info.summarizedCount, 24)
  assert.equal(info.hasSummary, true, 'cached summary covers the older window')
  const info2 = describeContext(prior, 0, { recentVerbatim: 6, maxChars: 100_000, summarizeAfter: 6 })
  assert.equal(info2.hasSummary, false, 'no cached summary → hasSummary false')
  assert.ok(info.approxTokens > 0)
}

// ---------- transcript + summary prompt shape ----------
{
  assert.equal(renderTranscript([mk('user', 'hi'), mk('assistant', 'yo')]), 'User: hi\n\nAssistant: yo')
  const p = buildOlderSummaryPrompt([mk('user', 'a'), mk('assistant', 'b')], 'prev summary')
  assert.match(p, /internal orchestration call/, 'summary prompt is framed as a meta call')
  assert.match(p, /prev summary/, 'existing summary is carried forward')
  assert.match(p, /Return ONLY the updated summary/, 'asks for summary text only')
}

// ---------- policy defaults are sane ----------
assert.ok(DEFAULT_CONTEXT_POLICY.recentVerbatim >= 8 && DEFAULT_CONTEXT_POLICY.maxChars >= 10_000)

console.log('verify-conversation-context: ok')
