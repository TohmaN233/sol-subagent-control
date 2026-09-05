# v7 core implementation contract

This describes modules under development. The shipping console still uses v6;
no user configuration is migrated by importing these modules or running tests.

## Definitions and revisions

Workflow IR v1 uses `nodes` and `edges`. Edges have `id`, `source`, `target`, an
optional branch `label`, and `on: success | failure | always` (default success).
Graph execution is acyclic and deterministic. A final main-agent acceptance node
must dominate every end, and only end nodes may follow that finalizer.

`condition` nodes contain ordered `cases: [{label, when}]` and `default_label`.
The first matching case wins; exactly one corresponding edge is selected. The
finite expression format is `{op, args}` with operands `{path: JSON_POINTER}` or
`{value: JSON_LITERAL}`. Logical `and`/`or` short-circuit and require booleans;
numeric comparisons never coerce strings. No executable expression strings exist.

`parallel` names `join_id`; that `join` names `parallel_id`. Branches have distinct
labels and cannot intersect, admit foreign entry, or terminate before their Join.
Conditional paths may merge ordinarily; concurrent paths require a Join.

Input bindings use `/inputs/...` or `/nodes/<upstream-id>/output/...` JSON Pointers.
Missing required data is an error, never an empty-string fallback. Workflow output
bindings must refer to existing sources. SkillRef pins path/name/source hash/version;
SubWorkflow pins `workflow_id` and `revision_pin` and cannot be recursive.

Structural validity is separate from environmental launch readiness. Missing
Providers and mismatched capabilities invalidate a definition. A disabled existing
Provider is a launch blocker and is retained. Drafts may be incomplete; Ready
definitions must pass graph validation when stored and be revalidated at Run start.

## Pack storage

Each pack is `wf-<id>.pack` under the configured store. The prefix/suffix preserve
all existing v6 IDs on Windows, including reserved bare filenames and trailing dots.
`workflow.json` contains the current definition/resource/provenance snapshot plus
its `revision_hash`. `revisions/<hash>.json` contains the immutable whole snapshot;
`objects/<sha256>` contains resource bytes. `workflow.revision` is a monotonically
increasing display counter; the SHA-256 is the authoritative content pin.

Creates stage a whole directory and publish it under the store writer lock. Saves
write immutable objects and revisions before replacing the current document.
Every mutation of an existing pack requires the previously read revision hash.
Restoring an old revision creates a new current revision; old snapshots remain.
Deletes move packs to `.trash`; no implicit resource garbage collection runs.

Bounds: 1 MiB definition, 2 MiB combined snapshot, 8 MiB per resource, 64 MiB total
resources, 2048 files. Resource names are portable relative paths; traversal,
symlinks, case/normalization collisions and file/directory collisions are rejected.

Writer locks contain process and random owner identity. A crashed writer is not
silently replaced. Recovery requires the inspected token and a confirmed absent
process; an exclusive recovery directory serializes recovery attempts. A stale
recovery directory itself requires inspection. No timeout steals a living writer.

Files are fsynced. Directory fsync is used on supported POSIX systems. Node does
not provide the same portable directory fsync on Windows: Windows evidence covers
process-crash consistency, not a claimed power-loss durability guarantee.

## v6 migration

The migration validates v6, preserves its exact backup bytes, builds a complete
generation of packs, and switches `control-plane.json` to version 7 only after a
durable prepared journal record. A hash-chain journal records progress. Incomplete
uncommitted tails are retained in a quarantine file before repair; corrupt complete
records stop migration. A committed config with only a prepared journal record is
reconciled explicitly. The new
configuration retains the original Provider/global objects and stores the selected
generation path plus legacy ID mappings. It contains no second copy of task graphs.

Stage IDs, Provider bindings, roles, access, approvals and exact prompt-template
whitespace survive. Native advisor compatibility matches the v6 validator. Legacy
workflows remain Cooperative; Skill imports are a different, Strict-gated operation.

Legacy bounded writes use `path_scope: {binding: "run.allowed_paths"}`. Solo Tasks
had no Stage access declaration, so their main node uses
`access: {binding: "run.access"}` rather than inventing a permission. Only main
nodes may use this binding. Run launch must supply read-only or bounded-write
access; write access also requires the current Run's concrete path boundaries.

A staging failure leaves v6 selected. A complete but unpublished generation can be
verified and reused. Concurrent v6 edits abort the commit. Reruns after commit are
idempotent. Restoring the byte-exact backup requires a current-config hash and keeps
all v7 stores for recovery. Until API integration, these migration APIs are opt-in
library operations used only against disposable test configurations.
