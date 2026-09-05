# Skill import and expansion foundation

The service exposes inventory/import, resource relocation, review packets,
expansion packets and managed expansion Runs as Workflow MCP tools. The default
inventory adapter runs the qualified Codex binary against the configured CODEX_HOME
and requested workspace, using only initialize and skills/list. It starts no
thread/turn/login and writes no configuration. Codex may refresh its own metadata
or system caches; this is a normal profile inventory, not a Strict execution
profile. Discovery is complete only relative to this configured profile and the
errors returned by Codex, not every possible desktop task/environment. Binary
settings are required even when Strict execution remains disabled. Configuration
hashes before/after must match; concurrent edits are reported and never reverted.
Per-path errors remain visible; the adapter never guesses filesystem roots.

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
Declared MCP tools, executables, environment names and allowed tools become
requirements. Commands/transports/endpoints require explicit review, and no
connection or Provider is automatically registered. Unsupported/malformed optional
metadata remains a visible Draft blocker. The supported openai.yaml dependency
shape was checked against Codex0.145.0 core-skills/loader.rs. Generic SKILL.json
extensions outside the finite supported shape require review rather than silently
implying portability.

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
access. `prepare_expansion` still returns `invoked: false` and an explicit handoff
packet. `create_expansion_run` now creates a separate immutable, read-only planning
Pack under workflow-expansion-jobs and a normal journal Run. Native Provider
execution uses the qualified Strict manager, normal claims/approval gates, exact
dispatch receipts and durable output. Unqualified Provider types fail explicitly.
The main controller must accept the planning result before apply_expansion_result
changes the source Draft under its original revision CAS. The planning Provider
never replaces the source Workflow's execution Provider. No retry loop, imported
script or original source path is used by this planning Run.

An expansion result must match the exact coarse revision. The compiler accepts
a finite graph proposal with confidence and valid pinned source spans. It rejects
Provider, write, approval or finalizer authority changes, validates the whole graph
and saves only another Draft under CAS. Invalid proposals leave the coarse head
and its immutable resources intact. Inferred items remain unreviewed and block
launch until explicitly resolved in the editor. The human-only review_import
operation records a reason against each exact dependency observation or inferred
node/edge. Blanket clearing of the inference summary does not clear per-item
blockers. Review creates another Draft, retains requirements and full review history,
and never automatically publishes Ready or claims functional independence.

Remaining integration: graph UI, source/requirement editing and publication, plus
broader executor capabilities. Tests
prove deterministic snapshots, resource relocation, observed dependency blockers,
no script execution, source preservation, stale-selection refusal and expansion
authority/CAS behavior. Actual App Server/local-provider integration additionally
verifies a source-removed synthetic import and selected-Provider expansion. This is
not proof of arbitrary Skill portability or live-model semantic graph quality;
M13 UI/end-to-end and cross-platform release gates remain.

Linked SkillRef nodes now require Strict mode and explicit path/name/source hash,
optional expected version and a flat `allowed_nested_skills` descriptor array.
Run creation snapshots all linked bytes and verifies the entire closure before
publication. Dispatch materializes only per-node allowed snapshots; normal resource
reads never return to the original source. The new Run checks still detect stale,
missing, partial, shadowed or unresolved linked sources.

`inline_skill` saves a new Draft under source revision CAS. It copies root/nested
Skill bytes into `inline/<node>/`, supplies a pinned resource map and converts the
node to editable instructions without changing Provider/access/approval/scope.
An original-source shadow prevents accidental ambient reuse. Requirements and
dependency observations remain visible. The human-only `review_import` operation
must confirm the exact conversion; a separate per-node blocker prevents blanket
summary removal from bypassing review. Functional independence still needs actual
execution evidence. SubWorkflow authority and output rules are in V7_RUN_CONTRACT.
