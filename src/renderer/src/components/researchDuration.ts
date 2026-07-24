import type { ResearchDepth } from '../../../preload/index.d'

export const RESEARCH_DURATION_OPTIONS = [
  { id: 'quick', label: '10 min', shortLabel: '10m', detail: 'Focused overview' },
  { id: 'standard', label: '1 hour', shortLabel: '1h', detail: 'Cross-checked research' },
  { id: 'focused3h', label: '3 hours', shortLabel: '3h', detail: 'Expanded source set' },
  { id: 'extended6h', label: '6 hours', shortLabel: '6h', detail: 'Broad comparison' },
  { id: 'deep', label: '10 hours', shortLabel: '10h', detail: 'Deep evidence review' },
  { id: 'day', label: '24 hours', shortLabel: '24h', detail: 'Full-day investigation' },
  { id: 'continuous', label: 'Continuous', shortLabel: '\u221e', detail: 'Runs until you pause it' }
] as const satisfies ReadonlyArray<{ id: ResearchDepth; label: string; shortLabel: string; detail: string }>

const RESEARCH_DURATION_LABELS = {
  quick: '10 min',
  standard: '1 hour',
  focused3h: '3 hours',
  extended6h: '6 hours',
  deep: '10 hours',
  day: '24 hours',
  continuous: 'Continuous'
} as const satisfies Record<ResearchDepth, string>

export function researchDurationLabel(depth: ResearchDepth): string {
  return RESEARCH_DURATION_LABELS[depth]
}
