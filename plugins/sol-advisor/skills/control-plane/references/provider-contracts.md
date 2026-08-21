# Provider contracts

Read this after selecting one scenario. Dispatch by `adapter.kind`,
`adapter.execution`, and `adapter.connector`; never infer a provider from its display
name.

## Shared contract

For every provider:

1. preserve the declared scenario, route, read/write intent, approval state, workspace,
   and path boundary;
2. send only the selected compiled prompt and minimum required artifacts;
3. retain the provider's real task/session/Agent identity;
4. reject missing terminal evidence, scope expansion, or ambiguous cancellation;
5. treat provider output as a claim and independently verify it in the primary agent.

Provider output never grants publication, destructive actions outside the user request,
external messaging, permission choices, or product/governance authority.

## `native_agent`

The adapter returns exact `agent_type`, freshness, role, expected model/effort, and any
requested sandbox. Use native Sol Advisor preflight and observed runtime evidence.
Do not attach per-spawn model overrides. A requested sandbox is not proof of the host
policy. Reviewers remain behaviorally read-only and do not implement their own fixes.

## Built-in connector operations

Both built-in connectors use:

- `sol_connector_probe(provider_id, workspace?)`;
- `sol_connector_start(scenario_id, task, context, constraints, verification,
  workspace, user_approved, allowed_paths?)`;
- `sol_connector_status(task_id, wait_ms?)`;
- `sol_connector_control(task_id, action, exact identity fields...)`.

`probe` sends no task. `start` compiles/delivers one private template internally.
`status` is keyed only by exact `task_id`. `control` supports `reconcile`, exact
cancellation, disconnect, and acknowledged abandon; Grok also supports exact permission
and input responses.

Write tasks require provider write capability, a non-read-only scenario, current-task
approval, and non-empty validated `allowed_paths`. Read-only tasks omit paths. Every
task requires an absolute Git root and acquires the workspace's single active-task
reservation.

Common terminal evidence and scope fields must be inspected before use. A
`scope_violation`, `needs_attention`, `unknown_after_restart`, or `abandoned` result is
not an accepted implementation.

## `builtin_connector`: Cursor CDP

Expected connector `cursor_cdp`, transport `cdp_ui`.

The connector verifies a loopback Cursor CDP endpoint or, when Cursor is closed,
launches the configured executable with the configured loopback debugging port and
exact workspace. It does not force-close an already-running Cursor that lacks CDP.

- The supported UI profile is `agents_v2_2026_08`; a profile mismatch fails closed.
- Start creates one fresh Agent in one exact workspace and returns `task_id`,
  `agent_id`, `target_id`, and `cdp_port`.
- On the history-backed UI, Agent history and composer identity must agree. On Cursor
  3.16's Agents panel, the connector binds the one exact composer ID published after
  submission. Zero or multiple identities fail closed.
- Completion requires a stable stopped generation plus stable final reply/history
  evidence, not merely a visible Markdown fragment.
- Cancellation requires `confirm=true` and the exact returned `expected_agent_id`.
  Stop is clicked only in the exact matching generating composer and becomes terminal
  only after a stable stopped observation.
- Timeout or CDP loss enters `needs_attention`. After restart, `reconcile` reopens the
  persisted exact Agent on history-backed surfaces. The Agents panel reattaches only
  when its currently visible composer has the persisted exact ID; it never guesses or
  creates a replacement.
- Cursor has no permission request hook in this transport. Before dispatch the
  connector validates workspace/path policy, holds a one-task lease, embeds the access
  boundary in the prompt, and monitors recursive filesystem events. Outside or
  Git-ignored writes request exact Agent cancellation. Final evidence compares changed
  content plus Git HEAD, refs, semantic index, local config, and reflog.

Automated tests use a real child process that implements loopback HTTP, WebSocket
framing, CDP commands, Agent state, cancellation, restart recovery, and workspace
mutations. Cursor 3.16.29 on Windows passed local read-only, bounded-write, and
exact-cancel smoke tests on 2026-08-20. This is a known-good baseline, not proof for a
different Cursor build, login, or UI profile.

## `builtin_connector`: Grok ACP

Expected connector `grok_acp`, transport `leader_acp_stdio`.

The connector starts a dedicated Leader and ACP child and uses `initialize`,
`session/new`, `session/load` for reconciliation, `session/prompt`, `session/update`,
`session/request_permission`, `elicitation/create`, and `session/cancel`.

- Preserve `task_id`, `session_id`, and `run_id` exactly.
- Permission/input requests remain pending until the exact returned request and option
  are answered. Never use approve-everything modes.
- A write-like permission is classified before answering. Read-only, unscoped, or
  outside-path writes are cancelled before execution and recorded under
  `scope.prevented_attempts`.
- An in-scope write permission is still surfaced for explicit option selection.
- Cancellation requires `confirm=true`, `expected_session_id`, and `expected_run_id`.
  It is terminal only after ACP prompt evidence proves the outcome.
- Timeout enters `needs_attention`; no replacement run is created.
- After restart, `reconcile` attaches an ACP child to the persisted Leader socket and
  loads the exact session. Because ACP does not prove the prior run state, it reports
  `RECOVERED_RUN_STATE_UNKNOWN` and permits exact inspection/cancellation rather than
  claiming completion.
- Direct file changes, Git-ignored runtime writes, Git metadata mutations, and prevented outside permission attempts feed the common scope verdict.

Automated tests use real Leader/ACP child processes and NDJSON request/notification
exchange. They do not prove the user's Grok binary, authentication, proxy environment,
or desktop behavior. Grok CLI 1.0.4 on Windows passed local read-only, bounded-write,
and exact-cancel smoke tests on 2026-08-20.

## `external_mcp`

An external MCP provider is a descriptor only. Its `availability` is unverified until
the host exposes the configured tools. Preserve the provider's own identity and
terminal contract, but do not call nearby tools, simulate terminal typing, or describe
the external integration as bundled.

`mcp_tool` remains only a legacy configuration alias for `external_mcp`.

## `packet_review`: ChatGPT web

Follow the installed packet-first `chatgpt-review-agent` skill. The packet is the
evidence boundary. Wait for the newest completed answer, capture that exact response,
and save it. Missing browser control or reviewer availability fails the lane without
substitution. A web review never proves code execution or correctness.

## `direct_api`: OpenAI-compatible advisory model

Call `sol_control_invoke`; do not bypass it with shell HTTP. The endpoint must be HTTPS
except loopback HTTP, credentials come from an environment variable, redirects are
rejected, response/time are bounded, and no host/file tools are supplied. The scenario
must be read-only and all switches/approval gates must be satisfied.

## Primary acceptance

Before accepting connector work, the primary agent must inspect:

- exact remote identity and terminal evidence;
- `scope.read_only`, `allowed_paths`, `changed_paths`, `outside_paths`, and
  `prevented_attempts`;
- the actual Git diff, including pre-existing user changes;
- tests/checks actually run rather than merely claimed.

The primary agent alone decides ship, correction, escalation, or rethink.
