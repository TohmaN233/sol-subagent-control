# Sol Subagent Control architecture

## Objective

GPT-5.6 Sol is the default. GPT-5.6 Terra also qualifies. GPT-5.6 Luna never qualifies. The reasoning effort must be high, xhigh, or max.


Keep a qualifying primary agent as the only task owner while the user configures which
auxiliary provider is mapped to each reusable scenario. The control plane is a policy,
prompt, transport, and evidence boundary—not an autonomous manager that can accept its
own work.

## Layers

1. **Primary root session**
   - owns requirements, architecture, route declaration, scope, verification, and
     acceptance;
   - sees sanitized scenario/provider metadata;
   - receives one selected template, or starts one built-in connector whose template is
     delivered internally.
2. **Human-owned configuration plane**
   - stores configuration under the user state directory outside plugin caches;
   - exposes a token-protected console bound to `127.0.0.1`;
   - is the only supported writer for provider/scenario mappings and switches.
3. **Provider adapters and connectors**
   - native Codex role, repository-owned Cursor/Grok connector, external-MCP
     descriptor, packet web review, or direct OpenAI-compatible advisory API;
   - expose typed contracts without pretending every provider is a native subagent.
4. **Evidence and acceptance**
   - connector text is a claim;
   - exact identity, terminal evidence, scope evidence, Git state, and tests are checked
     by the root before acceptance.

## Prompt privacy

`sol_control_status` exposes only ids, public descriptions, mappings, capabilities,
enabled/approval state, and template revision fingerprints. It does not return prompt
templates, endpoints, credential-variable names, or console tokens.

`sol_control_resolve` interpolates only `task`, `context`, `constraints`,
`verification`, `scenario_id`, and `provider_name` for one selected non-built-in
provider. `sol_connector_start` performs the same one-template compilation internally
for a built-in connector and persists only a prompt SHA-256.

This is minimization, not a hostile-model secrecy sandbox. A local coding agent may
have broad operating-system access. Stronger secrecy requires an OS isolation boundary
outside this plugin.

## Persistent state

The default configuration path is `$CODEX_HOME/sol-advisor/control-plane.json`, or
`~/.codex/sol-advisor/control-plane.json` when `CODEX_HOME` is unset. An absolute
`SOL_CONTROL_CONFIG` overrides it. Saves are validated, atomic, restrictive-permission,
and revision-checked.
Version-1 files migrate atomically: custom providers, mappings, and templates are preserved, while missing built-in Cursor/Grok providers and connector scenarios are appended disabled.

Connector task records live beside the configuration and contain task identity,
workspace, read/write mode, allowed paths, prompt digest, baseline snapshot, remote
identity, terminal/scope evidence, and bounded public errors. They do not contain the
prompt body. On MCP restart every nonterminal record becomes
`unknown_after_restart`; no task is automatically resubmitted and its workspace remains
reserved.

## Effective permission gate

A route is usable only when global, scenario, provider, and environment switches allow
it. A write task additionally requires all of:

- provider `capabilities.write=true`;
- scenario `read_only=false`;
- explicit current-task `user_approved=true`;
- a non-empty validated `allowed_paths` list.

Allowed paths are workspace-relative, non-glob, non-escaping boundaries. Existing or
nearest existing parents are resolved to reject symlink escape. The exact Git repository
root is required. One nonterminal connector task reserves each workspace.

Before dispatch the connector captures file fingerprints and Git HEAD, refs, semantic
index, local config, and reflog. A recursive runtime monitor records writes—including
Git-ignored paths—and requests exact cancellation as soon as an outside event is
observed. After terminal evidence the connector compares the full snapshot again.
Read-only work permits no changes; bounded-write work permits content changes only at
or below an allowed path and never permits Git metadata mutation. The public result
includes `changed_paths`, `metadata_changes`, `outside_paths`, and `prevented_attempts`.
A violation discards the submodel result and enters `scope_violation`.

This is stronger than a prompt-only boundary but is not represented as an operating-
system sandbox. Cursor offers no permission callback in the chosen UI transport, so its
pre-execution controls are exact workspace binding, validated paths, one-task lease,
the delivered access envelope, and immediate runtime-write observation. Grok ACP
additionally allows write-like permission requests to be path-checked and rejected
before the tool executes. These controls improve containment but are not described as
an operating-system sandbox.

## Minimal Cursor connection

The repository owns a deliberately small Cursor connector:

```text
Sol Control MCP -> loopback HTTP /json/version + /json/list
                -> loopback CDP WebSocket
                -> Runtime.evaluate / Input.dispatchKeyEvent
                -> one pinned Cursor Agents UI profile
```

It keeps the reliability mechanisms derived from the reference Bridge:

- verify that the loopback port belongs to Cursor rather than another Electron IDE;
- never force-close Cursor when it is already running without CDP;
- launch with a loopback debugging port only from an explicitly approved start;
- bind one exact Git workspace and fail on ambiguous pages/workspace sections;
- create one fresh Agent and bind one exact `agent_id`/`target_id`;
- require stable reply/history terminal evidence;
- cancel only the exact generating composer;
- preserve timeout/connection-loss/restart ambiguity and reconcile by persisted identity.

It intentionally omits CCE semantic search, parallel Agent queues, hidden-window mode,
workbench compatibility layers, broad selector fallbacks, and lifecycle supervisors.
The current UI profile is version-sensitive; automated CDP fixtures do not prove a real
user installation is compatible.

## Minimal Grok connection

The repository owns a Grok connector with:

```text
Sol Control MCP -> dedicated Grok Leader
                -> Grok ACP child over stdio NDJSON
                -> initialize, session/new|load, prompt, update,
                   permission, elicitation, cancel
```

It preserves exact `task_id`, `session_id`, and `run_id`, one active task per workspace,
permission/input identity, precise cancellation, bounded waits, diagnostic redaction,
and restart reconciliation. Write-like ACP permission requests are classified before
answering: read-only, unscoped, or outside-path requests are cancelled and recorded as
prevented scope attempts.

It intentionally omits the reference Supervisor daemon, Windows Terminal/TUI,
Named-Pipe clients, writer fencing, proxy discovery, cross-host continuity, process
adoption, and large event/artifact journals. It inherits the environment present when
the plugin MCP starts. A reconciled session does not prove the old run's state; the
connector reports `RECOVERED_RUN_STATE_UNKNOWN` until exact cancellation or other
terminal evidence is available.

## Unified states and operations

Both built-in connectors expose `probe`, `start`, `status`, and `control` through the
same four MCP tools. Their common states are `starting`, `running`,
`needs_permission`, `needs_input`, `cancelling`, `completed`, `failed`, `cancelled`,
`scope_violation`, `needs_attention`, `unknown_after_restart`, and `abandoned`.

Timeout and lost transport are unconfirmed, not terminal. `reconcile` never creates a
replacement task. `abandon` only releases the local reservation after explicit
acknowledgement that the remote work may still run.

## Other providers

External MCP entries remain descriptors whose availability is unverified. ChatGPT web
Pro stays packet-first. Direct OpenAI-compatible calls remain read-only, text-only,
credential-from-environment, no-redirect, bounded-time/response advisory lanes.

The original route model remains `solo`, `delegate`, `audit`, and exceptional sequential
`full`. One auxiliary is still the default maximum; provider diversity is configurable
policy, not a reason to fan out automatically.
