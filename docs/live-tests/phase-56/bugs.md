# Phase 56 — Bugs & findings

## F-1 (finding, low severity, not an app crash) — loop can commit a test referencing a removed symbol
- **Where:** project-loop LocalExecutor validation on repos without a real test gate.
- **Repro:** aiarticle repo_grower; commit 368f2f7 replaced `planArticle` with `exportToMarkdown`;
  a later cycle (bd82926) committed `src/test/planner.test.js` importing the now-missing `planArticle`.
- **Root cause:** aiarticle package.json has only `typecheck` (`echo …`) and no test script, so
  validation cannot execute the broken import. The scorer approved on a superficially-valid diff.
- **Impact:** low — local only, push disabled, assisted-autonomy review catches it. Not a crash or
  data loss. Documented as expected behavior of weak-local-model autonomous dev on an under-gated repo.
- **Mitigation demonstrated:** added a loop-memory `[decision]` "keep planArticle export stable"
  (test 011) so future plan context steers away from removing public API.
- **Status:** documented; no app-code defect to fix (Akorith validated with the scripts available).

## F-2 (finding, by-design, NOT patched) — Project Builder can't reach a first commit when its scaffold's own validation fails
- **Where:** project-loop runner + local-executor `scoreAttempt` (`validationPassed` check).
- **Repro:** project_builder on an empty dir; model scaffolds a package.json with a `typecheck`
  script; executor runs `npm run typecheck`, it fails in the fresh dir (no deps), so
  `validationPassed`=false → shouldCommit=false → rollback. 5 cycles, never committed.
- **Root cause:** commit requires all 7 checks incl. every validation command passing. A scaffold
  that fails its own validation is (correctly) not committed.
- **Decision:** NOT a defect — this is the intended safety guarantee ("never commit code that
  fails validation"). Weakening it would risk committing broken code across all loop modes.
  Documented for transparency; no code change. Contrast: repo_grower/github_loop on repos whose
  validation passes DID produce real commits.

## F-3 (bug, low severity, FIXED) — companion memory search has no stemming ("testing" ≠ "tests")
- **Where:** `src/main/companions/memories.ts` `searchMemories` / `tokenize`.
- **Repro:** seed memory "Strongly dislikes fake or invisible tests"; `searchMemories(athena,
  "testing")` returns 0 hits (while "test"/"tests"/"fake" all hit).
- **Root cause:** scoring is exact token overlap; `tokenize` doesn't stem, so `testing` ≠ `tests`.
- **Fix:** add conservative prefix-overlap scoring — two tokens (both length ≥ 4) that share a
  4-char prefix count as a partial match (weight 0.5). Keeps exact matches ranked higher; adds no
  cross-word noise for short tokens. (test 030)
- **Status:** FIXED + retested (test 030): "testing" now returns the tests memory.

## F-4 (bug, low/medium severity, FIXED) — agents lose in-root writes when the model uses an absolute path
- **Where:** `src/main/action-agents/files.ts` (applyFileWrite / previewWrites / readWithinRoot)
  via shared `checkWritePath`.
- **Repro:** demo_script (safe_writes, aiarticle root); coder model emits
  `"path": "/Users/.../aiarticle/DEMO_SCRIPT.md"` (absolute, inside root); write rejected
  ("absolute paths are not allowed"); filesChanged 0, nothing written.
- **Root cause:** `checkWritePath` rejects ALL absolute paths. Correct for the shared primitive,
  but agents get absolute-in-root paths from weaker local models and lose the write.
- **Fix:** in the agents' files layer, if a path is absolute AND resolves inside the allowed root,
  rewrite it to root-relative before `checkWritePath`. Shared safety primitive unchanged (Loop
  still rejects raw absolute paths). Absolute-OUTSIDE-root and `..` traversal still rejected.
- **Status:** FIXED + retested (test 053): DEMO_SCRIPT.md now actually written within root;
  out-of-root absolute + traversal still rejected.
