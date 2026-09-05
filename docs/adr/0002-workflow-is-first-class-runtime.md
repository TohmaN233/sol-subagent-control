# ADR 0002: Workflow is the process authority

Status: accepted by the user on 2026-09-04, including the five reviewed amendments.

Workflow IR is the single process definition. Drafts may contain unresolved
references or inferred structure. Ready means structurally validated; launch
readiness separately checks current capabilities, authorization and dependencies.

The headless runtime owns READY transitions, claims, approvals, completion and
failure propagation. Agents execute an immutable envelope and report evidence.
They cannot change the graph or replace a pinned Provider. Graph edits affect new
Runs only. Every successful terminal path must pass the main finalizer.

v1 supports an acyclic graph, finite condition DSL and JSON Pointer bindings.
Condition selection, skip propagation, structured parallel/join tokens and pause
semantics must be explicit and deterministic. No arbitrary evaluation, cycles,
dynamic graph mutation, or separate agent-group execution semantics are permitted.

The editor serializes the same IR and uses the backend validator. A UI color or
optimistic local state is never execution evidence. Existing Provider policy and
approval gates remain authoritative when invoked through the new runtime.

Consequences: build and test the runtime before the visual editor. Do not claim
enforcement over tools/providers that are outside the runtime's authority.
