import assert from 'node:assert/strict'
import {
  buildGoalReviewPrompt,
  fallbackGoalReview,
  parseGoalProgressReview,
  parseGoalUnderstanding
} from '../src/main/project-loop/goal-cycle.ts'
import type { ProjectLoop, ProjectLoopRun } from '../src/main/project-loop/types.ts'

const loop: ProjectLoop = {
  id: 'loop-1',
  title: 'Summarize the whole book',
  idea: 'Read every chapter and create a polished summary PDF.',
  mode: 'project_builder',
  status: 'active',
  localPath: '/tmp/book-goal',
  autonomy: 'assisted',
  safety: 'standard',
  scheduleKind: 'manual',
  scheduleMinutes: 0,
  dailyCommitTarget: 1,
  minCommitsPerRun: 0,
  maxCommitsPerRun: 1,
  localModelProvider: 'opencode',
  pushEnabled: false,
  createdAt: 1,
  updatedAt: 1,
  runCount: 0,
  commitCount: 0
}

const run: ProjectLoopRun = {
  id: 'run-1',
  loopId: loop.id,
  runIndex: 1,
  status: 'success',
  startedAt: 1,
  endedAt: 2,
  summary: 'Chapter one summary created.',
  filesChanged: 1,
  commandsRun: 1,
  testsRun: 0,
  commitsCreated: 1
}

const understanding = parseGoalUnderstanding(`\`\`\`json
{
  "summary": "Create one accurate summary PDF for every chapter.",
  "task_kind": "document",
  "deliverables": ["summary.pdf", "chapter outline"],
  "acceptance_criteria": ["Every chapter is represented", "The PDF opens successfully"],
  "constraints": ["Use only the selected workspace"],
  "first_objective": "Read the source and inventory every chapter."
}
\`\`\``, loop.idea!)

assert.equal(understanding.taskKind, 'document')
assert.equal(understanding.deliverables.length, 2)
assert.match(understanding.firstObjective, /inventory every chapter/i)

const partial = parseGoalProgressReview(JSON.stringify({
  goal_met: true,
  progress_summary: 'The first chapter is summarized.',
  completed_evidence: ['chapter-01.md'],
  remaining_work: ['All other chapters and the final PDF'],
  next_objective: 'Summarize chapter two.',
  confidence: 0.9,
  blocked: false
}), run, 1)
assert.equal(partial.goalMet, false, 'remaining work must prevent completion')
assert.match(partial.nextObjective ?? '', /chapter two/i)

const complete = parseGoalProgressReview(JSON.stringify({
  goal_met: true,
  progress_summary: 'Every chapter is summarized and the PDF was opened successfully.',
  completed_evidence: ['summary.pdf', 'pdf validation passed'],
  remaining_work: [],
  next_objective: null,
  confidence: 0.94,
  blocked: false
}), run, 4)
assert.equal(complete.goalMet, true)
assert.equal(complete.nextObjective, undefined)

assert.equal(fallbackGoalReview(run, 1).goalMet, false, 'one commit is never enough to infer the whole Goal is complete')
const reviewPrompt = buildGoalReviewPrompt({ loop, understanding, run, attempt: 2, workspaceContext: 'summary/chapter-01.md' })
assert.match(reviewPrompt, /ENTIRE original goal/)
assert.match(reviewPrompt, /acceptance criterion/)

console.log('verify-goal-cycle: ok')
