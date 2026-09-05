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

## Current integration checkpoint (2026-09-05)

M8 foundation was committed as `1b29ef2`; M7 service integration as `3b471a0`.
The following M7 integration changes are implemented; historical notes below
describe earlier checkpoints only.

- v7 user configuration has an explicit, default-off `strict_executor` section.
  Unknown fields and stored credentials are rejected. Enabling requires the exact
  qualified Windows x64 Codex0.145.0 executable hash. The main proposal model stays
  within Sol/Terra high/xhigh/max; native nodes retain their pinned Provider model.
- One process-local manager per user config owns each exact Run attempt. The Run
  journal records dispatch intent before profile setup, exact invocation receipt,
  bounded lifecycle/tool metadata, result artifact hashes and shutdown state.
  Model prompts never contain controller/lease secrets. Managed login links are
  available only through the human-authenticated HTTP operation, not MCP.
- The broker revokes and drains before profile deletion. Cancel fences the Run
  first, then waits for setup/tool/process shutdown; setup that exceeds the bounded
  wait reports pending cleanup. Pause preserves already running completions.
  Orphan cleanup matches Run/node/attempt plus verified dead-owner/child identity;
  unrelated and live-owned profiles are not removed.
- Durable output artifacts precede completion. A completion-commit failure leaves
  an intact result collectable under the original lease without another model call
  or retry charge. A Strict finalizer only proposes output: main-controller explicit
  acceptance still gates success. Invalid required JSON fails instead of coercing.
- One local queue serializes journal/artifact/recovery writes for the same Run,
  including separate service/runtime instances. The OS lock still protects against
  other processes. Each failed caller receives its error; no retry hides a failure.
- Request qualification10 and lifecycle4 passed after broker shutdown changes:
  three/four and seven/ten cases/requests respectively. The full135 regression
  passed before the final orphan/setup-cancel/concurrent-journal tests. Those final
  targeted tests passed20 (manager8/runtime12); full138 regression passed with zero
  failures (61.7 seconds, session4576 completed).
- `run-manager-qualification.mjs` passed actual App Server integration with five
  serialized local-provider requests: original Skill pathname removed before Run
  creation, pinned source read, one bounded write, isolated main proposal and explicit
  final acceptance. Report2 passed; report1 preserves a fixture validation refusal
  because the selected read-only reviewer could not be granted write access. The
  fixture now selects an existing write-capable Provider. Report3 passed after
  the final journal-serialization change (session70399 completed), with no retained
  profiles and unchanged user config hashes. Evidence copies are in
  `baselines/v7-strict-2026-09-04/manager-integration.json`,
  `manager-fixture-refused.json`, `request-capture-shutdown.json`, and
  `lifecycle-shutdown.json`. This is actual executor/protocol evidence,
  not a new live-model or all-platform qualification.

M7 still needs the human authentication UI/capability display and release review.
M8 still needs actual host inventory discovery, metadata dependency interpretation,
review controls and selected-Provider expansion dispatch. M9-M13 remain. No real
user config was migrated/enabled, no installed plugin changed, and no push/release
has occurred. Do not treat this checkpoint as the completed upgrade.

## M8 service integration (2026-09-05, committed 21c6781)

- Parsed declared openai.yaml/Skill frontmatter/SKILL.json dependencies into exact
  tool/MCP/executable/environment requirements; commands and optional malformed or
  unsupported metadata stay visible and blocked. Provider declarations never
  choose an executor. Fixed static path detection that had mistaken https:// for
  a Windows drive path. No imported scripts or connections are executed.
- Human-only import review records exact observation/inferred-item identity,
  reason, source revision and history. Requirements are preserved; every inferred
  node/edge has an independent launch blocker until reviewed. Review stays Draft.
- Managed AI expansion uses an internal immutable planning Pack and ordinary
  read-only Strict Run. The selected native Provider is retained, main acceptance
  gates application, and source-revision CAS prevents stale overwrite. The source
  execution Provider and Strict policy stay intact; graph output remains unreviewed
  Draft. Non-native planning executors currently report unsupported explicitly.
