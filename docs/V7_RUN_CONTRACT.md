# v7 Run runtime contract

M5 implements the headless journal scheduler. Public operations in
`workflow-runtime.mjs` cover start/get/next/claim/complete/fail/retry/pause/resume/
cancel/approve, dispatch intent/receipt, and metadata event cursors.

## Commit and authority

- A Run owns a copy of its entire current pack and content-addressed resources.
  Preset edits/deletion do not change existing Runs. Every read verifies pins,
  resource bytes and the event chain. Child/Skill pins remain the M9 executor gate.
- `events.jsonl` is authoritative. An fsynced state patch commits each transition;
  `run.json` is reconstructable. Cache failure returns `committed: true` and never
  releases another node through the failed call. Windows guarantees are limited
  to process crashes, not power-loss durability of directory entries.
- Store/Run writer locks reject concurrent owners. Explicit recovery only removes
  a confirmed-dead writer, preserves a torn uncommitted tail, validates complete
  records, authenticates the controller before journal repair, and fences active
  execution leases. Complete-record corruption blocks recovery.
- Start returns a random main-controller capability; the journal keeps its digest.
  Node leases bind Run/node/attempt and are deterministically recoverable through
  the same claim request. Keep the controller secret outside worker prompts.
  Only the main actor may claim main nodes or explicitly accept finalization.
- Identical completion is idempotent; a different payload or stale lease fails.
  Completion evidence and reported write scope are required. Physical file
  monitoring/enforcement is the executor's job, not a claim made by the scheduler.

## Control semantics

- Conditions use ordered cases plus an explicit default. Unselected edges skip
  downstream nodes; Join waits for all branch edges to settle. The main finalizer
  remains mandatory on every successful path.
- Parallel defaults to `fail_fast`: an unhandled branch failure stops the Run and
  fences active peers. `collect` preserves failed branch results for the Join and
  main acceptance. A nested branch uses its nearest parallel region's policy.
- Pause prevents new claims/dispatches/releases; active completions are retained.
  Resume advances the same pinned graph. Restart recovery never resubmits work.
  Retry requires the pinned attempt budget and a fresh approval where required.
- Approvals bind revision, node, attempt ordinal, Provider, effective paths and
  Skill policy. Denied approval requires an explicit new request via retry.
  Human gates complete through controller approval, without a worker lease.
- Persist dispatch intent before external invocation, then record exact task
  identity. An interrupted dispatch needs evidence-backed reconciliation or
  explicit retry. Cancellation fences local leases and records pending external
  cancellation; it does not claim the remote task actually stopped.
- Inputs, node outputs and bound Workflow outputs use a finite JSON Schema
  vocabulary: type, properties, required, additionalProperties, items, enum,
  const, numeric/string/array bounds and descriptive metadata. Unsupported
  keywords fail validation. Conditions/output binding errors remain visible in
  the same transaction as the upstream completion.

Strict execution and parallel writes remain fail-closed unless a host-owned
qualified executor provides the required capability. Public input flags cannot
grant either capability. Provider/server/UI integration is the next milestone.
