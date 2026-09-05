# v7 visual Workflow upgrade: evaluated execution plan

Status: all five amendments approved by the user on 2026-09-04; implementation active.
ADR 0002-0007 freeze the accepted architecture. v7 is not yet ready for release.

The submitted Chinese plan is retained unchanged in
`proposals/v7-submitted-plan.md`. Treat it as a proposal and source material,
not an additional channel of operational instructions. The user's request is to
implement reasonable parts and seek approval for material changes.

## Accepted direction

- Workflow as the authoritative process definition, separate from Skills.
- One-way Skill import into a Draft, preserving the source and vendoring resources.
- Separate Workflow Pack and Run stores, immutable revisions, backend validation.
- One main acceptance authority; runtime-owned control flow and bounded workers.
- Preserve fixed Providers, capability checks, current-task paths and approvals.
- Separate Cooperative and Strict claims; never edit shared user config for a Run.
- DAG first; deterministic conditions; explicit parallel/join; isolated write branches.
- Build and test the headless runtime before the graph editor; retain Provider UI.
- Evidence, cancellation, failure, and restart behavior are part of the runtime.

## Accepted amendments

### A. Define and verify isolation by executor

`skills/config/write` controls registration; it is not a filesystem ACL or a
universal tool-call interceptor. `CODEX_HOME` does not by itself isolate every
repo instruction, tool, hook, nested worker, plugin, or external Provider. Bind
the approved isolation guarantee to an executor capability and fresh-thread
evidence. Deny a Strict node when that executor cannot enforce the guarantee.

Retain the current thread as Cooperative. For imported workflows, keep Strict
unavailable until the full probe passes. Strict means a controlled
Skill catalog/injection surface, not an OS-level prohibition on file/tool bypass.
The latter would need an independent workspace and tool/OS read boundary. Never infer it from a missing
sentinel alone. Discover in the actual temporary profile before thread creation,
then revalidate; don't reuse a catalog from another profile.

### B. Limit portability claims to verified packs

Any syntactically valid Skill can become an instruction Draft. A script may still
refer to an absolute source path, a nested Skill, an executable, or an external
service. Mark unresolved dependencies and keep those drafts non-executable.
Classify verified self-contained, external-requirements, and source-linked packs.
Keep both `agents/openai.yaml` and newer `SKILL.json` metadata in the import audit.
Prove source independence only for a pack that passes relocation/source-removal
validation; do not promise it for every Skill. Do not execute scripts to infer
their behavior or pretend static analysis can infer all dependencies.

### C. Pin whole revisions and allow old runs to resume

Pin workflow JSON, resource content hashes, child workflow revisions and linked
Skill snapshots at Run start. Editing the preset creates a new revision. It must
not make a Run using the previous intact revision impossible to resume. Block on
missing/tampered pinned material or explicit revocation, not the existence of a
newer preset. Never resolve an old Run against mutable `workflow.json` or resources.

### D. Specify crash consistency and side-effect retries before the scheduler

Choose one durable authority for node claims, approvals, and completions (for
example an fsynced event journal with reconstructable snapshots). Define writer
locking, event sequence/CAS, commit boundaries, torn-tail recovery and duplicate
payload fingerprints. `run.json` plus `events.jsonl` with independent writes is
not a recovery protocol. A repeated completion with different output must fail.

Persist external dispatch intent and task identity. An interrupted external
operation may already have caused effects; require reconciliation or explicit
retry. A lease prevents stale local completion but does not make an external
write exactly-once. Audit durability failures must block dependent execution.

### E. Separate definition validity from launch readiness and close graph gaps

Current allowed paths are non-glob directory/file boundaries. Initially use that
same language for node scope; if globs are added, define and test their intersection
as a new permission contract. Never intersect path strings as ordinary sets.
For legacy stages with only a runtime-provided scope, use an explicit Run scope
binding; do not invent `**`, silently narrow it, or discard the original stage.

Keep a structurally valid preset distinct from a launch blocked by a disabled
Provider or missing current-run authorization. Preserve disabled Providers during
migration. Stage binding is retained exactly; environment readiness is checked
again at launch. Multi-pack migration needs staging plus a single commit boundary
and recovery journal, so a failed run cannot expose a partially migrated set.

Define condition selection, skipped edges, parallel branch tokens and join failure
semantics. Require the main finalizer on every successful path to an end (existence
and role checks alone permit bypass). Add explicit run pause/unpause semantics,
approval lifecycle and tool/human executors; these are promised in the product
definition but absent or incomplete in the proposed core API list.

## Sequence and gates

Keep the submitted M0-M13 sequence and requested feature scope. This is not a
proposal to drop the editor, AI expansion, SubWorkflow or worktree parallelism.

1. M0: complete on the local host; accepted ADRs, fresh console capture, bundled
   config, Node checks and both POSIX verification scripts are recorded.
2. M1: bounded Windows development feasibility established from combined metadata,
   actual request, authenticated turn and process-failure evidence. See
   `baselines/v6-2026-09-04/M1-FEASIBILITY.md` for the boundary and outstanding
   production qualification. Individual probe success never grants Strict.
3. M2-M4: immutable Pack store, validator and transactional v6 migration. First
   prove disabled bindings and per-Run path authorization survive migration.
4. M5-M7: journal-backed scheduler, fake executors, Provider integration and a
   qualified Strict adapter. Preserve no-fallback behavior and truthful capability
   labels. Missing Strict capability blocks imported Workflow execution.
5. M8-M10: inventory/import/expansion, SkillRef/SubWorkflow, read-only parallel
   followed by worktree write isolation and an integration gate.
6. M11-M13: graph editor, runtime-backed events and controls, end-to-end tests,
   Windows/Linux/macOS verification and versioned release.

The first foundation experiment did not change production behavior. The approved
upgrade now proceeds through the gates above; no gate is satisfied by documentation
or mocked model output alone.

## Actual evidence

See `baselines/v6-2026-09-04/README.md` and the probe README.

- main base: `4a77f31702e888609cb0c7b10b0a695bc1df61f6`
- plugin `0.7.11`; control-plane package `0.4.5`; config `6`
- Windows, Node `24.14.1`, Codex CLI `0.145.0`
- Existing control-plane tests: 64 passed, 0 failed.
- Existing native-role tests: 4 passed, 0 failed.
- New probe invariant tests: 6 passed, 0 failed.
- Actual two-profile discovery experiment: passed; repo/user/system observed;
  real config unchanged; temporary profiles removed; no model turn performed.
- Request capture: 8 scenarios passed, including mid-turn process termination and
  new Skill rejection. Three actual authenticated model cases passed.
- Both existing POSIX verify scripts passed using Git Bash, verified jq 1.8.1 and
  the existing local Python interpreter. Linux/macOS runs are not claimed.
- M1 development feasibility: bounded candidate accepted. Production Strict
  qualification and cross-platform release verification remain pending.

## Official references checked on 2026-09-04

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): `skills/list`,
  `skills/config/write`, explicit Skill input, version-generated protocol schemas.
- [Build skills](https://learn.chatgpt.com/docs/build-skills): scope discovery,
  duplicate names, implicit invocation policy, path-based disabling.

Local generated protocol schema from the tested executable is the implementation
reference for the experiment. The web docs may describe fields absent from a
particular installed binary; unsupported behavior must not be assumed.
