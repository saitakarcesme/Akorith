import { describe, expect, it } from 'vitest'
import { SUBMIT_KEY, encodeForPty, planBridgeWrites } from '../../src/main/bridge-core'

describe('bridge core', () => {
  it('keeps paste and submit as separate PTY writes', () => {
    expect(planBridgeWrites('ship it', true)).toEqual(['ship it', SUBMIT_KEY])
    expect(planBridgeWrites('ship it', false)).toEqual(['ship it'])
  })

  it('uses bracketed paste for multiline text', () => {
    expect(encodeForPty('first\nsecond')).toBe('\u001b[200~first\rsecond\u001b[201~')
  })
})
