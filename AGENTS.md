# Maintainer context

The shipping plugin is `plugins/sol-advisor`, manifest version `0.7.11`; the
control-plane package is `0.4.5`, configuration schema is v6. Production routing
remains Task Type -> ordered Stage -> user-pinned Provider. Consult `CONTEXT.md`
and the existing architecture/provider contracts for that runtime.

The v7 visual Workflow plan and five amendments were approved by the user on
2026-09-04. Accepted architecture is in `docs/adr/0002` through `0007` and
`docs/V7_VISUAL_WORKFLOW_EXECUTION_PLAN.md`. It is not yet shipped behavior.
`spikes/skill-isolation` is an opt-in experiment, deliberately
outside the production plugin package. It does not prove Strict isolation and
must not authorize imported workflow execution.

Use isolated branches for the v7 redesign. Preserve provider bindings, permission
checks, approval semantics, and explicit failure reporting. Do not modify real
user Codex configuration or installed skill sources for run-level experiments.
Keep accepted architecture, probe limitations, and observed test evidence current
as implementation progresses.

M2-M4 core modules now implement immutable packs, graph validation and transactional
v6 migration. Their concrete IR/storage contracts are in `docs/V7_CORE_CONTRACT.md`.
They are not wired into automatic startup migration yet. Keep the v6 public
runtime working until the remaining executor/UI integration gates pass.
M5's journal scheduler is implemented and independently tested; the Run authority,
recovery and executor boundary contract is `docs/V7_RUN_CONTRACT.md`. M6 service
and Provider integration is documented in `docs/V7_SERVICE_CONTRACT.md`. The
loader supports migrated v7; bundled config and old console stay v6 pending the
graph UI. Do not claim Strict from a caller flag or activate the old current-thread
adapter for imported workflows. M7 modules under `lib/execution` have
actual App Server request/lifecycle evidence and opt-in service integration, while
human authentication/capability UI and release remain gated. See `docs/V7_WORK_LOG.md` for current evidence
and completed synthetic live qualification. Catalog controls include the independent native
orchestrator Skills namespace; feature flags alone do not suppress it.

M8's import/compiler foundation is documented in `docs/V7_SKILL_IMPORT_CONTRACT.md`.
Configured-profile Codex discovery and selected-native-Provider expansion dispatch
are implemented. Discovery uses only metadata RPCs and never writes user config;
Codex may refresh normal caches. Expansion has its own immutable planning Pack/Run,
read-only tools, explicit main acceptance and source-revision CAS. The inferred
result remains Draft and requires per-item human review. UI integration remains.
The bundled ISC YAML parser needs no npm at runtime; build it using pinned
development dependencies and preserve its license/source manifest. Never execute
imported scripts during analysis or label resource relocation as functional proof.

The development v7 service now has an opt-in Strict session manager. Its user-owned
configuration remains default-off and only accepts the qualified Windows x64 binary
hash. It persists exact dispatch identity, metadata events and hash-pinned result
artifacts; final proposals require main acceptance. Cancel fences leases before
waiting for broker/process shutdown. Same-Run writes are serialized in-process and
still protected by the cross-process writer lock. Human login/capability UI and
release review remain pending, so do not describe the upgrade as shipped. Preserve
every failure and the limited scope of actual/local/live evidence in the work log.

M9 linked SkillRef/Inline and SubWorkflow execution are integrated in the development
service. Run start pins the entire dependency closure and checks every ancestry,
permission and executor context. Child Runs derive exact private authority, retain
main acceptance and consume only parent-pinned bytes. Do not bypass inheritance
with a library restart or direct child completion. See V7_RUN_CONTRACT and
V7_SKILL_IMPORT_CONTRACT. Inline remains Draft until exact human review. M10-M13
and all editor/authentication/release gates remain; full155 regression and actual
App Server6-case/17-request evidence are recorded in the work log.

M10 parallel dispatch now uses real detached Git worktrees, dynamic fork snapshots,
and blocked Join integration gates. Only qualified Strict writers may use this lane.
See V7_PARALLEL_CONTRACT for scope, patch review, source CAS and owned cleanup rules.
Do not equate a cooperative handoff workspace field with enforced isolation, bypass
the merge hash/acceptance gate, or remove unaccepted/changed worktrees. Full167 plus
focused follow-up tests and actual overlapping Codex request evidence are recorded;
M11-M13 remain before shipping or migration of real user configuration.

Relevant checks:

M11 adds the React/TypeScript/React Flow editor at `/workflows`, committed static
assets and exact build/license verification. Runtime needs no npm installation.
Provider UI preserves the v7 store and Strict settings; migration remains an
explicit human action. Resource edits create CAS Draft revisions and import-review
blockers. Publication reviews the exact saved revision. Graph layout is an explicit
edit; transient React Flow state never enters the IR. Full171 and first browser
save/publication/invalid-JSON checks passed. M12 recovery controls are still being
integrated; do not ship the editor before recovery and complete E2E gates pass.

```text
node plugins/sol-advisor/control-plane/test/run-tests.mjs
node --test plugins/sol-advisor/scripts/test/native-role-tools.test.mjs
node --test spikes/skill-isolation/assertions.test.mjs
node --test spikes/skill-isolation/fixture-policy.test.mjs
```

The repository also has POSIX verification scripts and existing CI checks; local
Node test success is not equivalent to a completed cross-platform release gate.
