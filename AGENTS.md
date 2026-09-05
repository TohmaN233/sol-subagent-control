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
Actual host discovery and selected-Provider expansion dispatch are still integration
work. The bundled ISC YAML parser needs no npm at runtime; build it using pinned
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

Relevant checks:

```text
node plugins/sol-advisor/control-plane/test/run-tests.mjs
node --test plugins/sol-advisor/scripts/test/native-role-tools.test.mjs
node --test spikes/skill-isolation/assertions.test.mjs
node --test spikes/skill-isolation/fixture-policy.test.mjs
```

The repository also has POSIX verification scripts and existing CI checks; local
Node test success is not equivalent to a completed cross-platform release gate.
