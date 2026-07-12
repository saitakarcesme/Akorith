# Benchmark methodology and metric definitions

Akorith Benchmark is an evidence-first coding-agent harness. It executes discovered local, remote, and cloud models against immutable versioned fixtures in disposable workspaces. Model prose is never accepted as proof of success; only the independent validator's process/filesystem observations contribute to quality.

## Published suite

The current published suite is `akorith-production-benchmark-v1`, revision 1, schema 1, harness 1.0.0, with fixed seed `0xa4017e5d` and a default 180-second fixture timeout. A persisted suite revision is immutable: changing any embedded fixture requires publishing a new revision.

Its 23 fixtures cover all eight equally weighted categories:

| Category | Fixtures | Scope |
| --- | ---: | --- |
| Repository repair | 1 | Cross-file TypeScript package repair without weakening tests |
| Multi-language coding | 7 | Bounded-cache editing in C++, Go, Java, JavaScript, TypeScript, Python, and Rust |
| Code generation | 1 | Executable event-ledger implementation |
| Debugging and repair | 1 | Diagnosis and repair of a race/concurrency failure |
| Repository understanding | 1 | Relevant-file and change-map localization |
| Tool and agent use | 1 | Evidence-backed release triage with correct stopping behavior |
| Long context | 1 | Reconciliation of distributed policy fragments with an explicit unresolved ambiguity |
| Akorith real-world | 10 | Web, Java, Python service, C++, game loop, cross-platform bug fix, feature, refactor, test-writing, and Electron Loop model-gating work |

Every fixture embeds its starting files, task prompt, revision, derived seed, timeout, language/tags, and weighted validation requirements. Requirements are typed as process test, behavior assertion, artifact check, or repository assertion and are mandatory unless the fixture explicitly says otherwise.

## Execution and isolation

For each model/repetition, the runner deterministically shuffles the same fixtures from the suite seed. Each fixture receives its own derived seed and fresh directory under Akorith's OS-temp benchmark root. Fixture paths are resolved and containment-checked before exclusive file creation. Production mode refuses an in-memory workspace and requires a real temporary directory or container with a read-only source contract.

The production runtime uses:

- a stable deterministic fixture planner so different models receive the same published task contract;
- the same autonomous executor router used by Loop: installed coding CLI or structured local/remote patch;
- an independent workspace validator, separate from executor output;
- an AbortSignal and bounded per-fixture deadline;
- cleanup in a `finally` block, with a cleanup failure invalidating an otherwise completed fixture.

The validator snapshots at most 512 files, skips `.git` and `node_modules`, and hashes files no larger than 512,000 bytes. It records changed artifact paths from before/after hashes. If a fixture declares `package.json#scripts.test`, it runs `npm test -- --runInBand` with a 60-second deadline and bounded output. Validation evidence records process exit/timing and SHA-256 digests of stdout/stderr, not raw command output.

Evidence interpretation in the current production validator is deliberately conservative:

- `test_command` passes only when the declared package test command exits 0 before timeout;
- `behavior_assertion` passes only when that same deterministic test process passes;
- `artifact_check` passes when at least one changed artifact is independently observed and hashed;
- `repository_assertion` passes when original fixture files remain and all changed paths are bounded inside the workspace, with at most 64 reported artifacts;
- no runnable declared test means process and behavior requirements remain failed rather than inferred from model claims.

Simulation evidence is explicitly marked and excluded from production rankings unless a caller deliberately opts in.

## Run identity and fair comparison

Every model run persists:

- suite ID, revision, seed, schema, and fixture revisions;
- model catalog ID, provider/model, local/remote/cloud location, node, quantization, and context window;
- instruction profile, maximum attempts, temperature support/requested/applied values, provider parameters, and unsupported parameters;
- repetition index/count, harness version, dependency versions, optional environment image;
- observed/reported/unavailable hardware: platform, architecture, CPU model/cores, RAM, GPU, VRAM, and node;
- planner/executor usage provenance and stage latency;
- append-only fixture status, summaries, artifacts, evidence, errors, and duration.

The SHA-256 **compatibility key** covers schema, harness, instruction profile, max attempts, temperature record, sorted provider parameters, sorted unsupported parameters, repetition count, dependency versions, and environment image. Repetition index is excluded because repetitions are intended to compare with one another.

Two additional hashes are used by the service:

- **workload key** = suite ID + suite revision + suite seed + compatibility key;
- **environment key** = compatibility key + provider/model + location/node + quantization/context + complete hardware record + dependency versions + environment image.

Hardware and model identity are intentionally not in the low-level compatibility key because comparing models/hardware is part of the experiment; the service's environment key prevents repetitions from being silently pooled across different environments. The dominant environment cohort is used for a model aggregate and the excluded repetition count is exposed. Rankings require the dominant workload cohort and complete category evidence.

Temperature is currently recorded as unsupported/unknown by the production runtime when it cannot prove application. Akorith does not claim a controlled temperature in that case.

## Exact scoring

### Fixture quality

