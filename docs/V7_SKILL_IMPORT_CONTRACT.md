# Skill import and expansion foundation

The service exposes `skill_inventory`, `import_skill`, `verify_relocation`,
`prepare_expansion` and `apply_expansion`, also registered as Workflow MCP tools.
An actual host discovery adapter is required. Missing discovery is reported
explicitly rather than approximated by a filesystem scan.

Inventory selection is an exact canonical path plus source hash. Import refreshes
that selection, reads bounded UTF-8 instructions and snapshots portable resources.
The parser supports real YAML1.2, quoted/folded values and bounded aliases; invalid
or duplicate metadata fails visibly. The bundled yaml2.9.0 parser is ISC licensed
and has no runtime npm requirement. Its reproducible build uses pinned development
dependencies and `scripts/vendor-yaml.mjs`.

Coarse import invokes no model or script. It produces a Strict Draft containing
Start, one instruction Provider, main final acceptance and End. The complete
Skill text is a pinned resource, so arbitrary source text is not interpreted as
the control plane's template syntax. Provider identity/role remain user-selected.
`agents/openai.yaml` and `SKILL.json` are retained with hashes in provenance.

Unsafe/link/special/oversized resources, source-linked paths, scripts, binary
assets and unresolved references are explicit observations. Known credential
files are excluded; recognized credential values are replaced with clearly
identified requirement markers. These changes block launch and do not alter the
source. Screening cannot prove arbitrary files contain no secrets. Do not present
a redacted or partial snapshot as a runnable faithful replacement.

The resource-relocation check reads immutable Pack bytes after the original
source is unavailable. Its scope is `pinned_resource_access`, with
`functional_execution_proven: false`. It does not claim static analysis can
understand every script or that every imported Workflow will execute successfully.
`self_contained_candidate`, `external_requirements` and `source_linked` remain
distinct classifications.

Expansion preparation binds a user-selected enabled Provider and read-only
access. It returns `invoked: false` and an explicit handoff packet. Current code
does not claim to have called a model. The eventual dispatch must use the normal
durable executor/approval path, not an unaudited direct retry loop.

An expansion result must match the exact coarse revision. The compiler accepts
a finite graph proposal with confidence and valid pinned source spans. It rejects
Provider, write, approval or finalizer authority changes, validates the whole graph
and saves only another Draft under CAS. Invalid proposals leave the coarse head
and its immutable resources intact. Inferred items remain unreviewed and block
launch until explicitly resolved in the editor.

Remaining integration: production host inventory, full metadata/dependency
interpretation and requirement resolution, actual selected-Provider expansion
dispatch, resource capability checks, publish/review controls and graph UI. Tests
prove deterministic snapshots, resource relocation, observed dependency blockers,
no script execution, source preservation, stale-selection refusal and expansion
authority/CAS behavior. They do not substitute for M13 functional end-to-end import
execution.
