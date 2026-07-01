// Phase 56 live-test harness.
//
// Runs INSIDE Electron (via scripts/live-test/main.cjs which registers tsx's
// require hook) so `app.getPath('userData')` resolves to the REAL Akorith userData
// directory and better-sqlite3 loads the same native build the app uses. It then
// calls the EXACT same main-process functions the IPC handlers call (createLoop,
// runOneCycle, sendCompanionMessage, createAgent, runAgent, ...) against the REAL
// loopex.db. NOT raw SQL — the real app data/logic layer. Any data created is
// visible in Akorith on next launch.
//
// One op per launch, selected by the JSON argv; result printed as RESULT:<json>.

import { app } from 'electron'
import * as db from '../../src/main/db'
import * as loop from '../../src/main/project-loop/store'
import * as loopRuns from '../../src/main/project-loop/runs'
import * as loopEvents from '../../src/main/project-loop/events'
import * as loopCommits from '../../src/main/project-loop/commits'
import * as loopBacklog from '../../src/main/project-loop/backlog'
import * as loopMemory from '../../src/main/project-loop/memory'
import * as runner from '../../src/main/project-loop/runner'
import * as cStore from '../../src/main/companions/store'
import * as cSessions from '../../src/main/companions/sessions'
import * as cMessages from '../../src/main/companions/messages'
import * as cChat from '../../src/main/companions/chat'
import * as cMem from '../../src/main/companions/memories'
import * as cExtract from '../../src/main/companions/extract'
import * as aStore from '../../src/main/action-agents/store'
import * as aTemplates from '../../src/main/action-agents/templates'
import * as aRuns from '../../src/main/action-agents/runs'
import * as aExec from '../../src/main/action-agents/executor'
import * as aPlan from '../../src/main/action-agents/planner'
import * as runtime from '../../src/main/local-runtime/index'

function print(value: unknown): void {
  process.stdout.write('\nRESULT:' + JSON.stringify(value) + '\n')
}

async function dispatch(op: string, a: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case 'runtimeStatus':
      return runtime.localRuntimeStatus()
    case 'counts':
      return { loops: loop.listLoops().length, companions: cStore.listCompanions().length, agents: aStore.listAgents().length }

    // ---- Loop ----
    case 'createLoop':
      return loop.createLoop(a as never)
    case 'listLoops':
      return loop.listLoops()
    case 'getLoop':
      return loop.getLoop(a.id as string)
    case 'runLoop':
      return runner.runOneCycle(a.id as string)
    case 'setLoopStatus':
      return loop.setLoopStatus(a.id as string, a.status as never)
    case 'listLoopRuns':
      return loopRuns.listRuns(a.id as string)
    case 'listLoopEvents':
      return loopEvents.listEvents(a.id as string)
    case 'listLoopCommits':
      return loopCommits.listCommits(a.id as string)
    case 'addBacklog':
      return loopBacklog.addBacklogItem({ loopId: a.id as string, title: a.title as string, detail: a.detail as string })
    case 'listBacklog':
      return loopBacklog.listBacklog(a.id as string)
    case 'addLoopMemory':
      return loopMemory.addLoopMemory(a.id as string, (a.kind as never) ?? 'note', a.content as string)
    case 'listLoopMemory':
      return loopMemory.listLoopMemories(a.id as string)

    // ---- Companions ----
    case 'listCompanions':
      return cStore.listCompanions()
    case 'createSession':
      return cSessions.createSession(a.companionId as string, a.title as string | undefined)
    case 'listSessions':
      return cSessions.listSessions(a.companionId as string)
    case 'addUserMessage':
      return cMessages.addMessage(a.sessionId as string, a.companionId as string, 'user', a.content as string)
    case 'listMessages':
      return cMessages.listMessages(a.sessionId as string)
    case 'sendCompanion':
      return cChat.sendCompanionMessage({ companionId: a.companionId as string, sessionId: a.sessionId as string, prompt: a.prompt as string, model: a.model as string | undefined })
    case 'createMemory':
      return cMem.createMemory(a as never)
    case 'listMemories':
      return cMem.listMemories(a.companionId as string, {})
    case 'searchMemories':
      return cMem.searchMemories(a.companionId as string, a.query as string)
    case 'memoryCount':
      return cMem.countMemories(a.companionId as string)
    case 'pinMemory':
      return cMem.pinMemory(a.id as string, a.pinned as boolean)
    case 'archiveMemory':
      return cMem.archiveMemory(a.id as string)
    case 'forgetMemory':
      cMem.forgetMemory(a.id as string)
      return { forgotten: a.id }
    case 'extractMemories':
      return cExtract.extractMemoriesFromSession(a.sessionId as string)

    // ---- Agents ----
    case 'listTemplates':
      return aTemplates.AGENT_TEMPLATES.map((t) => ({ id: t.id, name: t.name, defaultPermission: t.defaultPermission, needsRoot: t.needsRoot, note: t.note }))
    case 'createAgent':
      return aStore.createAgent(a as never)
    case 'listAgents':
      return aStore.listAgents()
    case 'getAgent':
      return aStore.getAgent(a.id as string)
    case 'planAgent': {
      const agent = aStore.getAgent(a.id as string)
      if (!agent) throw new Error('agent not found')
      return aPlan.planAgent(agent, a.input as string | undefined)
    }
    case 'runAgent':
      return aExec.runAgent(a.id as string, a.input as string | undefined)
    case 'listAgentRuns':
      return aRuns.listRuns(a.id as string)
    case 'agentRunDetail':
      return { run: aRuns.getRun(a.runId as string), events: aRuns.listEvents(a.runId as string), artifacts: aRuns.listArtifacts(a.runId as string) }

    default:
      throw new Error(`unknown op: ${op}`)
  }
}

async function main(): Promise<void> {
  app.setName('Akorith')
  await app.whenReady()
  const raw = process.argv.find((v) => v.trim().startsWith('{')) ?? '{}'
  let cmd: { op: string; args?: Record<string, unknown> }
  try {
    cmd = JSON.parse(raw)
  } catch {
    print({ ok: false, error: `bad command json: ${raw}` })
    return app.quit()
  }
  try {
    db.initDb()
    const result = await dispatch(cmd.op, cmd.args ?? {})
    print({ ok: true, op: cmd.op, result })
  } catch (err) {
    print({ ok: false, op: cmd.op, error: err instanceof Error ? err.message : String(err) })
  }
  app.quit()
}

void main()
