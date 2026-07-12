# Autonomous Loop

Loop continuously improves one Git-backed repository. A normal setup selects a project source, selects a probed executor model, and starts. There is no required task, feature, milestone, or approval prompt. After each validated push, the scheduler starts another evidence-based cycle until the user pauses or stops the Loop or a hard safety condition is reached.

## Onboarding

### New project

The user selects a local parent directory and project name and either supplies a GitHub URL or requests creation through the connected GitHub plugin. Before the Loop is persisted as running, Akorith:

1. validates the parent and creates one direct child with a conservative slug;
2. validates or creates a canonical GitHub remote;
3. selects a planner independently of the executor;
4. derives a project summary and plan from the project name and remote metadata;
5. writes `README.md` and `PLAN.md`;
6. initializes `main`, configures the Loop Git identity, and creates the initial commit;
7. adds `origin`, verifies non-interactive remote reachability and push access, and performs the initial non-force push;
8. persists the Loop, its exact planner/executor identities, counters, and first activity event.

Automatic repository creation is permitted only through an authenticated GitHub plugin adapter. The default repository adapter reports authentication required; it does not create or claim a remote. Supplying a real GitHub URL is the available alternative.

### Existing GitHub project

The normal input is a GitHub repository URL. Akorith rejects unsupported URL shapes, canonicalizes owner/repository identity, allocates a unique managed workspace, clones without tags, recursive submodules, or LFS smudging, detects the active/default branch and technology profile, and verifies remote push access. Authentication-required, repository-not-found, permission-denied, remote mismatch, Git unavailable, directory conflict, and unsafe-path failures remain distinct recoverable errors.

Two active Loops cannot own the same canonical repository. The onboarding service checks persisted active records before it creates another Loop.

## Model discovery and gating

The catalog discovers models from enabled Claude/Codex/OpenCode providers, local Ollama, and authenticated remote nodes. It records provider, model, local/remote/cloud source, node, availability, context window, quantization, VRAM requirement, load/latency metadata where available, declarations, and probe evidence.

An executor is selectable only when all of these are true:

- the exact catalog model is currently available;
- its latest probe is a matching `code_execution` probe for the same provider, model, source, and node;
- the probe succeeded and remains inside its freshness window;
- the probe confirmed file read, edit, create, and delete; command execution; tool use; multi-file reasoning; code generation; test execution; debugging; iterative repair; and streaming status.

Probe output is based on a disposable Git fixture and host-observed file/process evidence. An endpoint answering a health check is not evidence of code execution. Missing, running, failed, unavailable, cancelled, invalid, future-dated, stale, or partially confirmed probes produce an explicit ineligibility reason.

A planner is a separate choice. It needs an available model with confirmed reasoning, either declared by its provider adapter or established by a fresh reasoning probe. It does not need filesystem or command capabilities. If no eligible reasoning model is available, Akorith's deterministic inventory planner is used and identified as such.

## Persistent cycle

Each cycle follows this state sequence:

1. **Observe**: capture branch/HEAD, dirty state, bounded file tree, languages, frameworks, package managers and scripts, README excerpt, recent commits, unfinished-work comment evidence, routes/components, test/build state, and dependency signals.
2. **Inventory**: persist existing and incomplete capabilities, broken behavior, technical debt, test/documentation gaps, security concerns, performance opportunities, and ranked high-value next steps.
3. **Plan**: ask the reasoning planner for one validated structured task: title, task, reason, user value, likely areas, acceptance criteria, validation commands, risk, complexity, and task kind. Invalid or repeated output falls back to a deterministic inventory task.
4. **Execute**: run the selected CLI coding agent in the repository or request a structured patch from a local/remote model. The executor receives the current snapshot/inventory and existing conventions, not unrestricted shell interpolation.
5. **Validate**: run detected test, lint, typecheck, and build commands plus planner-supplied commands through the allowlisted validator. Persist command label, start, duration, exit code, timeout, bounded stdout/stderr, changed files, and regression result.
6. **Repair**: on execution, validation, or review failure, return the evidence to the same executor. Retry up to the Loop's configured ceiling; the default is three repair attempts.
7. **Review**: inspect the actual diff. Deterministic review rejects missing validation, irrelevant or empty diffs, secret-like additions, test deletion, placeholders, unrelated files, and unreviewed generated output. Only after those checks pass may the planner/reviewer add a structured reasoning review; deterministic rejection cannot be overridden.
8. **Commit**: commit only the enumerated changed paths with a conventional message derived from the task kind. Unrelated staged work is not included.
9. **Push**: push `HEAD` to the validated branch without force. A committed but unpushed cycle is retained for an automatic push retry.
10. **Schedule**: clear the active cycle, persist metrics/activity, and schedule the next cycle. The production delay defaults to five seconds and is bounded from one second to one hour.

