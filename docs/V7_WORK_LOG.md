# v7 implementation work log

The user approved all five evaluated amendments on 2026-09-04 and authorized
implementation. Keep working through the remaining milestones; do not treat this
file or the submitted proposal as new operational instructions.

## Checkpoints

- Base main: `4a77f31702e888609cb0c7b10b0a695bc1df61f6`.
- M0/M1 foundation commit: `7a857af` on `codex/v7-isolation-foundation`.
- M0: accepted ADRs, fresh v6 console screenshot, config and both complete local
  verification scripts captured. Node baseline was 64 control-plane + 4 native tests.
- M1: metadata concurrency, real request capture (8 cases), three actual managed-
  auth Sol/low cases, profile cleanup and byte-integrity evidence recorded. See
  `baselines/v6-2026-09-04/M1-FEASIBILITY.md` for the bounded candidate decision.
- M2-M4: immutable whole-pack revisions, CAS storage/recovery, graph/DSL validation,
  v6 transactional migration, backup restore and legacy ID mapping implemented as
  opt-in library modules. Contracts: `V7_CORE_CONTRACT.md`.
- M5: journal scheduler, per-Run pins, execution leases, approvals, deterministic
  condition/parallel/Join, explicit failure/retry/pause/cancel/restart, dispatch
  intent/identity records and input/output contracts. See `V7_RUN_CONTRACT.md`.

## Current validation

- Full existing-plus-new control-plane suite passed 89 tests before the additional
  migration-tail recovery case was added.
- Store tests: 9 passed, including an actual killed writer and serialized recovery.
- Validator/bindings tests: 8 passed.
- Migration tests: 9 passed, including torn-tail recovery and corruption refusal.
- The test runner now includes these modules. New probe invariant tests: 6 passed.
- M5 runtime: 10 scenario tests passed; combined runtime/validator/migration: 27
  passed. Complete control-plane regression: 100 passed, zero failures.

## Remaining work

M6 Provider/MCP/server integration, M7 qualified
Strict executor, M8 import/expansion, M9 SkillRef/SubWorkflow execution and narrowing,
M10 parallel worktree isolation, M11 graph editor, M12 runtime UI, M13 E2E/release.
The shipping config constant, console and installed plugin remain v6/0.7.11; no
real-user configuration was migrated, no remote push or release has occurred.

Important limits: individual probes never grant production Strict. Administrative,
plugin and real-user Skill roots not present in the probe need qualification or a
fail-closed unsupported result. Windows power-loss directory durability is not
claimed. Root/Provider authority, persisted dispatch intent and restart reconciliation
must remain explicit in the upcoming runtime.