For fixture `f` with validation requirement weights `w_i` and independent pass values `p_i` (1 or 0):

```text
fixture_score(f) = 100 * sum(w_i * p_i) / sum(w_i)
```

The stored score is rounded to two decimal places. Mandatory failed requirement IDs are retained for inspection. A mandatory failure does not secretly change the arithmetic; it remains visible in the evidence and lowers the declared weighted score.

### Category and overall quality

```text
category_score(c) = arithmetic mean of all fixture scores in category c
overall_score      = arithmetic mean of the 8 category scores
```

All eight categories have a policy weight of `1/8`. A category is complete only if every expected fixture has scored evidence. A production run is ranking-eligible only when its status is completed, every suite fixture has validated evidence, its seed and compatibility cohort match, and it is not simulation. Incomplete/partial runs have no formal overall score and are excluded from ranking.

The result service may show an interim quality value from the arithmetic mean of observed fixture scores while a run is incomplete. That interim display is not a ranking score; category scores and rank remain unavailable until complete.

### Ranking and recommendations

Formal ranking sorts by:

1. higher overall quality;
2. lower total fixture latency for an exact quality tie;
3. fewer output tokens;
4. lower known cost;
5. stable catalog model ID.

Latency, tokens, and cost are transparent tie-breakers, not hidden quality weights. Category recommendation cards select the highest complete category score within the comparable workload cohort and explain the score, model, compared-model count, and evidence-fixture count. Model-fit cards identify categories in which the model matches the category leader.

## Exact efficiency metrics

| Metric | Definition | Unknown handling |
| --- | --- | --- |
| Input tokens | Sum of planner and executor `inputTokens` for every fixture/repetition | `null` if any contributing stage is unavailable or null |
| Output tokens | Sum of planner and executor `outputTokens` | `null` if any contributing stage is unavailable or null |
| Cached tokens | Sum of planner and executor cached tokens | `null` if any contributing stage is unavailable or null |
| Total tokens shown by service | Input + output only, summed across comparable repetitions | `null` if any repetition is incomplete; cached is shown separately in the low-level score |
| Cost USD | Sum of reported/estimated stage cost across comparable repetitions | `null` if any contributing cost is unavailable; no price is fabricated |
| Fixture duration | Monotonic elapsed time from workspace preparation through cleanup for that fixture | Always non-negative; includes planning, execution, validation, and fixture overhead |
| Total latency | Sum of fixture durations for a model run | Used as a quality tie-breaker |
| Speed, tokens/second | Sum of known executor output tokens divided by sum of executor latency seconds in the comparable repetitions | `null` when tokens are unknown or execution time is zero |
| Usage completeness | `reported` if every stage is reported, `estimated` if known but any stage estimated, otherwise `unavailable` | Preserved with the score |
| Repetition consistency | Inspect the per-repetition evidence/quality and the number of comparable vs excluded repetitions | No fabricated variance statistic is currently persisted |

## Hardware evidence

Local runs record OS/architecture/CPU/RAM from the client and the most recent measured NVIDIA GPU observation when available. Remote runs record hardware reported by the authenticated node, including GPU/VRAM when `nvidia-smi` produced an observation. Cloud hardware remains unavailable. This metadata is part of the environment identity and appears in evidence labels.

GPU samples from the shared monitor are displayed on Dashboard, but Benchmark's current `hardwareUtilizationPct` result field is `null`. The harness does not currently join a per-run GPU timeline to a Benchmark score, and it does not claim CPU utilization, RAM utilization over time, energy, or remote-node utilization percentages it did not observe.

## Metrics not currently evidenced

The current schema can preserve several related observations, but the production validator does **not** independently calculate these as standalone comparable metrics:

- pass@k, first-attempt success, repair success/time-to-passing, retry count;
- regression rate, compile/build success, correct-file localization, patch applicability, or test counts except where represented by the fixture's declared weighted requirements;
- time to first token, tool-call count, invalid tool calls, hallucinated paths, or Git-operation success;
- latency distribution/box statistics, statistical confidence intervals, or a numeric consistency score;
- per-run GPU/VRAM timeline, GPU utilization score, CPU/RAM utilization, or energy;
- pricing-derived estimated cost when the adapter supplies no cost.

These values remain unavailable in the UI/API rather than being seeded or inferred. The result interface therefore focuses on validated quality, exact stage/fixture time, reported-or-estimated tokens/cost, stored environment identity, evidence drill-down, and category routing recommendations.

## Persistence and cancellation

SQLite stores immutable suite JSON in `benchmark_lab_suites`, model runs in `benchmark_lab_model_runs`, and indexed fixture snapshots in `benchmark_lab_fixture_runs`. Terminal runs are immutable; running records may append fixture history but cannot change run identity or reorder previous fixtures.

A session accepts 1-16 unique models by default, a seed from 0 to 2,147,483,647, and 1-20 repetitions. Execution is sequential and cancellable. Completed fixture records are saved after each fixture. A running record found after process restart is marked failed with an interruption message rather than silently resumed or reported complete.
