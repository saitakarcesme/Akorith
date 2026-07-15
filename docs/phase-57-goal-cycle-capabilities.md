# Phase 57 — Goal cycle capability map

Akorith Loop is a durable local workflow, not a one-shot coding prompt. Its invariant is simple:
**activity is not completion; inspectable evidence is completion.**

## Implemented foundation

- **Task-agnostic intake:** a Goal may target software, research, analysis, automation, creative
  work, or document/artifact production. The selected folder may contain source code, a book/PDF,
  notes, datasets, images, or prior generated work.
- **Goal contract:** one precise outcome, bounded deliverables, observable acceptance criteria,
  constraints, and the first objective are stored before execution.
- **Five-state durable loop:** Understand -> Plan -> Execute -> Analyze -> Replan -> Plan. Each
  run, event, backlog objective, commit, and review survives restart in SQLite.
- **Evidence gate:** completion requires at least one concrete piece of evidence, no remaining
  work, and confidence >= 0.55. Partial chapters, unvalidated builds, plans, and model claims do
  not pass the gate.
- **Recovery:** the next objective is checkpointed after analysis. Explicit blockers or three
  stalled cycles pause for human review; the run never spins indefinitely.
- **Concurrency:** every Goal has an independent AbortController, event stream, model, folder,
  status, and history. Several Goals can run together and pause independently.
- **Safety:** work stays in the selected folder, local structured execution keeps its path and
  command allowlists, Git commits are local checkpoints, and automatic push is disabled.
- **Quiet observability:** the UI shows the current diagram state, definition of done, elapsed time,
  and only four recent meaningful checkpoints instead of raw CLI/event noise.

## Tasks the foundation is designed to support

- Build/refactor/test a software project, including C/C++ games and web/desktop apps.
- Read a folder of research material, keep citations/evidence, and produce a structured report.
- Inventory a book's chapters, summarize them iteratively, validate coverage, and generate a
  polished PDF plus optional Markdown/DOCX source.
- Transform datasets or batches of local files with a manifest and validation report.
- Produce documentation, release notes, migration plans, design audits, or reproducible analysis.
- Continue partially completed work after restart without discarding earlier artifacts or review
  conclusions.

## Guarded extensions after the foundation

These are intentionally separate capabilities rather than hidden model promises:

1. **Direct attachment intake:** copy user-selected PDFs/DOCX/images into a managed Goal input area,
   hash them, and preserve original filenames. Today the user places them in the selected folder.
2. **Typed artifact validation:** PDF page/open checks, DOCX package validation, image dimensions,
   media duration/codecs, dataset schema checks, and executable smoke tests.
3. **Source/citation ledger:** URL, title, retrieval time, excerpt hash, and claim-to-source mapping
   for research Goals; offline Goals must say when fresh web evidence is unavailable.
4. **Human checkpoints:** optional approval before destructive migrations, publishing, paid actions,
   or acceptance-criterion changes. Pausing must persist state rather than restart the Goal.
5. **Budget policies:** maximum cycles, elapsed time, disk growth, generated files, and model/token
   usage per Goal, with an explicit review state when a limit is reached.
6. **Idempotent side effects:** a durable operation key for uploads, exports, releases, and other
   external actions so resume/retry cannot duplicate them.
7. **Artifact handoff:** final files with type, path, checksum, size, creation step, validation
   evidence, and Reveal/Open actions.
8. **Branchable review:** let a user revise the Goal contract or acceptance criteria while retaining
   the original contract and the complete audit trail.

## Design sources

The checkpoint/thread model follows the durable state and replay principles described by
[LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence). Pauses
and resumable human decisions follow the semantics of
[LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts). Durable
execution, retries, and crash recovery are aligned with
[Temporal's durable execution model](https://docs.temporal.io/) and Vercel's guidance for
[human-in-the-loop workflows](https://vercel.com/kb/guide/human-in-the-loop-with-chat-sdk-and-workflow-sdk).
