# v7 Run runtime contract

M5 implements the headless journal scheduler. Public operations in
`workflow-runtime.mjs` cover start/get/next/claim/complete/fail/retry/pause/resume/
cancel/approve, dispatch intent/receipt, and metadata event cursors.

## Commit and authority

- A Run owns a copy of its entire current pack and content-addressed resources.
  Preset edits/deletion do not change existing Runs. Every read verifies pins,
  resource bytes and the event chain. The transitive child/Skill closure is pinned
  before publication and existing Runs never reread linked sources or library heads.
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
grant either capability. Native Strict/Provider service integration exists; the
editor, runtime UI and release gates remain.

## SubWorkflow Runs

SubWorkflow nodes declare `executor.kind: subworkflow`, explicit access/approval/
retry, node `input_bindings`, and `subworkflow` containing `workflow_id`, exact
`revision_pin`, and `output_bindings`. Output pointers start at `/output`; the
mapped result belongs to `/nodes/<parent-node>/output`. Required child input names
are checked structurally and actual bound values are validated before creation.

`dispatch` records `child_intent` with a deterministic Run ID before creating the
child from the parent Run's objects. `child_started` acknowledges that exact ID.
An interrupted create is reopened under matching pins, inputs, permissions and
authority; corruption is never replaced. The child controller capability is an
HMAC of parent authority and exact parent attempt, returned only to the controller.
The main actor is inherited. Repeated acknowledged dispatch does not create a Run.

Paths intersect at every boundary, read-only cannot acquire writes, parent approval
remains required inside the child, and Skill policy can only narrow. Explicit child
SkillRef injections must fit the parent Skill allowance too. Unsupported nested
executors/parallel writes fail during whole-closure preflight.

Child claims/dispatches check all active parent attempts and Run states. Parent
pause permits existing completions but blocks new child work; cancellation and
failed/interrupted ancestors revoke authorization. Service cancellation journals
known descendants and stops their local sessions, surfacing every failure. A
previous nonterminal child blocks retry. Active remote reattachment after restart
is still the M12 gate; it is not equivalent to reopening an intact child directory.

`collect_subworkflow` accepts only the exact main-accepted child output. Direct
`complete_node` cannot forge a child result. The parent completion includes the
child journal sequence/hash, pins hash and aggregate changed/outside paths, checked
again against the parent node scope. Failed/cancelled children propagate an explicit
failure when collected; observations never automatically charge a retry.