- Default Skill inventory now uses qualified actual Codex initialize/skills/list
  against configured CODEX_HOME/workspace, with no thread/turn/login or config write.
  Codex may refresh its own metadata/system caches. This scope is explicitly the
  configured profile, not every possible desktop/environment Skill. Per-path errors
  remain visible and concurrent config edits cause integrity failure, never rollback.
- Targeted import12/manager9 tests passed. Actual expansion integration report1
  passed three cases/nine serialized requests with source removal and preserved
  Provider binding. Expanded report2 passed four cases/nine requests, adding actual
  synthetic-profile inventory (nine discovered entries) and additional implementation
  hashes; session6482 completed with unchanged config and no retained profiles.
  Evidence: `baselines/v7-strict-2026-09-04/inventory-expansion-integration.json`.
  Full144 regression passed, zero failures, 55.6 seconds; session62946 completed.
  Neither run uses live credentials or migrates real user config.
- Remaining: UI integration/source editing/publication, M9-M13. No release or push.

## M9 integration checkpoint (2026-09-05)

M9 implementation commit: `0a206a6`.

- New Runs resolve whole transitive child Packs/resources, Provider identities and
  Skill snapshots before publication. Source name/hash/version, complete resource
  bytes and every ancestry context are checked. Reused children cannot hide a
  recursive Workflow identity through another revision. Three pin tests passed.
- Linked SkillRef dispatch materializes only this node's Run-pinned allowances.
  The qualified session independently gates explicit Skill input and exposes exact
  pinned references through its broker. Removing the original after Run start does
  not change execution; a new Run with a missing or stale source fails.
- Inline converts a selected SkillRef and explicit nested Skills to an editable
  agent node with copied resources and a resource map. It preserves Provider,
  access, scope and approval; source paths are shadowed. The result is Draft and
  has an independent per-node review blocker, even if its summary is removed.
  Review never claims functional portability or clears executor requirements.
- SubWorkflow has a dedicated executor and deterministic child Run identity.
  Parent intent precedes child creation; a crash after child publication reopens
  that exact journal. Children use only parent Run objects, including after library
  deletion. Main authority is derived privately and never appears in model prompts.
- Child paths intersect the parent node's permissions; inherited approval cannot
  be removed. Skill ceilings also cover explicit linked injections. Every depth
  is preflighted, including unsupported parallel writes inside children. Output
  bindings read only the child's output namespace. Collection requires its main-
  accepted successful Run and commits child journal/hash and scope evidence.
- Parent pause blocks child claims/dispatch while active completion is retained.
  Ancestor checks fence child authorization after cancellation/interruption/failure.
  Service cancellation journals the tree before stopping exact local sessions;
  unreadable child journals produce errors while other known sessions still stop.
- Full regression passed155 tests (49.9 seconds, session18555 completed). The final
  idempotence/cancellation/policy refinements passed25 targeted tests afterward.
  A final three-generation cancellation/corruption test brings the registered
  count to156; the six SubWorkflow tests passed after that addition.
- Actual App Server report `baselines/v7-strict-2026-09-04/skillref-subworkflow-integration.json`
  passed6 cases/17 serialized local-provider requests, including deleted linked
  source execution, deleted child Pack execution and parent namespaced acceptance.
  Shared configuration hashes match and temporary profiles are removed. The report
  preserves the source hashes observed before the final metadata/error refinements;
  it does not claim a live-model semantic or cross-platform release qualification.
- Remaining: M10 worktrees/integration, M11 editor, M12 runtime UI and exact remote
  reattachment without retry charge, M13 end-to-end/release. The application broker
  is not an OS filesystem isolation boundary. No real user configuration changed.

## M10 integration checkpoint (2026-09-05)

- `lib/parallel` now implements graph-region planning, actual detached worktree
  ownership, bounded Git operations, fork snapshots after prior serial writes,
  nested workspace inheritance, durable provisioning, merge artifacts and cleanup.
