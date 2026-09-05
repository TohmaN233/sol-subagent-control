# ADR 0006: One main acceptance authority per Run

Status: accepted by the user on 2026-09-04.

One recorded primary identity owns architecture, integration and final acceptance.
Concurrent high-capability agents are workers. Every successful graph route must
reach the designated main finalizer before a terminal success is committed.

Execution envelopes bind Run revision, node, attempt, lease, pinned executor,
inputs and effective capabilities. Evidence must match that identity. Connector
claims remain untrusted until independently verified. A missing identity,
unavailable executor or explicit mismatch blocks the node; no silent substitution.

Child workflows may narrow Skill grants and write scope or strengthen approval;
they cannot expand parent authority. Outputs have a child namespace. Tool and
human-gate nodes are explicit runtime operations, not untracked agent shortcuts.

Cooperative main nodes return an envelope for the current agent to execute.
Strict main nodes require a qualified fresh executor and the corresponding
observed identity. The UI displays actual limitations instead of implying the
runtime can intercept every action of the surrounding Codex task.
