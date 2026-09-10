# Sol Subagent Control

## A FULL UPDATED VERSION IS AVAILABLE IN [https://github.com/TohmaN233/chatgpt-review-agent-skill](https://github.com/TohmaN233/codex-agents-workflow)

A Sol Advisor fork with a console.

You choose the tasks, the subagent models, and their thinking levels. Plug them in, take them out, add your own, and turn each model connection on or off. Cursor and Grok are extra subagent entries. ChatGPT review uses the installed chatgpt-review-agent skill.

The main agent stays in charge. Use GPT-5.6 Sol or Terra at high, xhigh, or max. Luna cannot be the main agent.

## What the console does

- Turn the whole thing on or off
- Turn each model connection on or off (Cursor, Grok, ChatGPT web review, custom API). All start off. Turning one on does not call it.
- Set a subagent's model and thinking level
- Use, edit, copy, or delete the bundled task presets, or add a new one
- Pick which model runs each step of a task

Ask Codex to open the Sol Subagent Control console, or use the one-click script in the tutorial.

## What stays the same

The main agent owns architecture, routing, verification, and acceptance. Writes require an enabled write capability, a bounded-write stage, and allowed paths. Extra Provider/Stage confirmation prompts are optional and off by default. A subagent cannot swap models or silently fall back.

## Go deeper

The original author writes [**Attention Heads**](https://attentionheads.substack.com/?utm_source=github&utm_medium=readme&utm_campaign=sol-advisor) — deep, evidence-backed writing on AI, cognition, and agentic engineering. [Subscribe](https://attentionheads.substack.com/subscribe?utm_source=github&utm_medium=readme&utm_campaign=sol-advisor) for new Agentic Engineering Field Notes.

## Quick start

You need Codex or ChatGPT desktop with plugins enabled, GPT-5.6 Sol or Terra at high/xhigh/max, Node.js 20+, and Git. The POSIX one-liner also uses jq.

~~~sh
codex plugin marketplace add TohmaN233/sol-subagent-control --ref main
codex plugin add sol-advisor@sol-advisor
plugin_dir="$(codex plugin list --json | jq -r '.installed[] | select(.pluginId == "sol-advisor@sol-advisor") | .source.path')" && test -n "$plugin_dir" && test "$plugin_dir" != null && test -d "$plugin_dir" && test -f "$plugin_dir/scripts/install-agents.mjs" && node "$plugin_dir/scripts/install-agents.mjs"
~~~

Start a fresh task, then use:

~~~text
Use $sol-advisor:sol-control-plane. Keep a qualifying primary agent in charge, read sanitized metadata once, declare one selective route, and verify every auxiliary claim.
~~~

The native-only workflow remains `$sol-advisor:orchestration`.

Read the [English tutorial](docs/TUTORIAL.md) or [中文教程](docs/TUTORIAL.zh-CN.md) for one-click console scripts, configuration examples, and tests.

Configuration is user-global at `$CODEX_HOME/sol-advisor/control-plane.json` or `~/.codex/sol-advisor/control-plane.json` when `CODEX_HOME` is unset.

## Updating

~~~sh
codex plugin marketplace upgrade sol-advisor
codex plugin add sol-advisor@sol-advisor
plugin_dir="$(codex plugin list --json | jq -r '.installed[] | select(.pluginId == "sol-advisor@sol-advisor") | .source.path')" && test -n "$plugin_dir" && test "$plugin_dir" != null && test -d "$plugin_dir" && test -f "$plugin_dir/scripts/install-agents.mjs" && node "$plugin_dir/scripts/install-agents.mjs"
~~~

For native operations, runtime evidence, and maintainer verification, read [operations.md](plugins/sol-advisor/skills/orchestration/references/operations.md). For connector states and trust boundaries, read [architecture.md](plugins/sol-advisor/skills/control-plane/references/architecture.md) and [provider-contracts.md](plugins/sol-advisor/skills/control-plane/references/provider-contracts.md).

## Attribution

The native selective-routing core was created by Daniel McAteer under the MIT license. This fork's configurable control plane and minimal connectors are maintained by TohmaN233.
