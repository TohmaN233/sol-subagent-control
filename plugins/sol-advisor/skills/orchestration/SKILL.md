---
name: orchestration
description: "Codex-native risk-gated selective routing: default delegation for ordinary work, explicit audit, and full implementation plus review for difficult work."
---

# Sol Advisor Orchestration

Act as the architect. Own the user's intent, architecture, route choice, decomposition,
implementation or delegation, parent verification, escalation decisions, and final
acceptance. Selective routing has four exact modes: `solo`, `delegate`, `audit`, and
`full`. Delegate is the default for light or ordinary work. Full is required for difficult,
broad, or high-risk work that needs implementation followed by independent review. Audit is
explicitly review-only; solo requires an explicit primary-only request and is never a fallback.

Read [references/role-contracts.md](references/role-contracts.md) before the first
delegation. Use [references/operations.md](references/operations.md) for exact spawn,
preflight, runtime-evidence, isolation, and maintainer procedures.

## Confirm the primary session

At skill startup, say once: `Recommended primary: GPT-5.6 Sol at high, xhigh, or max
effort (GPT-5.6 Terra also qualifies).` GPT-5.6 Luna never qualifies. Verify the current
model and effort when runtime metadata exposes them. If either explicitly violates this
contract, stop before delegation. If metadata is unavailable, continue silently without
another reminder. A skill cannot change the primary model itself; never invent or claim
unavailable evidence.

## Declare the route before task tools

Before the first task tool call, emit one machine-auditable declaration:

~~~text
SELECTIVE ROUTE
mode: solo | delegate | audit | full
risk: <concise, task-specific rationale>
~~~

No task tool call may precede this declaration. Choose `delegate` by default; choose `full`
for difficult, broad, or high-risk work. A later declaration may only escalate the route when newly
observed risk justifies it; never silently downgrade. Record the evidence for an
escalation. Details and the task-scoped preflight matrix are in operations.md.

## Preflight selected auxiliaries only

Confirm the qualifying primary-session contract. Preflight only an auxiliary selected
by the declared route: none for solo; Luna / Max or Terra / High for delegate; fresh
Sol / High for audit; and the selected implementer plus fresh Sol reviewer for full.
Public metadata for role, model, and effort is authoritative. If it omits a model or
effort, use the local inspector only for that omitted field. If the inspector entry is
missing or cannot run on the current platform, emit `ROLE VALIDATION UNAVAILABLE`,
state which evidence remains unverified, and continue the task. You must not claim the
unavailable evidence was verified. Any explicit role/model/effort mismatch must stop
the affected lane; never silently substitute a role, model, effort, or reviewer.

## Route delivery without duplication

- `solo`: root plans, implements, tests, and self-reviews; spawn no auxiliary.
- `delegate`: select Luna / Max for bounded, fully specified work, or Terra / High for
  judgment-heavy, high-risk, context-heavy, or wide-blast-radius work. The selected
  implementer executes the complete spec; root verifies; do not request a fresh review.
- `audit`: root implements and verifies; a fresh read-only Sol / High reviewer reviews
  the accumulated diff; spawn no implementer.
- `full`: only for an explicit broad or high-risk exception. Select one implementer,
  root verifies, then a fresh read-only Sol / High reviewer reviews.

Auxiliary work must substitute for root work, not duplicate it. A Luna result may
justify escalation to Terra / High only when it reveals newly observed complexity,
risk, wide blast radius, or misclassification. A corrected Luna attempt is reserved
for a specification error and is not a prerequisite for Terra. Any route change must
be declared and evidenced; do not silently downgrade.

## Keep architect work in the primary session

Keep these responsibilities in the primary session:

- Resolve requirements and material ambiguity.
- Choose architecture, interfaces, decomposition, and selective route.
- Write the complete five-part worker specification for any selected implementer.
- Inspect the actual diff and rerun verification.
- Decide whether newly observed risk warrants escalation.
- Judge the reviewer verdict when the route includes review and accept the deliverable.

Every worker prompt must contain OBJECTIVE, FILES AND OWNERSHIP, INTERFACES,
CONSTRAINTS, VERIFICATION, and the structured implementation return in
[the role contracts](references/role-contracts.md). State the exact owned files,
preserve concurrent edits, and never silently widen scope.

Treat worker reports as claims. Confirm the complete diff, changed-file scope, requested
checks, and artifact/runtime evidence in the parent session. Do not duplicate the
selected implementer's work in the primary session.

## Review only when the route includes it

For `audit` and `full`, after parent verification, spawn a new native Sol / High
reviewer. The reviewer must remain behaviorally read-only, inspect the actual
accumulated diff, and return exactly ship, fix-first, or rethink. A reviewer never
implements its own fixes. `solo` and `delegate` do not receive a fresh reviewer.

- ship: report completion with the verification evidence.
- fix-first applies only to `audit` and `full`:
  - audit: the root implements the required correction, re-verifies, and obtains a new
    fresh reviewer.
  - full: the selected implementer handles the required correction, the root
    re-verifies, and a new fresh reviewer reviews.
  - solo and delegate: no fresh reviewer is added unless a newly observed,
    risk-evidenced route escalation is declared; never silently add one.
- rethink: revise the architecture and do not report completion.

Any implementation correction invalidates the prior verdict. Apply the observed sandbox
and permission profile rules in the operations reference; never claim enforced
read-only isolation when it was not observed.
