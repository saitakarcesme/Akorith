# Production rebuild baseline

This document records the safety gate for the Loop, Benchmark, Plugins, and
Dashboard rebuild requested on 2026-07-12.

## Repository state

- Repository: `C:\Users\saita\Documents\Akorith`
- Baseline branch: `main`
- Baseline commit: `a53c7bf1ae99f56ebcf2b63c94fc3ea6293e7dc4`
- `origin/main` at capture: `a53c7bf1ae99f56ebcf2b63c94fc3ea6293e7dc4`
- Remote: `https://github.com/saitakarcesme/Akorith.git`
- Original worktree state: four modified tracked files and no untracked files
- Implementation worktree: clean detached worktree created from the exact
  `origin/main` baseline so the original user changes remain untouched

## Verified backup

The complete backup is stored at:

`C:\Users\saita\Desktop\akorith_yedek\20260712-214433`

Verification results:

- 323 tracked working-tree files copied and SHA-256 matched
- staged and unstaged binary patches captured
- complete Git history and all 28 refs captured in a Git bundle
- `git bundle verify` passed
- bundle heads were readable
- repository status, branches, tags, remotes, commit hashes, exclusions, and
  exact restore instructions were captured

An earlier incomplete attempt remains at the backup root. It was not reused or
overwritten; the timestamped directory above is the authoritative verified
backup.

## Baseline validation

Passing checks:

- `npm run typecheck`
- `npm run build`
- `npm run verify:workspace-loop`
- `npm run verify:local-executor`
- `npm run verify:controller`
- `npm run verify:startup-hydration`
- `npm run verify:local-runtime`
- `npm run verify:project-loop`
- `npm run verify:agents`

Pre-existing failures:

- `npm run verify:companions` fails two prompt assertions. The Companions
  product surface is intentionally removed by this rebuild.
- `npm run verify:windows-identity` fails its BrowserWindow development-icon
  source assertion even though the remaining identity assertions pass.

The rebuild must not turn these baseline observations into hidden or disabled
checks. Retained behavior receives replacement automated coverage.
