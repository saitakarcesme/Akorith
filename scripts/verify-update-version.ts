import { versionIsNewer } from '../src/main/update/checker'

const cases: Array<{ candidate: string; current: string; expected: boolean }> = [
  { candidate: '0.2.0', current: '0.1.9', expected: true },
  { candidate: '0.2.0', current: '0.2.0', expected: false },
  { candidate: '1.0.0', current: '0.99.99', expected: true },
  { candidate: '0.2.0-beta.1', current: '0.2.0', expected: false },
  { candidate: 'v0.2.1', current: '0.2.0', expected: true }
]

for (const testCase of cases) {
  const actual = versionIsNewer(testCase.candidate, testCase.current)
  if (actual !== testCase.expected) {
    throw new Error(
      `versionIsNewer(${testCase.candidate}, ${testCase.current}) returned ${actual}; expected ${testCase.expected}`
    )
  }
}

console.log(`update version comparison: ${cases.length} cases passed`)
