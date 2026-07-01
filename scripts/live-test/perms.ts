import { describePermission } from '../../src/main/action-agents/permissions'
for (const m of ['preview','ask_write','safe_writes','safe_commands','manual_each'] as const) {
  console.log(m.padEnd(14), '->', describePermission(m as never))
}
