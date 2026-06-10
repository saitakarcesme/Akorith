import { contextBridge } from 'electron'

// Phase 1: the bridge is intentionally empty — no IPC surface exists yet.
// Exposing the (typed, frozen) object now locks in the security pattern so later
// phases only ever add vetted methods here, never enable nodeIntegration.
//
// TODO(phase 2): terminal API — createSession/write/resize/onData for node-pty PTYs.
// TODO(phase 3): chat API — sendPlannerMessage/onChunk for Claude/ChatGPT/Ollama.
// TODO(phase 3): bridge API — sendPromptToTerminal(terminalId, text).
// TODO(phase 4): history API — list/load/save sessions (SQLite).
const api = Object.freeze({})

contextBridge.exposeInMainWorld('api', api)