- Parallel writes require qualified Strict execution. A cooperative handoff cannot
  claim enforcement merely because its packet names another directory. Read-only
  parallelism remains available without a Git requirement. Worktrees never enable
  a disabled Provider or grant additional Run paths.
- Clean-source preflight rejects untracked edits, custom checkout/merge drivers,
  config includes, links/submodules and unsupported paths. Existing ignored caches
  are not copied. Newly created ignored branch files remain visible to scope checks;
  known ignored outputs from preceding nodes/integrations are included in fork data.
- Every writing region assigns an independent worktree to each sibling branch.
  Sequential nodes in a branch share their branch results; nested forks snapshot
  that enclosing workspace. Overlap is reported and only accepted behind this
  worktree isolation and integration gate. Failed branches cannot pass write Join.
- Join blocks until the controller reviews a durable exact patch/hash. Conflict,
  outside paths or concurrent target changes stop integration. Applying retains
  the user's branch HEAD and index. A journaled apply intent can reconcile an exact
  already-applied result without applying twice; partial/other trees remain errors.
- Terminal cleanup requires accepted unchanged snapshots and confirmed executor
  completion. Exact ownership intent precedes removal; retry reconciles a completed
  deletion. Unaccepted/changed branches remain available. Errors are journaled even
  when a provisioning, merge or cleanup call fails; audit failures are surfaced too.
- Full regression passed167 tests (59.5 seconds, session18359). Final ancestry
  checks and Strict-only write qualification passed Git4, planner3 and focused
  runtime1 tests afterward; the registered total is now168.
- Actual App Server/local-provider report `baselines/v7-strict-2026-09-04/parallel-integration.json`
  passed2 cases/14 requests: overlapping read-only turns and overlapping isolated
  writes plus reviewed integration/cleanup. Request barriers observed arrival gaps
  of215/225ms. Source HEAD/index and shared config hashes stayed unchanged; owned
  model profiles were cleaned. It preserves source hashes before the final
  ancestry/Strict-only gate refinements and is not a cross-platform release claim.
- Remaining: M11 editor/authentication/publication, M12 runtime UI/remote lease
  reattachment and broader interrupted-helper recovery, M13 E2E/release. Git calls
  have bounded deadlines but do not claim OS isolation or tree-wide helper process
  termination after every possible timeout. Uncertain worktrees remain inspectable.

## M7 engine checkpoint (243208c; historical)

M7 engine/evidence checkpoint committed as `243208c`. Production wiring remains
pending; it is not a release or the completed M7 gate.

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
  Import modules now include reader, static dependency observations, exact host
  inventory selections, coarse compiler/resource relocation and constrained AI
  expansion compiler. Seven import tests plus one service integration test passed.
  Service/MCP operations expose inventory/import/relocation and expansion packets/
  application. Packets explicitly say invoked:false; actual model dispatch is pending.
  The last full suite passed127 tests (zero failures), including the two managed
  login event-order tests. This supersedes earlier full117/registered119 notes.
  Contract: `docs/V7_SKILL_IMPORT_CONTRACT.md`.
  Still needed: production inventory adapter, metadata dependency interpretation,
  requirement/inference review controls, actual selected-Provider expansion dispatch
  and resource capability validation. Static relocation is pinned-resource access
  evidence only, not proof of functional execution. No real user Skill was imported.

## Historical M7 implementation notes (superseded by checkpoints above)

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

## Earlier validation history

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

M11 checkpoint (2026-09-05): React19.2.8/TypeScript5.9.3/React Flow12.11.6
editor source and bundled static assets added. Build uses esbuild0.28.2 and emits
all bundled package licenses; CI compares exact generated assets without runtime
npm. Windows sandbox blocked esbuild ancestor-directory reads; the same bounded
build passed with the reviewed escalation. Type checking passed. Full control-plane
regression passed171 tests (58.55s, session63128). Three editor tests cover CAS
resource history/binary retention/dangling publication, opaque graph metadata and
static HTTP/CSP boundaries. An independent synthetic configuration in work/editor-fixture
passed browser new-Draft/save/layout/Ready/invalid-JSON checks. The original config
and three completed official-login tests were untouched. No release or installation.
Run controls, exact reattachment/controller recovery, fuller browser verification,
cross-platform qualification and release remain M12/M13 work.

