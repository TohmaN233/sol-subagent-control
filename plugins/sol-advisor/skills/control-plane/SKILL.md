---
name: sol-control-plane
description: "Keep one qualifying primary architect in charge while selecting one user-owned scenario/provider mapping. Native roles remain the default; the experimental built-in read-only Grok ACP connector and optional external providers fail closed and are never auto-enabled."
---

# Sol Subagent Control Plane

Act as the primary architect. Keep requirements, architecture, route selection, scope,
verification, escalation, and final acceptance in the qualifying root session. The
control plane changes how one auxiliary is selected; it does not transfer ownership
of the task.

Read [references/architecture.md](references/architecture.md) for the trust boundary and
[references/provider-contracts.md](references/provider-contracts.md) before executing a
non-native provider.

## Confirm the primary session

GPT-5.6 Sol is the default. GPT-5.6 Terra also qualifies. GPT-5.6 Luna never qualifies.
The reasoning effort must be high, xhigh, or max. If runtime metadata exposes the
current model and effort, verify them. If either violates this contract, stop the
controlled route. If the host does not expose either field, do not invent evidence;
ask the user to confirm the qualifying model and effort only when the task actually
needs an auxiliary.

## Read metadata, not the prompt library

Before repository or task tools, call `sol_control_status` at most once. This is a
configuration preflight, not task execution. It returns scenario/provider metadata,
capabilities, mappings, and approval flags; it intentionally omits templates,
endpoints, credential-variable names, and console tokens.

Do not open, read, grep, print, or rewrite the user configuration file. Do not use
shell or browser automation to inspect the console. Only the human-owned loopback
console may create, enable, disable, remap, or delete providers and scenarios. Never
auto-enable an external provider or bypass `SOL_CONTROL_DISABLED`.

If the status tool is unavailable, disabled, invalid, or inconsistent, use the
original native `$sol-advisor:orchestration` workflow or stay solo. Do not silently
substitute a different external model.

## Declare one selective route

After sanitized preflight and before repository/task tools, emit:

~~~text
SELECTIVE ROUTE
mode: solo | delegate | audit | full
scenario: <enabled scenario id or none>
provider: <mapped provider id or none>
risk: <concise, task-specific reason>
~~~

Solo is the default. One auxiliary is the default maximum. `full` is an explicit broad
or high-risk exception and resolves its implementation and review stages one at a
time; never request the whole template library or two templates in one resolution.
A later declaration may only escalate on newly observed evidence and must record it.
Never silently downgrade or remap the provider.

Choose among enabled scenarios by their public descriptions:

- bounded code or documentation execution with fixed interfaces and owned paths;
- judgment-heavy but still bounded implementation;
- read-only cross-review of an accumulated result;
- read-only brainstorm of alternatives and discriminating checks;
- hard-path web advice only under the trigger below;
- a user-created scenario whose declared capabilities match the task.

A scenario mapping is user policy. Do not replace its provider because another model
seems stronger, cheaper, available, or familiar. If the selected provider is missing
or cannot satisfy its declared contract, fail that lane and continue only through an
explicit new route decision.

## Resolve exactly the selected template

For a non-solo route, call `sol_control_resolve` once for the selected stage. Supply:

- `task`: observable objective;
- `context`: minimum sufficient evidence or accumulated change set;
- `constraints`: fixed decisions, exact ownership, excluded scope, and safety bounds;
- `verification`: commands and concrete acceptance evidence;
- `user_approved=true` only when the user explicitly authorized an approval-gated
  provider or scenario for the current task.

The returned prompt is the only scenario template that may enter this task context.
Do not resolve other scenarios for comparison. Treat the adapter as an execution
contract, not permission to guess adjacent tools or broaden access.

## Execute by provider kind

### Native agent

Use the returned exact native role with a fresh context. Preflight only that selected
role through the existing native Sol Advisor installer/check contract. Public role,
model, and effort evidence is authoritative; use the local inspector only for fields
omitted by public metadata. Missing or conflicting evidence stops the lane.

Luna is the default bounded implementer. Terra is for judgment-heavy, context-heavy,
higher-risk, or wider-blast-radius bounded work. A fresh Sol reviewer remains
behaviorally read-only and never fixes its own findings. The root inspects the complete
diff and reruns verification.

### Built-in connector

When the adapter says `execution: builtin_connector`, do not expose or manually resend
the compiled prompt. Call `sol_connector_start` once with the exact scenario, absolute
Git workspace, minimum context, and current-task approval. Preserve the returned
`task_id` plus Grok `session_id` and `run_id`; read state only through
`sol_connector_status`.

The bundled Grok connector is experimental and read-only. It starts a dedicated Leader,
connects over ACP stdio, surfaces every permission or form input request, and never
selects an option automatically. Answer only the exact returned request and option
through `sol_connector_control`. Timeout is `needs_attention`, not completion or a
reason to resubmit. After restart, a nonterminal task is `unknown_after_restart` and
must not be silently replaced. Treat `scope_violation` as a failed lane even if Grok
returned a plausible answer.

### External MCP descriptor

When the adapter says `execution: external_mcp`, availability is unverified and the
connection is outside this repository. Call only exact observed host tools. Cursor
Bridge remains in this category in the current release; do not describe it as bundled
or connected. If an external tool is unavailable or identity is ambiguous, fail the
lane without shell typing, adjacent-tool substitution, or automatic resubmission.

### ChatGPT web review

Use only for the packet-first path named by the selected adapter. Follow the
`chatgpt-review-agent` skill: build a compact evidence packet, upload it to the
user-selected ChatGPT web reviewer, capture the newest completed answer, and save the
review. Packet evidence is the review boundary. Web Pro has no ambient repository
access, cannot implement, and cannot accept the result.

Use the hard-path web scenario only after at least one material signal:

1. two genuinely different bounded attempts failed or produced contradictory evidence;
2. the next decision has a wide blast radius and local confidence remains low after a
   concrete discriminating check;
3. planning cannot be bounded because key evidence conflicts or the likely route keeps
   changing after direct inspection;
4. the user explicitly requests the web Pro second opinion.

Ordinary uncertainty, routine review, a first failed test, or the mere availability of
Pro is not a trigger. Record the observed signal in the route rationale.

### OpenAI-compatible API

Call `sol_control_invoke` only when the selected adapter is `direct_api`, the scenario
is read-only, direct invocation is enabled, credentials are ready, and all approval
gates are satisfied. The external model receives only the compiled prompt and no host
or file tools. API keys remain in environment variables and must never be printed,
placed in templates, or copied into the console.

Treat the response as advisory text. It cannot support a claim that files were read,
commands ran, or implementation completed. Verify every factual codebase claim in the
root session before use.

## Parent acceptance

Auxiliary work substitutes for root work; it does not duplicate it. The root must:

1. inspect the actual accumulated diff or packet;
2. confirm scope and provider contract compliance;
3. rerun risk-proportionate verification;
4. distinguish observed evidence from auxiliary claims;
5. decide ship, correction, escalation, or rethink.

Any correction after an audit invalidates the old verdict. Obtain a fresh review only
when the declared route includes review. A cross-model opinion improves diversity but
does not replace Sol's acceptance authority.
