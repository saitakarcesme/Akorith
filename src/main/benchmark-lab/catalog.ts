import { deriveBenchmarkSeed } from './random'
import type {
  BenchmarkCategory,
  BenchmarkFixture,
  BenchmarkFixtureFile,
  BenchmarkLanguage,
  BenchmarkSuite,
  BenchmarkValidationRequirement
} from './types'

const SUITE_SEED = 0xa4017e5d
const DEFAULT_TIMEOUT_MS = 180_000

interface FixtureInput {
  id: string
  category: BenchmarkCategory
  title: string
  summary: string
  taskPrompt: string
  languages?: BenchmarkLanguage[]
  tags: string[]
  files: BenchmarkFixtureFile[]
  checks: Array<[id: string, label: string, kind: BenchmarkValidationRequirement['kind'], weight: number, mandatory?: boolean]>
}

function fixture(input: FixtureInput): BenchmarkFixture {
  return {
    schemaVersion: 1,
    id: input.id,
    revision: 1,
    category: input.category,
    title: input.title,
    summary: input.summary,
    taskPrompt: input.taskPrompt,
    seed: deriveBenchmarkSeed(SUITE_SEED, input.id),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    languages: input.languages ?? [],
    tags: input.tags,
    workspaceFiles: input.files,
    validation: input.checks.map(([id, label, kind, weight, mandatory = true]) => ({ id, label, kind, weight, mandatory }))
  }
}

function languageFixture(
  language: BenchmarkLanguage,
  extension: string,
  source: string,
  testDescription: string
): BenchmarkFixture {
  return fixture({
    id: `multi-language-${language}-v1`,
    category: 'multi_language',
    title: `${language.toUpperCase()} bounded cache repair`,
    summary: `Repair a compact ${language} implementation while preserving its public contract.`,
    taskPrompt: `Repair the bounded cache implementation. Preserve public API names, handle duplicate keys and zero capacity, and keep the change focused. ${testDescription}`,
    languages: [language],
    tags: ['multi-language', 'repair', 'data-structure'],
    files: [{ path: `src/cache.${extension}`, content: source }],
    checks: [
      ['language-tests', `${language} test command exits successfully`, 'test_command', 60],
      ['duplicate-key', 'Updating an existing key does not grow the cache', 'behavior_assertion', 20],
      ['zero-capacity', 'Zero-capacity operation is safe and stores nothing', 'behavior_assertion', 20]
    ]
  })
}

function realWorldFixture(
  id: string,
  title: string,
  taskPrompt: string,
  languages: BenchmarkLanguage[],
  files: BenchmarkFixtureFile[],
  tags: string[]
): BenchmarkFixture {
  return fixture({
    id: `akorith-real-world-${id}-v1`,
    category: 'akorith_real_world',
    title,
    summary: `Curated Akorith usage fixture: ${title.toLowerCase()}.`,
    taskPrompt,
    languages,
    tags: ['akorith', 'real-world', ...tags],
    files,
    checks: [
      ['fixture-tests', 'Fixture-specific deterministic validation passes', 'test_command', 45],
      ['acceptance-contract', 'All stated acceptance criteria are satisfied', 'behavior_assertion', 35],
      ['safe-focused-diff', 'The patch applies cleanly and avoids unrelated or unsafe edits', 'repository_assertion', 20]
    ]
  })
}

