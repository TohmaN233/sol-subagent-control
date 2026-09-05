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
- M5 commit: `5463b61`.
- M6: Workflow MCP/HTTP service, existing Provider execution adapter, exact
  connector identity allocation/reconciliation/collection, no duplicate dispatch,
  canonical config CAS, fsynced connector/config/audit writes and surfaced audit
  failures. Contract: `V7_SERVICE_CONTRACT.md`.
- M6 commit: `8356c88`. Full suite reached108 before final collection tests;
  service9 plus real Grok-adapter fixture1 passed after those additions. The
  registered suite now contains110 tests; a full110 run has not yet been claimed.
- M7 is active, not production-qualified. Candidates under `lib/execution/`
  now include the bounded stdio client, profile/model bootstrap, exact Skill
  policy, lease-aware file/resource broker and verified orphan ownership.
  The full registered suite passed117 tests, including seven Strict/broker tests.

## Latest M7 checkpoint

- Actual request qualification9 passes three cases/four requests, including a
  trusted malicious repository config that tries to replace the model, reopen
  tools and inject developer/AGENTS instructions. Policy is generated from one
  settings object into both the profile and higher-priority CLI overrides.
- `model/list` bootstraps public model/effort metadata through a separate process
  before the controlled catalog is pinned. Shared model caches are never read.
- Official Codex source confirms empty `openai_base_url` selects the built-in
  auth-specific endpoint; forcing the API-key URL would break managed ChatGPT
  auth. Both official endpoint selection and file-only ephemeral credential
  storage are now pinned. Native orchestrator Skills/MCP are independently off.
- Lifecycle qualification3 passes seven cases/ten actual requests: catalog change
  before/during a turn, concurrent policies, actual resource/file read and write,
  unsupported tool refusal by App Server, child crash, and owner crash followed
  by verified orphan cleanup. No profiles remain. Unsupported invented model
  calls are visibly rejected to the model by App Server; they do not necessarily
  terminate the turn or appear as host tool-call events. We do not claim otherwise.
- Workspace tools have bounded UTF-8 reads, non-glob write intersections, no links
  or runtime/ambient Skill paths, CAS observations, lease checks, durable operation
  callbacks, and explicit committed=true audit failures. They are an application
  boundary, not an OS filesystem sandbox; parallel writes still need M10 worktrees.
- Process identity uses Windows Get-Process creation ticks/executable, or Linux
  /proc creation identity. WMI was unavailable in the sandbox, so the implementation
  now uses direct process inspection. No raw process command lines are collected.
  Orphan termination requires the dead original owner and matching spawned child
  identity; a reused live PID blocks cleanup. macOS is not qualified yet.
- M7 live qualification is complete for the three synthetic cases: deny-all and
  explicit passed in `../strict-live-1.json`; controlled read passed in
  `../strict-live-2.json`. Initial third case correctly refused dispatch after
  login/completed arrived before account readiness. Official source confirms the
  ordering; `codex-managed-login.mjs` now waits for the following account/updated.
  Two regression tests passed. Registered suite119; last full run117 passed.
  Both live processes26271/60804 ended; all profiles and auth tab98376809 closed.
  The user explicitly authorized current Chrome for these three official login
  flows after automatic browser approval initially rejected it. No question remains.
- Evidence copies and `docs/V7_STRICT_EXECUTOR_CONTRACT.md` preserve all results,
  including the initial auth failure. Current source manifest matches request9
  and lifecycle3; the new auth waiter has its own hash in the remaining live report.
- Production service still refuses Strict; M7 integration/capability grant remains
  outstanding. Broker shutdown must revoke/drain outstanding operations before a
  session is considered closed; do not claim it already does so.
- M8 independent work: pinned yaml2.9.0 and esbuild0.28.2 as dev dependencies,
  added lockfile/ignored node_modules, built a bundled ISC parser under lib/vendor
  so installation will not need npm. Windows esbuild needed approved execution
  outside the sandbox for ancestor-directory discovery. No install hooks ran.
  `skill-import/skill-reader.mjs` is untested partial work: bounded YAML/snapshot,
  explicit resource problems and known-credential redaction. Compiler, dependency
  analysis, relocation checks, service/UI integration and tests remain to write.

## Active M7 implementation notes

Read actual local `LoginAccountParams` schema: `chatgptAuthTokens` is explicitly
marked internal/unstable, so it must not be used. Use official managed ChatGPT
login (or user-configured environment API key through supported API-key login),
without copying shared credential files. Temporary profiles own their session;
pending login is a blocked capability shown through authenticated human UI.

