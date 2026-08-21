---
name: sol-control-plane
description: "Keep one qualifying primary architect in charge while a user-owned scenario selects a native role, built-in Cursor/Grok connector, or opt-in external provider. All non-native lanes fail closed and are never auto-enabled."
---

# Sol Subagent Control Plane

Act as the primary architect. Keep requirements, architecture, route selection, scope,
verification, escalation, and final acceptance in the qualifying root session. A
connector transports one bounded task; it does not become the task owner.

Read [references/architecture.md](references/architecture.md) for the trust boundary and
[references/provider-contracts.md](references/provider-contracts.md) before executing a
non-native provider.

## Confirm the primary session

GPT-5.6 Sol is the default. GPT-5.6 Terra also qualifies. GPT-5.6 Luna never qualifies.
The reasoning effort must be high, xhigh, or max. Verify public runtime metadata when available;
never invent model or effort evidence. A proven mismatch stops the controlled route.

## Read metadata, not the prompt library

Before repository/task tools, call `sol_control_status` at most once. It returns only
sanitized provider/scenario metadata, mappings, capabilities, approval flags, and
revision fingerprints. It omits prompt templates, endpoints, credential-variable
names, and console tokens.

Do not open, grep, print, or rewrite the user configuration file. Only the human-owned
loopback console may create, enable, disable, remap, or delete providers and scenarios.
Never auto-enable an external provider or built-in connector, never infer that an
installed paid model should be called, and never bypass `SOL_CONTROL_DISABLED`.

If status is unavailable, disabled, invalid, or inconsistent, use the native
`$sol-advisor:orchestration` workflow or stay solo. Do not silently substitute another
model.

## Declare one selective route

After sanitized preflight and before repository/task tools, emit:

~~~text
SELECTIVE ROUTE
mode: solo | delegate | audit | full
scenario: <enabled scenario id or none>
provider: <mapped provider id or none>
risk: <concise task-specific reason>
~~~

Solo is the default. One auxiliary is the default maximum. `full` is an explicit broad
or high-risk exception and resolves implementation/review stages sequentially. A later
declaration may only escalate on newly observed evidence. Never silently downgrade or
remap the provider.

Choose only an enabled scenario whose public description matches the task. A user
mapping is policy: do not replace it because another model seems stronger, cheaper,
or more familiar. If the selected provider cannot satisfy its contract, fail that lane
and make an explicit new route decision.

## Resolve or start exactly one selected scenario

For native, external-MCP, packet-review, or direct-API providers, call
`sol_control_resolve` once for the selected stage. Supply the observable objective,
minimum sufficient context, fixed constraints, and concrete verification.

For a built-in connector, call `sol_connector_start`; it resolves and delivers the
selected prompt internally. Supply:

- `scenario_id`, task/context/constraints/verification;
- the absolute Git repository root as `workspace`;
- `user_approved=true` only after explicit approval in the current task;
- no `allowed_paths` for read-only work;
- a non-empty, smallest practical, workspace-relative `allowed_paths` list for writes.

Write access opens only when all three facts are true:

1. `provider.capabilities.write=true`;
2. `scenario.read_only=false`;
3. the user explicitly approved this current task.

Missing approval, missing write capability, read-only/write mismatch, empty paths,
globs, absolute paths, `..`, or symlink escape must fail before the submodel receives
the task.

## Unified built-in connector contract

Use only:

- `sol_connector_probe` — transport/configuration probe; it sends no task;
- `sol_connector_start` — starts one exact task and returns identity;
- `sol_connector_status` — reads one exact `task_id`, with bounded wait;
- `sol_connector_control` — `reconcile`, exact cancellation, permission/input response,
  disconnect, or explicitly acknowledged abandon.

Common states are `starting`, `running`, `needs_permission`, `needs_input`,
`cancelling`, `completed`, `failed`, `cancelled`, `scope_violation`,
`needs_attention`, `unknown_after_restart`, and `abandoned`.

