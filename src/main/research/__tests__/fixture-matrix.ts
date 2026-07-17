import type {
  ResearchClaim,
  ResearchDepth,
  ResearchOutputFormat,
  ResearchSource
} from '../types'
import type { ResearchDocument } from '../document'

export const DETERMINISTIC_RESEARCH_NOW = Date.UTC(2026, 6, 17, 10, 0, 0)

export const TEST_RESEARCH_DEPTHS = ['quick', 'standard', 'deep'] as const satisfies readonly ResearchDepth[]

export const TEST_RESEARCH_PROVIDERS = [
  {
    class: 'free',
    providerId: 'opencode',
    model: 'opencode-go/glm-5.2',
    label: 'OpenCode Free · GLM 5.2'
  },
  {
    class: 'claude',
    providerId: 'claude',
    model: 'claude-sonnet-5',
    label: 'Claude · Sonnet 5'
  }
] as const

export const TEST_RESEARCH_OUTPUTS = ['pdf', 'md', 'docx', 'xlsx'] as const satisfies readonly ResearchOutputFormat[]

export interface ResearchFixtureCase {
  id: string
  depth: (typeof TEST_RESEARCH_DEPTHS)[number]
  providerClass: (typeof TEST_RESEARCH_PROVIDERS)[number]['class']
  providerId: string
  model: string
  providerLabel: string
  outputFormat: (typeof TEST_RESEARCH_OUTPUTS)[number]
}

export const RESEARCH_CORE_FIXTURE_MATRIX: readonly ResearchFixtureCase[] = Object.freeze(
  TEST_RESEARCH_DEPTHS.flatMap((depth) =>
    TEST_RESEARCH_PROVIDERS.flatMap((provider) =>
      TEST_RESEARCH_OUTPUTS.map((outputFormat) => ({
        id: `research-${depth}-${provider.class}-${outputFormat}`,
        depth,
        providerClass: provider.class,
        providerId: provider.providerId,
        model: provider.model,
        providerLabel: provider.label,
        outputFormat
      }))
    )
  )
)

export const EXPECTED_RESEARCH_FIXTURE_COUNT = 24

export function createDeterministicResearchDocument(fixture: ResearchFixtureCase): ResearchDocument {
  const sources: ResearchSource[] = [
    {
      id: `${fixture.id}-source-primary`,
      jobId: fixture.id,
      cycleId: `${fixture.id}-cycle-1`,
      url: 'https://github.com/example/research-model-card',
      title: 'Deterministic model card and benchmark methodology',
      publisher: 'Example Research Lab',
      publishedAt: '2026-06-30',
      accessedAt: DETERMINISTIC_RESEARCH_NOW,
      excerpt: 'The controlled benchmark reports reproducible quality and latency measurements.',
      relevance: 'Primary evidence for the measured result.',
      credibilityScore: 0.92,
      contentHash: 'fixture-primary-hash',
      verified: true
    },
    {
      id: `${fixture.id}-source-context`,
      jobId: fixture.id,
      cycleId: `${fixture.id}-cycle-1`,
      url: 'https://huggingface.co/example/research-model',
      title: 'Independent deployment notes and limitations',
      publisher: 'Hugging Face Community',
      publishedAt: '2026-07-01',
      accessedAt: DETERMINISTIC_RESEARCH_NOW,
      excerpt: 'The deployment notes document memory requirements and known evaluation limits.',
      relevance: 'Independent context for deployment and caveats.',
      credibilityScore: 0.84,
      contentHash: 'fixture-context-hash',
      verified: true
    }
  ]
  const claims: ResearchClaim[] = [
    {
      id: `${fixture.id}-claim-quality`,
      jobId: fixture.id,
      cycleId: `${fixture.id}-cycle-1`,
      sectionId: 'measured-findings',
      text: 'The evaluated model reaches a reproducible quality score of 82 on the controlled fixture.',
      confidenceScore: 0.91,
      status: 'verified',
      evidence: [{ sourceId: sources[0].id, relation: 'supports', evidence: 'Published score table.' }],
      createdAt: DETERMINISTIC_RESEARCH_NOW,
      updatedAt: DETERMINISTIC_RESEARCH_NOW
    },
    {
      id: `${fixture.id}-claim-limits`,
      jobId: fixture.id,
      cycleId: `${fixture.id}-cycle-1`,
      sectionId: 'limitations',
      text: 'The score should be interpreted with the documented memory and benchmark-scope limits.',
      confidenceScore: 0.86,
      status: 'verified',
      evidence: [{ sourceId: sources[1].id, relation: 'context', evidence: 'Deployment limitations.' }],
      createdAt: DETERMINISTIC_RESEARCH_NOW,
      updatedAt: DETERMINISTIC_RESEARCH_NOW
    }
  ]

  return {
    title: `Research fixture · ${fixture.depth} · ${fixture.providerClass} · ${fixture.outputFormat}`,
    subtitle: 'A deterministic, offline report used to verify every supported Research delivery combination.',
    requestedBy: 'Akorith Research Verification',
    generatedAt: DETERMINISTIC_RESEARCH_NOW,
    depthLabel: fixture.depth,
    providerLabel: fixture.providerLabel,
    modelLabel: fixture.model,
    methodology: [
      'Use fixed local evidence so the verification never depends on network availability.',
      'Keep claims linked to explicit source identifiers and preserve unsupported-state visibility.',
      'Validate the generated package with the same checks used by the production export path.'
    ],
    verificationCriteria: [
      'The deliverable opens as its declared file type.',
      'The report includes a title, executive summary, findings, methodology, and sources.',
      'Every cited claim resolves to an entry in the source ledger.'
    ],
    executiveSummary: 'This fixture demonstrates that Akorith can turn the same evidence-backed research record into each supported output format while retaining citations, source context, and a readable report structure.',
    sections: [
      {
        id: 'measured-findings',
        title: 'Measured findings',
        body: 'The deterministic evaluation records a quality score of 82. The fixed evidence keeps this check stable across machines, providers, depths, and repeated test runs.',
        claims: [claims[0]]
      },
      {
        id: 'limitations',
        title: 'Limitations',
        body: 'The fixture proves packaging and validation behavior rather than live model quality. Production research still needs current sources, cross-checking, and explicit uncertainty.',
        claims: [claims[1]]
      }
    ],
    sources
  }
}
