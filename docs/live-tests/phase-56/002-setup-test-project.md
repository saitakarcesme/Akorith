# 002 — Create test project + sandboxes

- **Date/time:** 2026-07-01 ~16:40
- **App commit tested:** cb5c2e7 (installed)
- **Surface:** setup (persistent artifacts for Loop/Agent tests)

## Action taken
`aiarticle` was not present on this Mac, so created a real small project + sandboxes:

- `~/Desktop/projects/business/aiarticle/` — git repo (README.md, package.json, src/planner.js,
  .gitignore), initial commit `chore: scaffold aiarticle article planner`.
- `~/Desktop/projects/business/agent-desktop-organizer-sandbox/` — notes.txt, invoice.pdf
  (safe text placeholder), image-placeholder.png, draft.md, data.csv, screen-2026-07-01.png.
- `~/Desktop/projects/business/agent-pdf-summarizer-sandbox/` — report-2026.pdf, overview.pdf
  (safe text placeholders).
- `~/Desktop/projects/business/sample-notes-cli/` + `sample-quote-api/` — harmless git repos
  for the multi-repo Loop test.

## Expected
Real, persistent folders/repos usable by Loop and Agents.

## Actual
All created; `aiarticle` has git history. **PASS.**

## Persistent artifact
Everything above remains on disk (not deleted). Used by later Loop/Agent tests.

## Notes
Existing user projects (analizeRepo, articleai, tradescout24) were left untouched.
