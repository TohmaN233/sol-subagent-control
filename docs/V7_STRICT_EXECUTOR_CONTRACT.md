# Strict Codex candidate executor

The M7 engine lives under `control-plane/lib/execution`. Its Windows execution
surface has actual App Server request, process lifecycle and synthetic live model
evidence. The v7 service now integrates an opt-in session manager and executable
qualification check. Human authentication/capability UI and release review remain
pending. It cannot be enabled through a caller's `strict: true` flag.

## Execution boundary

Each node owns one temporary CODEX_HOME and one fresh environmentless thread.
The absolute Codex executable is hash pinned and rechecked before every process
launch. A public `model/list` bootstrap selects the exact configured model/effort;
the resulting controlled model catalog removes ambient tools/base instructions.
No user model cache or shared credential file is copied.

One settings object drives profile TOML and CLI overrides, including disabled
native orchestrator Skills/MCP, tools, plugins, nested agents, shell, hooks,
notifications and repository instructions. Feature flags alone do not suppress
the native Skills namespace. Thread creation validates returned instruction
sources and model identity. There is no provider/model fallback.

Discovery uses the actual temporary execution profile and workspace. Every
discovered path is disabled except immutable materializations of the node's
explicit allow set. Exact path identity defeats same-name shadowing. Explicit
Skill input is independently checked. Catalog and owned bytes are checked before
thread creation, before dispatch and after completion; a change invalidates the
node. Administrative scope is unsupported until separately qualified.

`read_allowed_skill` reads preloaded pinned text. Optional host file tools provide
bounded UTF-8 reads, narrowed CAS writes and pinned workflow resources. They deny
runtime/Git internals, ambient SKILL.md, symlinks and hard links. A durable intent
precedes a write; post-effect audit failure carries `committed: true`. The caller
must supply a live lease check and durable operation sink. General shells and
script execution are not qualified tools. Parallel writes still require M10.

These are application-level catalog/injection/tool boundaries, not an OS-level
claim that a same-user process can never read or race filesystem data. Concurrent
external workspace editors are outside the broker's CAS serialization guarantee.

## Authentication and shutdown

Supported managed ChatGPT or user-configured environment API-key login only.
`chatgptAuthTokens` is explicitly internal in this CLI's schema and is not used.
Credential storage is pinned to files inside the owned profile, which is removed
after the process closes. Transient official login URLs are human-only and never
part of a Run journal or worker response.

The session manager is shared by service instances for one config. A persisted
dispatch intent elects one sender, followed by an exact invocation receipt. Each
profile carries Run/node/attempt ownership. The host keeps controller capabilities
in memory and checks active leases and current Provider/global permissions at every
broker operation. Pause permits existing work to complete; cancel fences leases
before waiting for the broker, profile preparation and subprocess to stop. A bounded
shutdown timeout reports pending cleanup and retains ownership evidence. Orphan
cleanup only selects the exact interrupted attempt under verified process identity.

Only bounded lifecycle/operation metadata enters the Run journal. The result is a
hash-pinned durable artifact before completion. Failed result submission is visibly
collectable without another model invocation. A finalizer proposal cannot accept
itself: `collect_strict` needs explicit main-controller acceptance. Required JSON
output is parsed and schema-checked, with no prose-to-JSON fallback.

Configuration is default-off, Windows x64 and binary-hash qualified. Native agent
nodes and main proposals are supported; other Strict executor types and ambient
allowances remain blocked pending immutable SkillRef/SubWorkflow integration. No
shell/script tool is advertised. API credentials are environment names only.

The managed flow in Codex0.145.0 emits `account/login/completed` before reloading
the account manager. `waitForManagedLogin` therefore waits for the subsequent
`account/updated` with ChatGPT auth, then ordinary account checks still apply.
No sleep, assumed login flag or model-call retry substitutes for readiness.

Process ownership records bind the directly spawned PID to OS creation identity
and executable. Orphan recovery requires the original owner to be gone and the
child identity to match; a reused live PID blocks termination. Unsupported
platform inspection fails before creating a profile. Windows is tested, Linux
code is present but not qualified, and macOS is not implemented.

## Evidence and current limits

Evidence is in `baselines/v7-strict-2026-09-04`:

- `request-capture.json`: 3 scenarios, 4 serialized requests, including trusted
  malicious repository configuration. No uncontrolled namespace/tools/instructions.
- `lifecycle.json`: 7 scenarios, 10 requests, including two concurrent policies,
  catalog changes, actual broker operations, child/owner crash and orphan cleanup.
- `live-initial.json`: deny-all and explicit injection passed; the third case was
  refused before its model request because of the discovered account readiness race.
- `live-remaining.json`: controlled dynamic read passed after the event-order fix.

All live payloads were synthetic, model GPT-5.6 Sol/low. Shared config hashes match
and no profiles were retained. Each report preserves its exact source/executable
hashes and deliberately says `production_qualified: false`. An unadvertised model
tool call is rejected by App Server with an explicit tool error; it may not appear
as a host call or terminate the whole turn. Do not claim complete attempt auditing
from the host event stream.

`run-manager-qualification.mjs` additionally exercises the actual integrated Run
service with a local synthetic provider: import source path removed, pinned reads,
bounded write, five serialized requests and explicit main acceptance. This does
not represent a second live-model qualification or functional proof for arbitrary
Skills. Still required: human auth UI, capability display and release review. The
existing current-thread adapter never takes over Strict work. Restart lease
reattachment is a separate M12 gate; finding a durable artifact alone does not
revive a fenced attempt.

Official implementation reference:
[Codex0.145.0 account event ordering](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/app-server/src/request_processors/account_processor.rs)
and
[orchestrator Skill extension](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/ext/skills/src/extension.rs).
