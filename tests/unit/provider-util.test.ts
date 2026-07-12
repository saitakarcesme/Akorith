import { describe, expect, it } from 'vitest'
import { runCli } from '../../src/main/providers/util'

describe('provider CLI runner', () => {
  it('bounds retained stdout and records truncation', async () => {
    const result = await runCli(process.execPath, ['-e', 'process.stdout.write("x".repeat(20000))'], {
      timeoutMs: 10_000,
      maxOutputChars: 8_192
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toHaveLength(8_192)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(false)
  })
})
