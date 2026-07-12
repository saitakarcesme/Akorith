import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_BASELINE = 'a53c7bf1ae99f56ebcf2b63c94fc3ea6293e7dc4'
const baseline = process.argv[2] || DEFAULT_BASELINE
const outputPath = resolve(process.argv[3] || 'docs/implementation-ledger.md')
const recordSeparator = '\x1e'
const fieldSeparator = '\x1f'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', windowsHide: true })
}

function trailer(body, name, fallback) {
  const matcher = new RegExp(`^${name}:\\s*(.+)$`, 'im')
  return body.match(matcher)?.[1]?.trim() || fallback
}

function cell(value) {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

git(['merge-base', '--is-ancestor', baseline, 'HEAD'])
const raw = git([
  'log',
  '--reverse',
  `--format=%H${fieldSeparator}%s${fieldSeparator}%b${recordSeparator}`,
  `${baseline}..HEAD`
])

const commits = raw
  .split(recordSeparator)
  .map((record) => record.trim())
  .filter(Boolean)
  .map((record) => {
    const [hash = '', title = '', ...bodyParts] = record.split(fieldSeparator)
    const body = bodyParts.join(fieldSeparator)
    return {
      hash: hash.trim(),
      title: title.trim(),
      area: trailer(body, 'Area', 'Cross-cutting'),
      tests: trailer(body, 'Tests', 'Recorded in validation report'),
      result: trailer(body, 'Result', 'Completed')
    }
  })

const lines = [
  '# Implementation ledger',
  '',
  `Baseline: \`${baseline}\``,
  '',
  'This ledger is generated from conventional commit messages and their',
  '`Area`, `Tests`, and `Result` trailers. The ledger-generation commit itself',
  'is administrative and is intentionally recorded on the next generation.',
  '',
  '| # | Commit | Title | Area changed | Tests run | Result |',
  '|---:|:-------|:------|:-------------|:----------|:-------|'
]

for (const [index, commit] of commits.entries()) {
  lines.push(
    `| ${index + 1} | \`${commit.hash.slice(0, 12)}\` | ${cell(commit.title)} | ${cell(commit.area)} | ${cell(commit.tests)} | ${cell(commit.result)} |`
  )
}

lines.push('', `Total commits after baseline represented: **${commits.length}**`)
writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8')
process.stdout.write(`Wrote ${outputPath} with ${commits.length} commit(s).\n`)
