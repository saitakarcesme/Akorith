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
