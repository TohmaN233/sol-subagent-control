# Sol Subagent Control

Version0.8.0 uses configuration v7 after explicit transactional migration. A
Workflow is an immutable graph definition plus pinned resources; a Run owns its
journal, attempts, approvals, whole dependency closure and final acceptance. Nodes
bind main, a fixed Provider, a bounded tool/human gate or an exact SubWorkflow.
Draft is editable and non-executable; Ready is structurally reviewed, while current
capabilities and permissions are checked again at launch. Strict means qualified
catalog/explicit-injection/broker control, never an OS ACL. Recovery reconnects
exact identities, never latest or automatically resubmitted tasks.

Read docs/V7_UPGRADE.md and the V7_*_CONTRACT documents for current definitions.
The language below is retained only for v6 compatibility and the native-only skill.

This context defines the control-plane language used to bind reusable work semantics to concrete auxiliary execution backends without giving Sol provider-selection authority.

## Language

**Task Type**:
A user-defined, reusable workflow that describes what kind of work may be performed and which ordered stages it contains.
_Avoid_: Scenario, model task, provider task

**Stage**:
One ordered implementer or reviewer lane inside a Task Type, with its own access policy, approval policy, prompt template, and exactly one user-pinned Provider.
_Avoid_: Candidate, fallback, model choice

**Provider**:
A configured execution backend whose adapter owns transport details, capabilities, and provider-specific safety constraints.
_Avoid_: Task type, scenario

**Route**:
The workflow label derived from a Task Type's ordered Stages: `solo`, `delegate`, `audit`, or `full`. It is not an independently editable configuration field.

**Control Plane**:
The policy boundary that exposes sanitized metadata, resolves one Task Type, and enforces its pinned Stage-to-Provider bindings.
