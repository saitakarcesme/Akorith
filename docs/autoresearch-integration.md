# Akorith Autoresearch integration

Akorith's Research creation flow now uses the autonomous experiment protocol
introduced by [karpathy/autoresearch](https://github.com/karpathy/autoresearch).
The integration was designed against upstream commit
`228791fb499afffb54b46200aca536f79142f117` and keeps that revision pinned for
the built-in starter so a future upstream change cannot silently alter an
existing Akorith experiment.

## Protocol preserved

- Establish the unchanged baseline first.
- Give the agent one explicit editable surface.
- Use one fixed experiment command and one comparable numeric metric.
- Commit each candidate before evaluation.
- Keep only a strict improvement.
- Reset equal, worse, out-of-scope, and crashed candidates to the last verified
  checkpoint.
- Persist a TSV ledger, command logs, commit identities, and a final Markdown
  report.
- Continue autonomously until the selected duration/cycle budget is exhausted
  or the user pauses the program.

## Akorith adaptations

- The built-in **Karpathy starter** installs the pinned upstream repository in
  Akorith's managed Research directory. It retains the upstream contract:
  `train.py` is editable, `prepare.py` and the evaluation harness are fixed,
  `uv run train.py` is the experiment, and lower `val_bpb` wins.
- An **Akorith project** runs in a dedicated `autoresearch/<date>-<job>` Git
  worktree. The user's active checkout is never used as the agent's writable
  experiment surface.
- Custom commands are parsed into one executable plus argv and run with
  `shell: false`. Shell operators and relative executable paths are not an
  execution surface.
- Akorith owns Git commits, metric parsing, logs, keep/discard decisions, and
  rollback. The model is instructed to make one scoped change and never owns
  the benchmark result.
- Existing evidence-report Research records remain readable and exportable.
  New jobs created by the UI use `research_mode = 'autoresearch'`.

## Built-in starter requirements

The upstream starter intentionally requires Python 3.10+, `uv`, and one NVIDIA
GPU. On first run Akorith executes `uv sync` and `uv run prepare.py` before the
baseline. Setup failures are persisted as actionable job errors and can be
resumed after the missing runtime or hardware issue is corrected.

The upstream project states an MIT license in its README. Akorith does not
vendor or modify its Python sources in the application bundle; the pinned
revision is fetched into a user-created managed experiment workspace when the
starter is launched.