M7 human authentication/capability UI, M8/M9 import/reference/expansion editor integration,
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

## M12 checkpoint (2026-09-05)

Run recovery, effective node details, bounded volatile output and exact cancellation
are implemented; see V7_RECOVERY_CONTRACT.md for contracts, limits and evidence.
Full183 passed, zero failures (57.46s). Actual App Server6 cases/17 requests passed
with shared config unchanged and owned profiles cleaned. A preview test initially
asserted against the sanitized event endpoint; corrected it to inspect the actual
journal and fixed fixture shutdown ordering so assertion failures cannot hang.
Malformed Draft canvas now reports errors and preserves IR for repair. M13 continues.


## M13 candidate checkpoint (2026-09-05)

Version0.8.0 / control-plane0.5.0 prepared. Workflow is the default console entry;
new installations explicitly migrate the retained v6 seed. Skill instructions now
route v7 through journaled Workflow tools and retain the v6 contract separately.
Added source update observations, attempt elapsed timestamps, main import binding,
current-permission rechecks on connector input/recovery, and Draft-only MCP edits.
Ready publication cannot be reached through model create/save tools.

Both POSIX scripts passed under reviewed Windows Git Bash execution. The control
script included185 passing tests in47.06s; native role checks passed4. An earlier
run exposed stale version/skill text assertions, corrected to validate v7 plus its
v6 reference. The migrated E2E initially compared a transient idempotent response
flag with persisted state; corrected that distinction and both presets passed.
Final service16 passed after the model-publication gate; typecheck/build comparison
and plugin/skill validation passed. Remote three-platform CI remains to observe.


First real PR CI (33953220452, head7850a7c): Linux core and web passed;
Windows exposed8.3-vs-long-path comparisons in Git roots and broker deny paths.
macOS temp fixtures inherited /var's system symlink and correctly hit the no-link
boundary. Fixed physical path identity after link rejection, retained explicit
root checks/diagnostics, and gave fixtures canonical temporary roots. Added two
Windows environment-alias regressions. Platform-independent catalog tests now use
static catalog fixtures; actual unsupported macOS ownership is asserted to refuse
profile startup and retain orphan state. No Strict qualification was extended.
Focused broker/Git/runtime17 and Strict manager/catalog18 passed locally.

Second PR CI33953652173 passed Windows/Linux core, web and all isolation jobs.
macOS exposed two Cursor runtime scope-stop failures. A deterministic late-write
fixture reproduced the same TIMEOUT_UNCONFIRMED locally: the watcher clicked Stop
and persisted cancelling, but no code confirmed its terminal state. Manual and
runtime cancellation now share exact-identity, two-observation confirmation;
pre-binding watcher events wait for durable identity, and late events can verify
an already completed reply. Lost identity retains needs_attention and scope evidence.
The new reproduction failed before the fix and passed after it; the negative
identity-loss case also passed. Fifteen focused Cursor scenarios passed locally.

After the physical path fix, actual Windows Codex manager6/17 and parallel2/14
qualification probes passed again with zero errors, empty retained-profile lists
and unchanged shared config hashes. Reports release-path-manager.json and
release-path-parallel.json record exact source and executable hashes. These use
local synthetic model responses and do not repeat the three official-login cases.

Third PR CI33954142382 passed all8 jobs on commit0d3e825: Windows189 core,
Linux/macOS187 core plus2 Windows-only skips each, native4 on all three platforms,
three isolation jobs, web and full Ubuntu repository verification. Final local
POSIX verification passed189 core in46.55s and4 native. Added terminal-state guards
against late cancellation errors after concurrent cleanup; focused3 passed.
Browser source update showed exact before/after hashes without changing r1 Draft,
with no warnings/errors. Source tree and packaged deliverables are prepared for
maintainer review; no main merge, release publication, installed update or real
configuration migration has been performed.