Task kinds map to commit types: code to `feat`, bug fix to `fix`, test to `test`, documentation to `docs`, refactor to `refactor`, and infrastructure to `chore`. The subject is normalized and bounded.

## Execution routes

### Installed CLI agents

- Codex: `codex exec --sandbox workspace-write --ephemeral --color never --output-last-message <temporary file> --skip-git-repo-check`, prompt over stdin.
- Claude: `claude --print --output-format json --permission-mode auto --no-session-persistence`, prompt over stdin.
- OpenCode: `opencode run --format json --auto --file <mode-0600 task file>` with a constant command message.

The model name has a strict character allowlist, output is bounded, status is read with `git status --porcelain -z`, and scratch files are removed. CLI token counts are estimated when those CLIs do not report usage and are marked estimated.

### Local and remote structured patches

Ollama and paired-node models return a structured action. The client—not the remote node—validates and applies file mutations within the repository root, runs approved validation commands, records changed files/evidence, and can restore enumerated paths to the checkpoint. A remote node is inference-only and cannot read the repository, run a client command, or perform Git operations.

## Failure and recovery semantics

Ordinary coding or test failures are task failures, not Loop hard stops. When the repair ceiling is exhausted, Akorith restores only the cycle's enumerated changed paths to the pre-cycle checkpoint, records the cycle as reverted, increments the failed-task counter, and schedules a different task.

The following conditions can stop automatic continuation:

- explicit user stop;
- configured token total or cost ceiling reached;
- permanent repository/authentication failures: authentication required/failed, repository not found/corrupt, permission denied, or remote mismatch;
- the configured number of consecutive infrastructure failures (default five);
- a restart recovery that cannot prove and restore a safe checkpoint.

Pause and stop abort the active model/process request and transition through `pausing`/`stopping` before reaching a stable state. Resume is allowed only from `paused`.

The engine holds both a persisted Loop lease and a cross-process file lease for the repository. Heartbeats refresh them during long operations. On application restart:

- `pausing` becomes `paused` and `stopping` becomes `stopped`;
- an interrupted uncommitted cycle with a known checkpoint and no more than 256 changed files restores those exact paths and becomes cancelled;
- a committed unpushed cycle retries the push before any new work;
- a running clean Loop is rescheduled;
- ambiguous recovery changes the Loop to `error` with `Repository recovery failed` instead of guessing.

No recovery path uses `git reset --hard`, broad `git clean`, force push, or a repository-wide destructive restore.

## Persistence and observability

SQLite stores Loop records, cycles, activity events, repository snapshots, feature inventories, every planner/executor/repair/reviewer model call, token/cost provenance, and repository leases. The list/detail pages read those persisted records, so navigation and app restart do not erase state.

Loop-level counters include commits, pushes, successful tasks, failed/reverted tasks, input/output/cached tokens, cost, current phase, last activity, and consecutive infrastructure failures. Each completed cycle retains the task schema, changed files, command evidence, review, commit hash/message, push state, duration, and exact provider/model role identities.

Activity events contain concise operational summaries and structured details. Raw chain-of-thought is neither requested for display nor persisted as an activity stream. Low-level executor output is bounded and is not promoted to telemetry content.

## Operational checklist

Before leaving a Loop unattended:

1. confirm `git` is installed and the repository's `origin` accepts a dry-run push non-interactively;
2. run the selected model's code-execution probe and review its freshness/capability badges;
3. ensure detected validation commands are appropriate for the repository;
4. set token/cost limits in Advanced constraints if required;
5. start the Loop and confirm its first observer/inventory events;
6. use Pause for a resumable interruption and Stop for a terminal user decision.

If a Loop enters `error`, do not start another writer in the same folder. Inspect its activity and Git recovery state first; see [Troubleshooting](production-troubleshooting.md).