The candidate client allows supported managed account methods only; no token
injection/refresh workaround. Client callbacks are async and bounded, with metadata
errors instead of raw credential-bearing server error bodies. Profile builder
requires public observed model metadata and the pinned binary hash; production
metadata bootstrap is still to implement. `codex-session.mjs` now implements
candidate managed/API-key login, one fresh environmentless thread per profile,
repeated policy checks, explicit Skill input, async dynamic reads, metadata events
and wait-for-process-close cleanup. It is not wired to production Strict yet.

The profile disables apps, browser/computer tools, hooks, plugins, nested agents,
shells and other ambient surfaces through known 0.145.0 features. Candidate fresh
threads must use `environments: []`, controlled base instructions and only a narrow
host tool broker. General shell is not a qualified initial tool. Controlled
workspace read/write tools need canonical path/symlink checks, bounded files and
Run write-scope intersection; scripts/tools remain explicit requirements until
their executor is qualified. No user config/source files are edited.

Allowed Skills are materialized from pinned bytes in the owned profile. All actual
profile-discovered paths are disabled except those snapshots. Explicit Skill input
is independently checked; owned content and catalog are revalidated before/after
thread creation/turn execution. Admin scope is explicitly unsupported until
separately qualified. The policy uses preloaded Skill text, never a model-supplied
arbitrary file read. Actual requests, rather than config or sentinel absence,
must verify that native Skills/default tools are absent or controlled.

Actual request qualification found and fixed the native `skills.list/read`
namespace: it is controlled by separate `[orchestrator.skills] enabled=false`
and `[orchestrator.mcp] enabled=false`, not the feature flags. Confirmed against
OpenAI Codex tag `rust-v0.145.0`, commit
`25af12f7e61572b0bc18ddb1008be543b91519b0`, now sparsely checked out for read-only
reference at `../codex-runtime-reference` (a sibling under work). Relevant source:
`codex-rs/core/src/config/mod.rs:3055`, config tests at9633, and
`codex-rs/app-server/src/extensions.rs:92`. That reference repo is never edited.

`spikes/strict-executor/run-qualification.mjs` passes three actual App Server
local-provider cases (deny-all, explicit Skill input, dynamic pinned read), four
serialized requests total, in the thread workspace `work/strict-qualification-5.json`.
No native Skills namespace or other uncontrolled tools remain in those requests;
shared user config hashes match. Reports1/2 retain the namespace failure;
reports3/4 exposed an overly restrictive event adapter that omitted the ordinary
`userMessage` event. No failure was counted as a pass. All profiles were cleaned.
Still `production_qualified: false`: no fresh live candidate qualification,
workspace tool broker, admin scope, orphan recovery or full session integration.

Still needed for M7: public model metadata bootstrap,
workspace/resource tool broker, orphan recovery with verified ownership, real
App Server local-provider qualification (changed catalogs, explicit injection,
concurrency, subprocess crash, real user catalog suppressed), synthetic live
confirmation as authorized, and integration/capability labels. Current production
service still rejects Strict and never reads this candidate as a capability grant.

## Current validation

- Full existing-plus-new control-plane suite passed 89 tests before the additional
  migration-tail recovery case was added.
- Store tests: 9 passed, including an actual killed writer and serialized recovery.
- Validator/bindings tests: 8 passed.
- Migration tests: 9 passed, including torn-tail recovery and corruption refusal.
- The test runner now includes these modules. New probe invariant tests: 6 passed.
- M5 runtime: 10 scenario tests passed; combined runtime/validator/migration: 27
  passed. Complete control-plane regression: 100 passed, zero failures.
- M6 full regression: 108 passed before final two collection tests; service9 and
  migrated Grok adapter/protocol-process integration1 subsequently passed.

## Remaining work

M7 qualified Strict executor, M8 import/expansion, M9 SkillRef/SubWorkflow execution and narrowing,
M10 parallel worktree isolation, M11 graph editor, M12 runtime UI, M13 E2E/release.
The bundled config and current graphless console remain v6; the loader now also
accepts migrated v7. Installed plugin remains 0.7.11; no
real-user configuration was migrated, no remote push or release has occurred.

Important limits: individual probes never grant production Strict. Administrative,
plugin and real-user Skill roots not present in the probe need qualification or a
fail-closed unsupported result. Windows power-loss directory durability is not
claimed. Root/Provider authority, persisted dispatch intent and restart reconciliation
must remain explicit throughout the runtime. M12 must add verified remote
reattachment with rotated leases (without resubmission or retry-budget charge);
current restart recovery fences leases and exposes exact identity reconciliation.
