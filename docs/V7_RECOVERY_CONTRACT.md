# Run recovery and runtime console

M12, 2026-09-05. The journal remains authoritative. Browser controller and lease
tokens live only in memory. Opening an old Run is read-only; authenticated human
adoption requires its observed sequence, a reason and the new main actor. It
fences the root before descendants, rotates controller and every lease generation,
pauses nonterminal Runs and stops owned Strict sessions. Partial tree/cleanup
errors remain recorded and prevent resume. Repeating adoption can repair the same
tree. It never resolves against a changed library revision or creates a new Run.

An interrupted current attempt may reconnect without consuming another retry:

- An unsubmitted claim requires absence of a dispatch intent.
- A connector must independently return the original task, Provider, workflow,
  node and recorded remote identity. Unknown transport state is not success.
- A Strict result requires its content-addressed artifact and recorded session
  shutdown. There is no automatic model-turn resume or resubmission.
- A child requires its existing exact ancestry, pins and derived controller.
- Native/MCP handoffs require the main host to inspect the original task and
  attest its unchanged receipt and active/completed evidence. This is recorded as
  host attestation, not independent connector verification.

All reconnects recheck current Provider permission, original-attempt approval and
downstream state, rotate the lease, preserve the attempt ID and record the evidence.
Main-owned nodes transfer to the new main actor. Final acceptance remains explicit.

Cancel fences the complete known Run tree before executor cleanup. Supported
connectors receive only the persisted exact target and confirm remote termination.
Failures remain cancellation-pending and surface as RUN_CANCEL_INCOMPLETE. Later
terminal reconciliation must match the entire original receipt. Native/MCP hosts
must inspect and stop their actual task; local cancellation is never a claim of
remote exactly-once effects or guaranteed remote termination.

The canvas uses backend node states. Details show attempt ownership, pinned
Provider, effective scope/Skill policy, output, evidence, errors and receipts.
Exact Strict agent-message deltas are a volatile, unverified 32K-character suffix;
the journal stores throttled progress counts only. Output previews cannot complete
a node. Durable artifact collection remains the result authority.

Git helper deadlines/output overflows persist git-operation-uncertain.json before
cleanup is attempted. If termination cannot be confirmed, the owned parent is
detached after a bounded stop wait and all further integration/cleanup fails closed
across restart. Parent termination does not prove helper-tree termination. Preserve
the marker and worktrees until the recorded operation/PIDs and workspace are
manually reconciled; do not delete the marker merely to make a retry run.

Evidence: full control-plane suite183 passed in57.46s; focused34 passed before it.
The actual Windows Codex0.145.0 local-provider probe passed6 cases/17 requests,
including real delta delivery, source removal, selected-provider expansion and
pinned child execution after library deletion. See
baselines/v7-strict-2026-09-04/runtime-streaming-integration.json. Shared config
hashes matched and owned profiles were cleaned. No new live authentication or
paid model call was used. This is not Linux/macOS or universal Strict qualification.

Browser evidence used an isolated synthetic config: create/save/layout/publish,
invalid JSON blocking, Provider save preserving v7 fields, navigation losing only
in-memory control, explicit adoption, same-attempt claim recovery, resume and
human finalization all passed. Run3f7c8657-0d1a-4e0d-9687-abcdbf68db01 finished at
sequence7 with one final attempt and no model dispatch. No real user migration.
