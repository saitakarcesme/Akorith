import { previewWrites, applyFileWrite } from '../../src/main/action-agents/files'
import { capabilitiesFor } from '../../src/main/action-agents/permissions'
const root = process.env.HOME + '/Desktop/projects/business/aiarticle'
const file = { operation: 'create', path: 'PERMFLOW_TEST.md', content: 'permission flow test\n' } as never
for (const mode of ['preview', 'ask_write', 'safe_writes'] as const) {
  const caps = capabilitiesFor(mode, false)
  const applies = caps.canWriteFiles && !caps.requiresStepApproval
  const r = applies ? applyFileWrite(root, file) : previewWrites(root, [file])[0]
  console.log(mode.padEnd(12), 'canWrite:'+caps.canWriteFiles, 'stepApproval:'+caps.requiresStepApproval, '->', applies ? ('APPLIED '+(r.ok?'ok':r.reason)) : 'PREVIEW/permission_requested (no write)')
}
