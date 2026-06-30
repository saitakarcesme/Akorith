import { sendStructured } from '../local-runtime'
import { nextOpenBacklogItem } from './backlog'
import { memoryContextBlock } from './memory'
import { renderProjectContext, type ProjectContext } from './context'
import type { ProjectLoop } from './types'

// Phase 48: the planner chooses the next objective for a run. It prefers an open
// backlog item; otherwise it asks the local model for one small, useful next
// objective grounded in the project context + loop memory.

export interface ChosenObjective {
  objective: string
  source: 'backlog' | 'model' | 'idea'
  backlogItemId?: string
}

interface ModelObjective {
  objective: string
}

function validateModelObjective(v: unknown): ModelObjective | null {
  if (!v || typeof v !== 'object') return null
  const obj = (v as Record<string, unknown>).objective
  if (typeof obj !== 'string' || obj.trim().length < 4) return null
  return { objective: obj.trim().slice(0, 400) }
}

export async function chooseObjective(loop: ProjectLoop, ctx: ProjectContext): Promise<ChosenObjective> {
  // 1) An explicit backlog item always wins (deterministic, user-curated).
  const item = nextOpenBacklogItem(loop.id)
  if (item) {
    return {
      objective: item.detail ? `${item.title}\n\n${item.detail}` : item.title,
      source: 'backlog',
      backlogItemId: item.id
    }
  }

  // 2) Fresh, empty project_builder loop with an idea but no files: scaffold it.
  if (loop.mode === 'project_builder' && loop.idea && ctx.fileTree.length === 0) {
    return { objective: `Scaffold the initial project for this idea:\n${loop.idea}`, source: 'idea' }
  }

  // 3) Ask the local model for one small next objective.
  const memory = memoryContextBlock(loop.id)
  const prompt = `You are planning the next small improvement for a software project Akorith is growing with local models.

Project title: ${loop.title}
Mode: ${loop.mode}
${loop.idea ? `Original idea: ${loop.idea}\n` : ''}${memory ? `Project memory:\n${memory}\n` : ''}
Project context:
${renderProjectContext(ctx)}

Choose ONE small, concrete, useful next objective for the next commit. Keep it achievable in a single patch.`

  const res = await sendStructured<ModelObjective>(prompt, {
    model: loop.localModel,
    validate: validateModelObjective,
    schemaHint: 'Return {"objective": "..."} with a single concrete next objective.'
  })
  if (res.ok && res.value) {
    return { objective: res.value.objective, source: 'model' }
  }
  // 4) Fallback: a safe maintenance objective so the loop still does something useful.
  return {
    objective:
      loop.idea ?? 'Improve project documentation: add or refine README with setup, usage, and a short roadmap.',
    source: 'idea'
  }
}
