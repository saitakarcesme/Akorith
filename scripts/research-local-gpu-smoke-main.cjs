require('tsx/cjs')
process.on('uncaughtException', (error) => {
  console.error('[research-local-gpu-smoke] uncaught exception:', error)
  process.exitCode = 1
})
process.on('unhandledRejection', (error) => {
  console.error('[research-local-gpu-smoke] unhandled rejection:', error)
  process.exitCode = 1
})
require('./research-local-gpu-smoke-harness.ts')
