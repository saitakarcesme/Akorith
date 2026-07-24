import assert from 'node:assert/strict'
import { validateCreateResearchJobInput } from '../src/main/research/store/jobs.ts'
import {
  RESEARCH_DEPTH_PROFILES,
  RESEARCH_DEPTHS,
  RESEARCH_OUTPUT_FORMATS,
  type CreateResearchJobInput
} from '../src/main/research/types.ts'

const providers = [
  { providerId: 'opencode', model: 'opencode-go/glm-5.2' },
  { providerId: 'claude', model: 'claude-sonnet-5' }
] as const

let accepted = 0
for (const depth of RESEARCH_DEPTHS) {
  for (const outputFormat of RESEARCH_OUTPUT_FORMATS) {
    for (const provider of providers) {
      validateCreateResearchJobInput({
        prompt: `Offline ${depth} ${outputFormat} acceptance fixture`,
        providerId: provider.providerId,
        model: provider.model,
        depth,
        outputFormat,
        autoStart: true
      })
      accepted += 1
    }
  }
}
assert.equal(accepted, 70, 'all duration, output, and provider-class combinations must be accepted')

assert.equal(RESEARCH_DEPTH_PROFILES.quick.targetDurationMs, 10 * 60_000)
assert.equal(RESEARCH_DEPTH_PROFILES.standard.targetDurationMs, 60 * 60_000)
assert.equal(RESEARCH_DEPTH_PROFILES.focused3h.targetDurationMs, 3 * 60 * 60_000)
assert.equal(RESEARCH_DEPTH_PROFILES.extended6h.targetDurationMs, 6 * 60 * 60_000)
assert.equal(RESEARCH_DEPTH_PROFILES.deep.targetDurationMs, 10 * 60 * 60_000)
assert.equal(RESEARCH_DEPTH_PROFILES.day.targetDurationMs, 24 * 60 * 60_000)
assert.equal(RESEARCH_DEPTH_PROFILES.continuous.maxCycles, 0)
assert.equal(RESEARCH_DEPTH_PROFILES.continuous.sourceTarget, 0)

const valid: CreateResearchJobInput = {
  prompt: 'Valid research request',
  providerId: 'opencode',
  model: 'opencode-go/glm-5.2',
  depth: 'quick',
  outputFormat: 'md'
}

for (const [label, input, pattern] of [
  ['empty prompt', { ...valid, prompt: '   ' }, /Research request/],
  ['oversized prompt', { ...valid, prompt: 'x'.repeat(120_001) }, /Research request/],
  ['provider traversal', { ...valid, providerId: '../claude' }, /provider/],
  ['provider shell syntax', { ...valid, providerId: 'claude;rm' }, /provider/],
  ['model shell syntax', { ...valid, model: 'model;rm -rf' }, /model/],
  ['invalid depth', { ...valid, depth: 'forever' }, /depth/],
  ['invalid format', { ...valid, outputFormat: 'html' }, /format/]
] as const) {
  assert.throws(
    () => validateCreateResearchJobInput(input as CreateResearchJobInput),
    pattern,
    `${label} must be rejected by the store boundary`
  )
}

console.log(`research input verifier passed (${accepted} valid combinations and 7 invalid boundaries)`)
