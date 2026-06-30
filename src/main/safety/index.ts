// Phase 47: shared deterministic safety primitives for Loop and Agents. None of
// these consult a model — they are the in-code guardrails that every proposed
// file write, command, and git op passes through.

export { checkWritePath, isSecretFile, type PathCheck } from './paths'
export { checkCommand, allowedCommandPrefixes, type CommandCheck } from './commands'
export {
  validatePatch,
  DEFAULT_PATCH_LIMITS,
  type PatchFile,
  type PatchOperation,
  type PatchFileVerdict,
  type PatchValidation,
  type PatchLimits
} from './patch'
export { checkGitPush, checkGitCommand, type GitOpCheck } from './git'