Timeout, process exit, or lost transport is never completion and never authorizes an
automatic resubmission. `unknown_after_restart` keeps the workspace reserved. First use
`reconcile` with the persisted remote identity; use `abandon` only after explicit risk
acknowledgement. Child-model text is an implementation claim, not acceptance evidence.

## Built-in Cursor connector

Expected connector: `cursor_cdp`, transport `cdp_ui`.

The connector attaches to a verified loopback Cursor CDP endpoint or launches Cursor
with a loopback debugging port when Cursor is closed. If Cursor is already running
without CDP, it refuses to force-close the application. It binds the exact repository
workspace, creates one fresh Agent, and returns `task_id`, `agent_id`, and `target_id`.

The connector supports one pinned Agents UI profile. Missing selectors, multiple
matching workspaces/pages, multiple new Agent identities, or an identity mismatch fail
closed. It binds the exact history/composer identity where history is available and the
exact post-submission composer ID on Cursor 3.16's Agents panel. Status comes from that
exact Agent plus stable reply/composer or history evidence, not an unrelated visible
chat. Cancellation requires `expected_agent_id` and confirms a stable stopped state for
that exact composer.

Cursor exposes no reliable host permission callback in this transport. Therefore the
available pre-execution controls are exact workspace binding, validated path policy,
one active task per workspace, an explicit boundary embedded in the delivered
prompt, and a recursive runtime workspace monitor that requests an exact Agent stop
when an outside write is observed. The mandatory final scope check compares changed
content plus Git HEAD, refs, semantic index, local config, and reflog; Git-ignored
writes, staging, commits, or other outside changes produce `scope_violation` evidence.

## Built-in Grok connector

Expected connector: `grok_acp`, transport `leader_acp_stdio`.

The connector starts a dedicated Grok Leader and an ACP stdio child, then preserves
`task_id`, `session_id`, and `run_id`. It uses `session/new` for a new task and
`session/load` only to reconcile the exact persisted session. It surfaces ACP
permission and form-input requests and never uses approve-everything modes.

For write-like permission requests, the connector extracts path evidence before
answering Grok. A read-only write attempt, unscoped write, or path outside
`allowed_paths` is cancelled before the tool runs and is retained as observable
`prevented_attempts`. An allowed request still waits for the user's exact returned
option. A recursive runtime workspace monitor separately catches direct or Git-ignored
writes that bypass permission requests and requests exact session cancellation. Final
scope evidence also includes Git metadata. Cancellation requires exact session/run
identity and becomes terminal only when ACP supplies terminal evidence.

## External MCP, web review, and direct API

`execution: external_mcp` is a descriptor only; availability remains unverified until
its exact host tools are observed. Do not reinterpret it as a built-in connector or
bypass missing tools with shell typing.

For ChatGPT web review, follow the packet-first `chatgpt-review-agent` skill. Packet
contents are the evidence boundary. Use hard-path web advice only after a real signal:
two materially different failed attempts, contradictory evidence, a high-blast-radius
low-confidence decision after a discriminating check, or an explicit user request.
Ordinary uncertainty or one failed test is not a trigger.

Call `sol_control_invoke` only for an enabled read-only OpenAI-compatible provider when
direct API invocation and approval are both enabled and credentials are present only
in the configured environment variable. The external model receives no file or host
tools.

## Parent acceptance

Auxiliary work substitutes for root work; it does not duplicate it. Before reporting
completion, the root must:

1. inspect the exact connector identity and terminal evidence;
2. inspect `scope.changed_paths`, `scope.outside_paths`, and `prevented_attempts`;
3. inspect the actual Git diff and preserve pre-existing user work;
4. rerun risk-proportionate checks;
5. distinguish observed evidence from auxiliary claims;
6. decide ship, correction, escalation, or rethink.

Any `scope_violation`, ambiguous identity, unconfirmed cancellation, or missing terminal
evidence fails the lane regardless of response quality. A correction after an audit
invalidates the old verdict and requires a fresh review only when the declared route
includes review.