const FIXTURES: BenchmarkFixture[] = [
  fixture({
    id: 'repository-repair-typescript-package-v1',
    category: 'repository_repair',
    title: 'Repair a broken TypeScript package',
    summary: 'Diagnose a cross-file regression without deleting or weakening tests.',
    taskPrompt: 'Repair the slug registry regression. Preserve case-insensitive uniqueness, keep stable insertion order, and make the existing tests pass. Do not remove tests or change the exported API.',
    languages: ['typescript'],
    tags: ['repository', 'cross-file', 'tests'],
    files: [
      { path: 'src/registry.ts', content: "export class Registry { private values: string[] = []; add(value: string) { this.values.push(value); } all() { return this.values; } }\n" },
      { path: 'tests/registry.test.ts', content: "// Fixture harness supplies executable assertions for uniqueness and ordering.\n" },
      { path: 'package.json', content: '{"name":"registry-fixture","scripts":{"test":"vitest run","typecheck":"tsc --noEmit"}}\n' }
    ],
    checks: [
      ['tests-pass', 'Repository test command exits successfully', 'test_command', 45],
      ['typecheck-pass', 'TypeScript typecheck exits successfully', 'test_command', 20],
      ['no-test-deletion', 'Original test files remain present and materially unchanged', 'repository_assertion', 20],
      ['focused-diff', 'Changes remain scoped to the registry repair', 'repository_assertion', 15, false]
    ]
  }),
  languageFixture('cpp', 'cpp', '#include <list>\n#include <unordered_map>\n// Intentionally incomplete bounded cache fixture.\n', 'Build and run the supplied C++ assertions.'),
  languageFixture('go', 'go', 'package cache\n// Intentionally incomplete bounded cache fixture.\n', 'Run go test ./....'),
  languageFixture('java', 'java', 'package fixture;\npublic final class Cache { /* intentionally incomplete */ }\n', 'Run the supplied JUnit harness.'),
  languageFixture('javascript', 'js', "export class Cache { constructor(limit) { this.limit = limit; this.items = new Map(); } }\n", 'Run the Node test harness.'),
  languageFixture('typescript', 'ts', 'export class Cache<K, V> { constructor(readonly limit: number) {} }\n', 'Run the TypeScript test and typecheck harnesses.'),
  languageFixture('python', 'py', 'class Cache:\n    def __init__(self, limit: int):\n        self.limit = limit\n', 'Run pytest.'),
  languageFixture('rust', 'rs', 'pub struct Cache<K, V> { capacity: usize, entries: Vec<(K, V)> }\n', 'Run cargo test.'),
  fixture({
    id: 'code-generation-event-ledger-v1',
    category: 'code_generation',
    title: 'Generate a typed event ledger',
    summary: 'Create a small durable component from a behavioral specification.',
    taskPrompt: 'Implement the event ledger described in SPEC.md. It must deduplicate event ids, preserve append order, expose bounded pagination, reject malformed records, and include focused tests. Avoid dependencies.',
    languages: ['typescript'],
    tags: ['generation', 'api-design', 'persistence'],
    files: [{ path: 'SPEC.md', content: '# Event ledger\nEvents have id, timestamp, kind, and JSON-safe metadata. Pagination uses an opaque cursor and a maximum page size of 100.\n' }],
    checks: [
      ['generated-tests', 'Generated focused tests execute successfully', 'test_command', 30],
      ['contract-behavior', 'Deduplication, ordering, validation, and pagination satisfy the hidden contract', 'behavior_assertion', 50],
      ['public-types', 'Exported TypeScript API typechecks without unsafe any', 'artifact_check', 20]
    ]
  }),
  fixture({
    id: 'debugging-repair-race-v1',
    category: 'debugging_repair',
    title: 'Repair an asynchronous cancellation race',
    summary: 'Find and fix a deterministic lifecycle race with bounded cleanup.',
    taskPrompt: 'Fix the request coordinator so a cancelled request cannot publish late output, all timers are released, and independent request keys remain concurrent. Add a regression test for the race.',
    languages: ['javascript'],
    tags: ['debugging', 'async', 'cancellation'],
    files: [{ path: 'coordinator.js', content: "const active = new Map();\nexport async function run(key, work, publish) { const value = await work(); publish(value); return value; }\nexport function cancel(key) { active.delete(key); }\n" }],
    checks: [
      ['race-regression', 'Deterministic cancellation race regression test passes', 'test_command', 50],
      ['late-output-blocked', 'Cancelled requests never publish late output', 'behavior_assertion', 30],
      ['cleanup-complete', 'Timers and request state are released after every terminal path', 'behavior_assertion', 20]
    ]
  }),
  fixture({
    id: 'repository-understanding-change-map-v1',
    category: 'repository_understanding',
    title: 'Produce an evidence-backed change map',
    summary: 'Trace a feature across main, preload, renderer, persistence, and tests.',
    taskPrompt: 'Read the repository snapshot and produce change-map.json for adding a Pause control. Name the relevant existing symbols and files, IPC boundary, persisted state, security invariants, and exact validation commands. Do not edit source files.',
    languages: ['typescript'],
    tags: ['repository-understanding', 'architecture', 'read-only'],
    files: [
      { path: 'src/main/engine.ts', content: 'export function pauseRun(id: string): void { /* existing main owner */ }\n' },
      { path: 'src/preload/index.ts', content: "export const api = { loop: { stop: (id: string) => invoke('loop:stop', id) } };\n" },
      { path: 'src/renderer/Run.tsx', content: 'export function Run() { return null }\n' },
      { path: 'docs/security.md', content: 'Renderer is sandboxed. All state-changing IPC payloads are validated in main.\n' }
    ],
    checks: [
      ['map-schema', 'change-map.json matches the required schema', 'artifact_check', 25],
      ['symbol-evidence', 'Every claimed symbol and file exists in the snapshot', 'repository_assertion', 40],
      ['boundary-coverage', 'Main, preload, renderer, persistence, and validation are addressed', 'behavior_assertion', 25],
      ['read-only', 'No source file was modified', 'repository_assertion', 10]
    ]
  }),
  fixture({
    id: 'tool-agent-release-triage-v1',
    category: 'tool_agent',
    title: 'Triage a release with bounded tools',
    summary: 'Use file, process, and repository tools to reach a verifiable release decision.',
    taskPrompt: 'Inspect the supplied release workspace using the available tools. Run only the declared validation commands, identify the blocking failure, write release-decision.json with evidence references, and do not modify tracked source.',
    languages: ['typescript'],
    tags: ['tools', 'agent', 'release'],
    files: [
      { path: 'package.json', content: '{"scripts":{"test":"node test.mjs","build":"node build.mjs"}}\n' },
      { path: 'release-policy.json', content: '{"required":["test","build"],"forbidDirtySource":true}\n' },
      { path: 'test.mjs', content: "console.log('tests pass')\n" },
      { path: 'build.mjs', content: "console.error('missing release asset'); process.exit(2)\n" }
    ],
    checks: [
      ['tools-invoked', 'Required test and build processes were actually invoked', 'test_command', 25],
      ['decision-correct', 'Release decision is blocked with the correct failure evidence', 'behavior_assertion', 40],
      ['evidence-linked', 'Decision references captured command evidence', 'artifact_check', 25],
      ['source-unchanged', 'Tracked source remains unchanged', 'repository_assertion', 10]
    ]
  }),
  fixture({
    id: 'long-context-policy-reconciliation-v1',
    category: 'long_context',
    title: 'Reconcile a distributed policy contract',
    summary: 'Synthesize constraints spread across a long, partially redundant context.',
    taskPrompt: 'Read every policy fragment and write reconciled-policy.json. Resolve conflicts by explicit precedence, preserve all non-conflicting requirements, cite fragment ids, and flag the intentionally unresolvable retention ambiguity without guessing.',
    tags: ['long-context', 'policy', 'citations'],
    files: Array.from({ length: 24 }, (_, index) => ({
      path: `policies/fragment-${String(index + 1).padStart(2, '0')}.md`,
      content: `# Fragment F${index + 1}\nScope: ${index % 3 === 0 ? 'security' : index % 3 === 1 ? 'operations' : 'product'}\nPriority: ${index % 5}\nRequirement: Preserve audit evidence for bounded operations ${index + 1}.\n`
    })).concat([
      { path: 'policies/retention-a.md', content: '# F25\nRetention is 30 days. Same precedence as F26.\n' },
      { path: 'policies/retention-b.md', content: '# F26\nRetention is 90 days. Same precedence as F25.\n' }
    ]),
    checks: [
      ['schema-valid', 'Reconciled artifact matches the required schema', 'artifact_check', 20],
      ['requirements-covered', 'All non-conflicting requirements are represented', 'behavior_assertion', 35],
      ['citations-valid', 'Every citation points to a real fragment', 'repository_assertion', 25],
      ['ambiguity-honest', 'Equal-precedence retention conflict is flagged without an invented resolution', 'behavior_assertion', 20]
    ]
  }),
  realWorldFixture(
    'web-application',
    'Web application optimistic update',
    'Repair the optimistic todo update so failed requests roll back exactly once, concurrent items remain independent, and the accessible error status is announced. Preserve the component API and add a regression test.',
    ['typescript'],
    [
      { path: 'src/TodoList.tsx', content: 'export function TodoList() { return null }\n' },
      { path: 'src/todo-client.ts', content: 'export async function saveTodo() { throw new Error("offline") }\n' }
    ],
    ['web', 'react', 'accessibility']
  ),
  realWorldFixture(
    'java-project',
    'Java transactional import',
    'Implement atomic batch import in ImportService. Invalid rows must report line-specific errors and leave the repository unchanged. Preserve the public interface and add focused tests.',
    ['java'],
    [{ path: 'src/main/java/app/ImportService.java', content: 'package app; public final class ImportService { }\n' }],
    ['java', 'transaction', 'validation']
  ),
  realWorldFixture(
    'python-service',
    'Python service idempotency',
    'Add bounded idempotency handling to the create-job endpoint. Concurrent requests sharing a key must create one job, conflicting payloads must fail, and expired keys must be pruned safely.',
    ['python'],
    [{ path: 'service/jobs.py', content: 'async def create_job(payload: dict) -> dict:\n    return {"id": "new"}\n' }],
    ['python', 'service', 'concurrency']
  ),
  realWorldFixture(
    'cpp-project',
    'C++ resource ownership repair',
    'Repair the asset loader ownership bug. It must not double free after a failed decode, moves must remain safe, and the public loading API must not change. Add a regression test runnable under sanitizers.',
    ['cpp'],
    [{ path: 'engine/asset_loader.cpp', content: '#include <memory>\n// Fixture contains an ownership regression in the hidden implementation.\n' }],
    ['cpp', 'memory-safety', 'sanitizer']
  ),
  realWorldFixture(
    'game-development',
    'Game loop deterministic pause',
    'Implement pause and resume in the fixed-step game loop without advancing simulation time, dropping queued input, or causing a catch-up spike. Keep rendering active and add deterministic clock tests.',
    ['typescript'],
    [{ path: 'game/loop.ts', content: 'export function tick(now: number): void { void now }\n' }],
    ['game-development', 'timing', 'state-machine']
  ),
  realWorldFixture(
    'bug-fix',
    'Cross-platform path bug fix',
    'Fix workspace containment checks for Windows drive-letter casing, separators, and symlinked children while preserving POSIX behavior. Reject traversal and add cross-platform tests.',
    ['javascript'],
    [{ path: 'lib/paths.js', content: 'export function isInside(root, candidate) { return candidate.startsWith(root); }\n' }],
    ['bug-fix', 'paths', 'security']
  ),
  realWorldFixture(
    'feature-implementation',
    'Bounded audit export feature',
    'Add a streaming JSONL audit export with date filtering, cancellation, stable ordering, and redaction of secret-like metadata. Do not load the complete event history into memory.',
    ['typescript'],
    [{ path: 'src/audit/export.ts', content: 'export async function exportAudit(): Promise<void> { }\n' }],
    ['feature', 'streaming', 'privacy']
  ),
  realWorldFixture(
    'refactor',
    'Go dependency-boundary refactor',
    'Refactor notification delivery behind the existing Sender interface without behavior changes. Remove the import cycle, retain error wrapping, and keep tests deterministic.',
    ['go'],
    [{ path: 'internal/notify/service.go', content: 'package notify\n// Fixture graph contains an import cycle.\n' }],
    ['refactor', 'go', 'architecture']
  ),
  realWorldFixture(
    'test-writing',
    'Python property-focused tests',
    'Write deterministic tests for the existing interval merge function, covering invariants, boundary adjacency, duplicates, invalid intervals, and a seeded randomized corpus. Do not alter production code.',
    ['python'],
    [{ path: 'intervals.py', content: 'def merge(values):\n    return values\n' }],
    ['test-writing', 'python', 'properties']
  ),
  fixture({
    id: 'akorith-real-world-loop-gating-v1',
    category: 'akorith_real_world',
    title: 'Electron application Loop eligibility gate',
    summary: 'Implement a security-sensitive product change across model catalog and Loop setup.',
    taskPrompt: 'Repair Loop executor selection so only models with a fresh successful code-execution probe confirming every mandatory capability are selectable. Reasoning-only probes may select planners but never executors. Preserve context isolation and add focused tests.',
    languages: ['typescript'],
    tags: ['akorith', 'loop', 'model-catalog', 'security'],
    files: [
      { path: 'src/main/model-catalog.ts', content: "export function canExecute(model) { return model.available; }\n" },
      { path: 'src/renderer/LoopSetup.tsx', content: 'export function LoopSetup() { return null }\n' },
      { path: 'src/preload/index.ts', content: 'export const api = Object.freeze({});\n' },
      { path: 'SECURITY.md', content: 'Renderer is sandboxed and context isolated. Main validates all selections.\n' }
    ],
    checks: [
      ['eligibility-tests', 'Focused eligibility tests pass', 'test_command', 35],
      ['mandatory-gate', 'Every mandatory executor capability requires fresh probe confirmation', 'behavior_assertion', 30],
      ['planner-separation', 'Reasoning-only probes remain planner-only', 'behavior_assertion', 20],
      ['security-preserved', 'Sandbox, context isolation, and validated IPC contract remain intact', 'repository_assertion', 15]
    ]
  })
]

const PRODUCTION_SUITE: BenchmarkSuite = {
  schemaVersion: 1,
  id: 'akorith-production-benchmark-v1',
  revision: 1,
  name: 'Akorith Production Benchmark',
  description: 'Eight-category, evidence-first coding-agent benchmark with equal category weighting and reproducible fixtures.',
  seed: SUITE_SEED,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  fixtures: FIXTURES,
  createdAt: Date.UTC(2026, 0, 1)
}

export function getProductionBenchmarkSuite(): BenchmarkSuite {
  return structuredClone(PRODUCTION_SUITE)
}
