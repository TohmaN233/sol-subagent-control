# Provider contracts

Read this after `sol_control_resolve` returns an adapter. Never infer a provider from
its display name; dispatch by `adapter.kind`, `adapter.execution`, and
`adapter.protocol`.

## Shared contract

For every provider:

1. preserve the declared scenario, route, read-only/write intent, and approval state;
2. send only the compiled prompt and minimum required task artifacts;
3. retain the provider's real task/session identity;
4. reject scope expansion or missing terminal evidence;
5. independently verify the result in Sol.

Provider output never grants publication, destructive operations, external messaging,
permission choices, or product authority beyond the user's original request.

## `native_agent`

The adapter returns:

- exact `agent_type`;
- `fork_turns` freshness contract;
- role (`implementer`, `reviewer`, or `advisor`);
- expected model and reasoning effort;
- requested sandbox, when any.

Use native Sol Advisor preflight and runtime evidence. Do not attach per-spawn model or
reasoning overrides. A requested sandbox is not proof of the observed host policy.
Reviewers remain behaviorally read-only and never implement fixes.

## `builtin_connector`: Grok ACP

Expected connector: `grok_acp`, transport `leader_acp_stdio`.

Use only `sol_connector_probe`, `sol_connector_start`, `sol_connector_status`, and
`sol_connector_control`. Start compiles and delivers the selected template internally;
do not copy it into another shell or model call.

- Preserve `task_id`, `session_id`, and `run_id` exactly.
- The current connector is read-only and requires an absolute Git workspace.
- Every ACP permission or input request is returned as `needs_permission` or
  `needs_input`; never answer it implicitly or use approve-everything modes.
- Timeout means `needs_attention`; never create a replacement run automatically.
- A nonterminal task becomes `unknown_after_restart`; this is not evidence that Grok
  stopped or completed.
- Cancellation must target the exact session/run and is terminal only after an ACP
  prompt result is observed.
- `scope_violation` invalidates the result regardless of response quality.

The connector is automated against a fake Grok process. Until a desktop live smoke is
recorded, describe it as experimental rather than broadly compatible.

## `external_mcp`: Cursor Bridge and other host tools

External MCP descriptors return tool names and protocol notes, not a connection owned
by this repository. Their `availability` is `unverified` until the host exposes the
exact tools. Cursor Bridge remains external in this release.

Cursor's model is selected by the user's Cursor configuration; this descriptor does
not add or imply per-call model selection.

If selected, preserve the external provider's own identity and terminal contract, but
do not claim it is installed, bundled, or tested here. Missing tools, ambiguous
identity, or unknown cancellation behavior are configuration blockers; do not bypass
them through shell typing or nearby tool names.

## `packet_review`: ChatGPT web

The adapter returns the review skill name, source repository, packet path, reviewer,
and model label. It does not provide browser tools itself.

Follow the installed `chatgpt-review-agent` skill. Build the smallest sufficient packet,
prefer ZIP for multiple files, upload it in the ChatGPT side browser, wait for the
newest assistant response to finish, capture that exact response, and save it locally.

- Packet contents are the evidence boundary.
- Do not use ambient connector access unless the user explicitly selected that path and
  its smoke test succeeds.
- The reviewer is advisory and read-only.
- A web review does not prove code execution, tests, or correctness.
- Missing browser control or reviewer availability fails the lane without substitution.

## `direct_api`: OpenAI-compatible advisory model

Call `sol_control_invoke`; do not use shell `curl` to bypass its checks. The control
plane validates the endpoint and injects credentials from the configured environment
variable without returning them.

The direct adapter supports text-only advisory calls. It never receives host tools,
files, repository credentials, or mutation authority. The scenario must be read-only,
global direct invocation must be enabled, and approval gates must be satisfied.

The returned fields may include advisory text, model, usage, and provider response id.
Treat all claims as unverified until Sol checks local evidence.

## Unknown external MCP protocol

A user may add another `external_mcp` provider (`mcp_tool` remains a legacy config alias). Use it only when:

- the configured operations exactly match tools actually exposed to the host;
- the public description and notes define task identity, terminal state, cancellation,
  and write boundaries;
- the scenario can be bounded and independently verified.

If any element is missing, return a configuration blocker. Do not guess tool arguments,
call nearby tools, or reinterpret the provider as a direct API.
