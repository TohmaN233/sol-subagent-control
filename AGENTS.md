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
They are not wired into the shipping console or automatic startup yet. Keep the
v6 public runtime working until the journal scheduler and integration gates pass.

Relevant checks:

```text
node plugins/sol-advisor/control-plane/test/run-tests.mjs
node --test plugins/sol-advisor/scripts/test/native-role-tools.test.mjs
node --test spikes/skill-isolation/assertions.test.mjs
node --test spikes/skill-isolation/fixture-policy.test.mjs
```

The repository also has POSIX verification scripts and existing CI checks; local
Node test success is not equivalent to a completed cross-platform release gate.
