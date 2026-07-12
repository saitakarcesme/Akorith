import type { ProjectFeatureInventory, RepositorySnapshot } from './types'

function addUnique(target: string[], value: string | null | undefined, max = 100): void {
  if (!value || target.length >= max || target.includes(value)) return
  target.push(value)
}

function markerLabel(file: string, line: number, text: string): string {
  return `${file}:${line} — ${text || 'Unresolved code marker'}`.slice(0, 500)
}

function nextSteps(inventory: Omit<ProjectFeatureInventory, 'highValueNextSteps'>): string[] {
  const result: string[] = []
  if (inventory.brokenBehavior.length > 0) addUnique(result, `Repair: ${inventory.brokenBehavior[0]}`)
  if (inventory.securityConcerns.length > 0) addUnique(result, `Security: ${inventory.securityConcerns[0]}`)
  if (inventory.testGaps.length > 0) addUnique(result, `Testing: ${inventory.testGaps[0]}`)
  if (inventory.incompleteCapabilities.length > 0) addUnique(result, `Complete: ${inventory.incompleteCapabilities[0]}`)
  if (inventory.technicalDebt.length > 0) addUnique(result, `Debt: ${inventory.technicalDebt[0]}`)
  if (inventory.documentationGaps.length > 0) addUnique(result, `Documentation: ${inventory.documentationGaps[0]}`)
  if (inventory.performanceOpportunities.length > 0) addUnique(result, `Performance: ${inventory.performanceOpportunities[0]}`)
  if (result.length === 0) addUnique(result, 'Add a focused regression test around the most important existing capability.')
  return result.slice(0, 20)
}

export function buildFeatureInventory(snapshot: RepositorySnapshot, now = Date.now()): ProjectFeatureInventory {
  const existingCapabilities: string[] = []
  const incompleteCapabilities: string[] = []
  const brokenBehavior: string[] = []
  const technicalDebt: string[] = []
  const testGaps: string[] = []
  const documentationGaps: string[] = []
  const securityConcerns: string[] = []
  const performanceOpportunities: string[] = []

  for (const framework of snapshot.frameworks) addUnique(existingCapabilities, `${framework} project integration`)
  for (const language of snapshot.languages.slice(0, 8)) {
    addUnique(existingCapabilities, `${language.name} source (${language.files} file${language.files === 1 ? '' : 's'})`)
  }
  if (snapshot.routes.length > 0) addUnique(existingCapabilities, `${snapshot.routes.length} application route file(s)`)
  if (snapshot.components.length > 0) addUnique(existingCapabilities, `${snapshot.components.length} reusable component file(s)`)
  if (snapshot.detectedCommands.some((command) => command.kind === 'test')) addUnique(existingCapabilities, 'Automated test command')
  if (snapshot.detectedCommands.some((command) => command.kind === 'lint')) addUnique(existingCapabilities, 'Lint command')
  if (snapshot.detectedCommands.some((command) => command.kind === 'typecheck')) addUnique(existingCapabilities, 'Type-check command')
  if (snapshot.detectedCommands.some((command) => command.kind === 'build')) addUnique(existingCapabilities, 'Build command')
  if (snapshot.readmeExcerpt) addUnique(existingCapabilities, 'Repository README')

  if (snapshot.testStatus === 'not_configured') addUnique(testGaps, 'No automated test command was detected.')
  if (!snapshot.detectedCommands.some((command) => command.kind === 'lint')) {
    addUnique(technicalDebt, 'No lint command was detected.')
  }
  if (!snapshot.detectedCommands.some((command) => command.kind === 'build')) {
    addUnique(technicalDebt, 'No build command was detected.')
  }
  if (!snapshot.readmeExcerpt) addUnique(documentationGaps, 'Repository README is missing or unreadable.')
  if (snapshot.readmeExcerpt && !/install|setup|getting started/i.test(snapshot.readmeExcerpt)) {
    addUnique(documentationGaps, 'README does not describe installation or setup.')
  }
  for (const signal of snapshot.dependencySignals) addUnique(technicalDebt, signal)

  for (const marker of snapshot.todoItems) {
    const text = marker.text.trim()
    const label = markerLabel(marker.file, marker.line, text)
    if (/security|auth|permission|secret|credential|xss|csrf|injection|traversal/i.test(text)) {
      addUnique(securityConcerns, label)
    } else if (/bug|broken|crash|incorrect|failure|regression|fix/i.test(text)) {
      addUnique(brokenBehavior, label)
    } else if (/test|coverage|spec/i.test(text)) {
      addUnique(testGaps, label)
    } else if (/doc|readme|guide|comment/i.test(text)) {
      addUnique(documentationGaps, label)
    } else if (/perf|slow|cache|memory|latency|optimi/i.test(text)) {
      addUnique(performanceOpportunities, label)
    } else if (/implement|finish|complete|support|feature/i.test(text)) {
      addUnique(incompleteCapabilities, label)
    } else {
      addUnique(technicalDebt, label)
    }
  }

  if (snapshot.buildStatus === 'failing') addUnique(brokenBehavior, 'The most recent recorded build is failing.')
  if (snapshot.testStatus === 'failing') addUnique(brokenBehavior, 'The most recent recorded test run is failing.')
  if (snapshot.dirty) addUnique(technicalDebt, 'The repository had uncommitted changes when observed; preserve unrelated work.')

  const base = {
    snapshotCapturedAt: snapshot.capturedAt,
    generatedAt: now,
    existingCapabilities,
    incompleteCapabilities,
    brokenBehavior,
    technicalDebt,
    testGaps,
    documentationGaps,
    securityConcerns,
    performanceOpportunities
  }
  return { ...base, highValueNextSteps: nextSteps(base) }
}
