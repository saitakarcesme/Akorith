# Telemetry, privacy, retention, and backfill

Akorith telemetry is a local operational event ledger. It powers Dashboard, Loop/Benchmark counters, model and plugin usage, streaks, Git outcomes, and GPU history. It is not an analytics upload service and it is not a transcript store.

## What the ledger records

`telemetry_events` accepts these versioned event kinds:

- model request started, completed, or failed;
- canonical token usage;
- plugin invocation;
- Loop cycle;
- Benchmark task;
- Git commit;
- Git push;
- GPU sample aggregate.

Common fields are occurrence/creation time, outcome, correlation/source key, provider, model, local/remote/cloud location, node, task type, reasoning mode, duration, and bounded metadata. Kind-specific identifiers include plugin ID, Loop ID, Benchmark run/task/suite, repository ID, commit SHA, remote/branch, and aggregate GPU device/bucket metrics.

Token totals live only on `token_usage` events. Completion events do not repeat token values, preventing aggregate double counting. Prompt/output counts and costs preserve the adapter's `estimated` flag. If a provider cannot report a cost, Akorith records no fabricated price in Benchmark; the chat compatibility path may carry zero with its explicit estimate provenance.

## Content that must not enter telemetry

The event contract excludes:

- prompt or response text;
- terminal output;
- repository file contents or patches;
- raw command stdout/stderr;
- plugin request/response bodies;
- credentials, tokens, cookies, or authorization headers;
- model chain-of-thought.

Chat messages still exist in their normal per-session SQLite tables because conversation persistence is a product feature; that content is separate from telemetry. Loop command evidence and Benchmark evidence have their own bounded domain stores. They are not copied into Dashboard events.

Metadata accepts only finite scalars, arrays, and plain objects. Limits are 16 KiB serialized, depth 4, 64 object entries, 32 array entries, 64-character keys, and 2,048-character strings. IDs and enums are validated, null bytes/control shapes rejected, and numeric metrics must be finite/non-negative. An invalid event is rejected before SQLite.

## Local storage and network behavior

Unified telemetry is stored in `loopex.db` under Electron's Akorith `userData` directory. The renderer reads aggregates over typed IPC; it does not receive a direct database handle. There is no implementation that transmits the telemetry ledger to Akorith, GitHub, a plugin, or a model provider.

Remote inference naturally sends the selected model's generation prompt to the paired node. Remote operational metadata such as node/model/usage can be stored locally after the request. Pairing bearer tokens are encrypted separately with OS `safeStorage` and are never telemetry metadata.

## Migration and legacy usage backfill

Telemetry migrations are additive, transactional, and recorded in the shared `schema_migrations` ledger under scope `telemetry`:

1. version 1 creates the unified event table, indexes, unique source keys, and per-row backfill markers;
2. version 2 creates bounded GPU detail and rollup tables/indexes.

The existing `usage_events` table remains the compatibility write contract for visible chat sends. Startup backfill translates each unprocessed row into:

- one `model_request_completed` event with zero token fields;
- one canonical `token_usage` event with normalized legacy counts/cost and the original estimated flag.

Both events share a legacy correlation ID and unique deterministic source keys. A `(usage_events_v1, legacy-row-id)` marker is written in the same transaction. The default pass uses batches of 1,000 and processes at most 100,000 rows per invocation (hard bounds 10,000 per batch and 1,000,000 per invocation). It resumes after interruption, uses `INSERT OR IGNORE`, and cannot add the same legacy total twice. Legacy provider IDs matching local/Ollama are marked local; other legacy providers are marked cloud. Missing cached tokens become zero because the old table did not have that field.

No migration deletes chat history, projects, old usage rows, Loop data, or Benchmark data.

## GPU sampling and retention

The shared monitor polls local `nvidia-smi` and paired-node GPU sources. Defaults are:

- observed source poll: every 5 seconds;
- source deadline: 4 seconds (the local command has its own 3-second deadline);
- failure backoff: 1 second, doubled to a 60-second maximum;
- maintenance: every 15 minutes.

A source that cannot measure a GPU reports unsupported, unavailable, or disconnected with a reason. Missing values remain absent. Samples are deduplicated per source/device timestamp and validated for utilization, VRAM, temperature, and power ranges before persistence.

Default retention is:

- detailed samples: 48 hours;
- rollup bucket: 15 minutes;
- rollup history: 365 days.

Maintenance aggregates only complete expired buckets. For each node/device/bucket it records sample count, first/last sample time, mean/peak utilization, mean/peak VRAM used, total VRAM, mean/peak temperature, and mean/peak power where measured. It then deletes detail older than the completed bucket boundary and rollups older than one year. A deterministic source key makes the associated `gpu_sample_aggregate` telemetry event idempotent.

Policy validation permits detail retention from one bucket to 30 days, buckets from one minute to one day, and rollups from the detail period to five years. The shipped runtime uses the defaults above.

General non-GPU telemetry currently has no automatic age-based purge. Users should treat `loopex.db` as retained local history and include it in their own data retention/backups. Do not manually delete rows while Akorith is running.

## Dashboard derivations

All Dashboard values come from persisted events plus the monitor's latest live GPU snapshot:

- **Lifetime tokens**: sum of prompt + completion token events; cached tokens are shown separately in model/task aggregates and are not added to this displayed total.
- **Peak tokens**: largest local-calendar-day prompt + completion total.
- **Longest task**: maximum duration of a completed model request.
- **Current/longest streak**: consecutive local calendar days containing at least one completed request; current is zero if the as-of day has none.
- **Total tasks**: completed + failed model request lifecycle events.
- **Fast-mode percent**: completed requests with `metadata.fastMode=true` divided by completed requests; unavailable if none.
- **Most-used reasoning**: most frequent non-none/non-unknown reasoning mode among completed requests.
- **Models**: grouped by provider/model/location/node, with lifecycle runs/success/failure, token fields, and total duration.
- **Plugins**: terminal plugin invocation count, completed vs failed/cancelled/reverted, and total duration.
- **Task types**: model lifecycle and token events grouped by declared task type.
- **Daily heatmap**: 365 local-calendar cells; activity is tokens when nonzero, otherwise completed+failed tasks; intensity is 0 or `ceil(value/peak*4)` clamped 1-4.
- **Weekly heatmap**: Monday-start local-day groups; tokens/tasks summed and intensity normalized to peak week.
- **Cumulative heatmap**: running tokens/tasks from the 365-day start, normalized to the final peak.
- **GPU**: latest actual observations across local/remote sources. No observed device produces a calm unavailable/disconnected reason, not a static GPU card.

SQLite JSON1 is used for skill/fast-mode insights when present. If an older SQLite build lacks JSON1, those two optional insights remain zero/unavailable while the rest of Dashboard continues.

## Failure behavior

Operational telemetry is non-blocking: a persistence failure logs a bounded warning and does not make an otherwise successful chat/executor operation fail. This means the event ledger is the authoritative record of what was successfully persisted, not a guarantee that every external action has an event under disk/database failure.

Benchmark scoring never reads Dashboard aggregates as correctness proof; it has independent fixture evidence. Loop correctness likewise reads its own cycle validation/review records. Unified telemetry is the cross-surface operational view, not a substitute for domain evidence.
