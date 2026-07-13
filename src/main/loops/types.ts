export type MacroStatus =
  | 'idle'
  | 'preparing_context'
  | 'proposing'
  | 'awaiting_approval'
  | 'sending'
  | 'awaiting_executor_result'
  | 'summarizing'
  | 'awaiting_permission'
  | 'auto_running'
  | 'paused'
  | 'completed'
  | 'stopped'
  | 'error'

export type MacroMode = 'approval' | 'auto'
export type MacroExecutorType = 'pty' | 'local'

// Phase 28: main-process loop types are centralized here. The preload .d.ts
// still mirrors a broader renderer-safe status union until Akorith has a shared
// type package that can be imported by both Electron and web builds.
