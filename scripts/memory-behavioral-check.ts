// Phase 14.2 behavioral memory check against the REAL `claude` CLI.
// Run: node --experimental-strip-types scripts/memory-behavioral-check.ts
//
// This is the end-to-end proof that the fix works: it assembles the provider
// prompt with the SAME function the app's chat:send uses (renderProviderPrompt)
// and pipes it to the real, logged-in `claude` CLI exactly as the provider does
// (prompt over stdin, never argv). It then checks the model's actual answer.
//
// It demonstrates: (1) with session memory the model recalls an earlier fact;
// (2) without memory — the OLD single-prompt behavior — it does NOT; (3) a
// separate chat does not inherit another chat's memory; (4) multi-turn recall.
// Requires the claude CLI to be installed and logged in.

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { renderProviderPrompt, type ConvMessage } from '../src/main/conversation.ts'

const mk = (role: ConvMessage['role'], content: string): ConvMessage => ({ role, content })

/** Run `claude -p` exactly like the provider: prompt over stdin, text out. */
function askClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p'], { cwd: homedir() })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('claude timed out'))
    }, 120_000)
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(`claude exited ${code}: ${err.slice(-300)}`))
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

interface Case {
  name: string
  prior: ConvMessage[]
  current: string
  expectIncludes?: string // pass if answer (lowercased) contains this
  expectExcludes?: string // pass if answer (lowercased) does NOT contain this
}

const RECALL = 'What is my favorite color? Reply with just the color word.'

const CASES: Case[] = [
  {
    name: 'General Chat memory — recalls an earlier fact in the same session',
    prior: [
      mk('user', 'Remember this: my favorite color is green.'),
      mk('assistant', 'Got it — your favorite color is green.'),
      mk('user', 'Also I have a dog named Pixel.'),
      mk('assistant', 'Noted — your dog is named Pixel.')
    ],
    current: RECALL,
    expectIncludes: 'green'
  },
  {
    name: 'No-memory baseline — single prompt (the OLD bug) does NOT know',
    prior: [],
    current: RECALL,
    expectExcludes: 'green'
  },
  {
    name: 'Chat separation — a different chat (no green history) does NOT inherit it',
    prior: [
      mk('user', 'My favorite framework is Svelte.'),
      mk('assistant', 'Noted — Svelte.')
    ],
    current: RECALL,
    expectExcludes: 'green'
  },
  {
    name: 'Multi-turn recall — fact stated several turns earlier',
    prior: [
      mk('user', 'Project codename is Falcon.'),
      mk('assistant', 'Understood — Falcon.'),
      mk('user', 'The deploy target is staging-3.'),
      mk('assistant', 'Got it — staging-3.'),
      mk('user', 'The lead reviewer is Mara.'),
      mk('assistant', 'Noted — Mara reviews.')
    ],
    current: 'What is the project codename? Reply with just the codename.',
    expectIncludes: 'falcon'
  }
]

interface Result {
  name: string
  answer: string
  pass: boolean
}

async function main(): Promise<void> {
  const results: Result[] = []
  for (const c of CASES) {
    const built = renderProviderPrompt({ priorMessages: c.prior, currentPrompt: c.current })
    process.stdout.write(`\n▶ ${c.name}\n`)
    let answer = ''
    let pass = false
    try {
      answer = await askClaude(built.prompt)
      const low = answer.toLowerCase()
      pass = c.expectIncludes ? low.includes(c.expectIncludes) : c.expectExcludes ? !low.includes(c.expectExcludes) : false
    } catch (err) {
      answer = `ERROR: ${err instanceof Error ? err.message : String(err)}`
    }
    process.stdout.write(`  prior turns sent: ${built.includedVerbatim}, summarized: ${built.summarizedCount}\n`)
    process.stdout.write(`  answer: ${answer.replace(/\n/g, ' ').slice(0, 120)}\n`)
    process.stdout.write(`  ${pass ? '\x1b[32m✓ PASS\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}\n`)
    results.push({ name: c.name, answer: answer.replace(/\n/g, ' ').slice(0, 200), pass })
  }
  const passed = results.filter((r) => r.pass).length
  process.stdout.write(`\n${passed}/${results.length} behavioral memory cases passed\n`)
  // Emit a machine-readable block the validation doc can quote.
  process.stdout.write('\n---JSON---\n' + JSON.stringify(results, null, 2) + '\n')
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((err) => {
  console.error('behavioral check crashed:', err)
  process.exit(1)
})
