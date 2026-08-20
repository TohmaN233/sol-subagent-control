# Sol Advisor — Configurable Subagent Control

**Sol / High runs the show. It declares a risk-gated route before task tools, keeps
solo as the default, and uses a single auxiliary only when that improves delivery.**

This fork preserves Sol Advisor's native Codex workflow and adds an optional local
control plane. The user maps a reusable scenario to a provider in a web console;
Sol sees only sanitized metadata until it selects that scenario, when only that one
prompt template enters the task.

## Go deeper

The original author writes [**Attention Heads**](https://attentionheads.substack.com/?utm_source=github&utm_medium=readme&utm_campaign=sol-advisor) — deep, evidence-backed writing on AI, cognition, and agentic engineering. [Subscribe](https://attentionheads.substack.com/subscribe?utm_source=github&utm_medium=readme&utm_campaign=sol-advisor) for new Agentic Engineering Field Notes.

## Quick start

You need a current Codex CLI or ChatGPT desktop app with plugins enabled, GPT-5.6
Sol / High for the primary session, native custom-agent support, Node.js 20+, and jq.
Luna / Max or Terra / High access is needed only when the selected route delegates.

~~~sh
codex plugin marketplace add TohmaN233/sol-subagent-control --ref main
codex plugin add sol-advisor@sol-advisor
plugin_dir="$(codex plugin list --json | jq -r '.installed[] | select(.pluginId == "sol-advisor@sol-advisor") | .source.path')" && test -n "$plugin_dir" && test "$plugin_dir" != null && test -d "$plugin_dir" && test -f "$plugin_dir/scripts/install-agents.sh" && sh "$plugin_dir/scripts/install-agents.sh"
~~~

Start a fresh task so the native roles and control-plane tools are discovered. Use:

~~~text
Use $sol-advisor:sol-control-plane. Keep Sol as the main agent, read sanitized control metadata once, declare one selective route, resolve only the selected scenario, and verify every auxiliary claim.
~~~

The original native-only workflow remains available as `$sol-advisor:orchestration`.

## User-owned console

Ask Codex to open the Sol Subagent Control console. It opens a token-protected page on
`127.0.0.1`; normal tool output does not reveal the token or prompt library. The page
can enable or disable providers, map scenario → provider, edit preset templates, and
create new scenarios. Configuration persists outside the plugin cache.

Native Luna, Terra, and fresh Sol review are enabled by default. The repository now
bundles an **experimental, read-only Grok Leader + ACP connector**, disabled until the
user enables and approves its scenario. Cursor remains an explicitly external Bridge
descriptor; this repository does not yet bundle a Cursor connection. ChatGPT web Pro
and custom OpenAI-compatible advisory models also remain opt-in.

The Grok connector owns task/session/run identity, permission and input gates, timeout
ambiguity, cancellation, and restart fail-closed state. It has automated fake-process
coverage but still requires desktop live smoke before any broad compatibility claim.
The root continues to check the real Git state, tests, and artifacts.

## What you do

Give Sol the outcome, constraints, and important repository context. You do not need to select or manage a lane; the console stores your reusable mapping while Sol records
the chosen route and owns verification and acceptance.

## Routes

| Mode | Use it when | Delivery |
|---|---|---|
| `solo` | Default; risk is contained. | Root plans, implements, tests, and self-reviews. |
| `delegate` | One complete bounded task benefits from an auxiliary. | The mapped provider executes or advises; root verifies. |
| `audit` | Independent final scrutiny matters more than delegation. | Root implements; the mapped read-only reviewer audits. |
| `full` | Explicit broad or high-risk exception. | One implementation stage, root verification, then one fresh review stage. |

Solo is the default. One auxiliary is the default maximum; `full` is the explicit
exception. Sol emits a `SELECTIVE ROUTE` declaration before the first task tool call.
It can escalate only when newly observed risk justifies it and never silently downgrades
or remaps the provider.

## What happens automatically

Sol / High keeps architecture, decomposition, route selection, parent verification,
escalation decisions, and acceptance in the primary task. Auxiliary work substitutes
for root work; it does not duplicate it. Only the selected template is compiled. When
the route includes review, any correction invalidates the old verdict.

## Updating

Upgrade the fork, reinstall the companion roles, and start a new task:

~~~sh
codex plugin marketplace upgrade sol-advisor
codex plugin add sol-advisor@sol-advisor
plugin_dir="$(codex plugin list --json | jq -r '.installed[] | select(.pluginId == "sol-advisor@sol-advisor") | .source.path')" && test -n "$plugin_dir" && test "$plugin_dir" != null && test -d "$plugin_dir" && test -f "$plugin_dir/scripts/install-agents.sh" && sh "$plugin_dir/scripts/install-agents.sh"
~~~

For exact native spawn, runtime evidence, sandbox interpretation, installer, and
maintainer verification details, read [advanced native operations](plugins/sol-advisor/skills/orchestration/references/operations.md). For the extension, read the
[control-plane architecture](plugins/sol-advisor/skills/control-plane/references/architecture.md)
and [provider contracts](plugins/sol-advisor/skills/control-plane/references/provider-contracts.md).

## Attribution

The native selective-routing core was created by Daniel McAteer and remains under the
MIT license. This fork's configurable control plane is maintained by TohmaN233.
