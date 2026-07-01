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
