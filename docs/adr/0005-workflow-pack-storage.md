# ADR 0005: Immutable Workflow Packs and durable Run journals

Status: accepted by the user on 2026-09-04.

Keep provider/global settings in control-plane.json; store Workflow Packs and Run
journals separately. The canonical revision includes the definition and a manifest
of immutable resource hashes. Pins include child workflow revisions and linked
Skill snapshots. Old Runs resume against their intact pinned revision even after
new preset revisions are saved. Missing/tampered pins or revoked authorization
block the Run. Never resolve historical runs against mutable preset resources.

Validate IDs and bounds, reject symlinks/path escape and use exclusive creation.
Store objects by content hash, stage full pack creation, and atomically advance a
revision-checked current pointer. Concurrent writes must compare the observed
revision under a lock. A failed save must preserve the preceding committed pack.
Directory scans, not an independently vulnerable index, enumerate committed packs.

The fsynced Run event journal is authoritative; run.json is a reconstructable
snapshot. Serialize writers and sequence events. Claims, approvals, completions
and dispatch intent become durable before downstream work is released. Validate
event integrity and explicitly recover a torn uncommitted tail; corruption cannot
be ignored. Repeated completion requires an identical content fingerprint.

External dispatch uses recorded intent and exact task identity. Leases fence local
completion, not remote side effects. Uncertain dispatch is reconciled or explicitly
retried, never silently resubmitted. Audit persistence errors fail the transition.

v6 migration stages every pack and commits a single migration boundary with a
backup/journal; failed staging exposes no partial migrated set. Preserve disabled
Providers, stage templates, approvals and dynamic Run path-scope binding exactly.
