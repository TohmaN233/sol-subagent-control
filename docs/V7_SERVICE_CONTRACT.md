# v7 service and Provider integration

M6 exposes Workflow management and Run operations through `workflow-service.mjs`,
MCP `workflow_*` tools, and authenticated `POST /api/workflow/<operation>` routes.
The existing user-owned Provider configuration and adapters remain authoritative.
Migration/backup restoration are console operations, not model-callable MCP tools.
The v7 graph/runtime UI and shipping routing Skills are still upcoming; the default
configuration remains v6 until that release gate passes.

## Execution

- Claims, compiled prompts, permissions and Provider identity are reconstructed
  from Run pins. Caller-supplied envelope/Provider objects cannot override them.
- Current global/environment disable switches, Provider enablement and capability
  revocation are checked before dispatch. Increasing a Provider's approval policy
  blocks an older unapproved pin. There is no alternate Provider selection.
- Each node receives explicit bound inputs plus committed upstream results. The
  main finalizer sees the actual prior results before accepting the Run.
- Main/native/MCP/review nodes return a host handoff with a narrow node lease.
  The controller capability is omitted. The host records the exact external task
  identity. Provider completions without a recorded dispatch receipt are rejected.
- Direct API nodes remain text-only and advisory, with the existing global switch
  and environment authentication. Successful results/response identity become
  committed node output; repeated dispatch cannot issue another API call.
- A durable intent elects one local sender. Concurrent/repeated requests with an
  intent but no receipt fail with `DISPATCH_UNCERTAIN`. Exceptions during external
  invocation persist a redacted failure while preserving that intent.
- Connector task IDs are preallocated from the unique attempt ID. A crash between
  connector creation and Run receipt can therefore recover the exact task, without
  looking up the latest session or resubmitting. `collect_connector` accepts only
  an exact node match with terminal and compliant workspace observation evidence.
- Connector task snapshots now fsync before rename. A failed persistence poisons
  the in-memory store; subsequent operations require restart/reconciliation.
  Duplicate task IDs cannot overwrite prior records. Multi-process connector
  ownership remains an executor limitation; Run dispatch intent does not promise
  exactly-once remote effects.

## Configuration and audit

The loader accepts existing v6 and migrated v7. Transactional migration remains
explicit during development. Ordinary config saves cannot replace a v7 store
pointer or legacy mapping, or bypass migration/restore to change versions. CAS
uses canonical content, so JSON key order cannot cause false conflicts. Config
saves and audit append use the config-directory writer lock and durable writes.

Audit errors are surfaced. Post-effect audit failures report `committed: true`,
so callers do not mistake an already-applied action for a safe retry. Run cache
failure retains the same explicit commit reporting through HTTP and MCP.

## Remaining executor gates

Strict dispatch is unavailable in the Cooperative adapter. Qualified Strict,
SkillRef/SubWorkflow inheritance, worktree parallel writes, graph UI, and recovery
reattachment UI are later milestones. After restart, active leases are fenced;
reconciliation currently exposes exact external state. Verified reattachment
with a rotated lease (without a new remote submission or retry-budget charge)
must be added before claiming complete recovery for still-running remote tasks.

Validation: full regression reached 108 passing tests before the two final
collection tests were added. Service tests now pass 9 cases, including concurrent
dispatch election and audit failure. The migrated Workflow also passed a real
Grok adapter/protocol-process fixture with observed workspace scope. This is
connector integration evidence, not a live model test or Strict qualification.
