# Sol Subagent Control Tutorial

[中文版本](TUTORIAL.zh-CN.md)

## Will installation automatically call subagents?

No. Installing and enabling the plugin does not automatically call subagents in every conversation. It only makes the `$sol-advisor:sol-control-plane` skill and the control-plane tools discoverable to Codex in **new tasks**. If you create a task from the plugin card's default prompt, that prompt already references the skill. For other tasks, it is recommended to explicitly include this in the first message:

```text
Use $sol-advisor:sol-control-plane. Keep the primary agent in charge, read metadata once,
select one matching Task Type, and verify every auxiliary claim.
```

After the skill is activated, the primary agent reads sanitized configuration metadata once, before its first repository or task-tool call, and selects a route:

- `solo`: the primary agent works alone; this is the default route.
- `delegate`: execute one implementation or analysis Stage.
- `audit`: the primary agent does the main work, followed by a read-only review Stage.
- `full`: run implementation and independent review in sequence; reserve this for explicit high-risk or broad-scope exceptions.

A subagent can be called only when all of the following are true:

1. The current task has activated the control-plane skill.
2. An enabled Task Type matches the semantics of the current task.
3. Each selected Stage is pinned to one enabled Provider with the required capabilities.
4. If approval is required, the user explicitly approves it **in the current task**.
5. A write task supplies non-empty, minimal, repository-relative `allowed_paths`.

Enabling a Provider by itself does not trigger a call, incur a charge, or start anything in the background. The primary agent cannot swap Providers on the fly or silently fall back after a failure.

## Open the real configuration console with one command

The following scripts use the real user configuration:

```text
$CODEX_HOME/sol-advisor/control-plane.json
```

When `CODEX_HOME` is not set, the path is:

```text
~/.codex/sol-advisor/control-plane.json
```

This is user-level global configuration, independent of the current repository and working directory. After you save it, other projects and new tasks read the same configuration. The top of the console explicitly shows **Global user configuration** and the actual file path. Only an explicitly configured absolute `SOL_CONTROL_CONFIG` path, or an override path passed by code for development/testing, is shown in red as **Override/test configuration**. An override does not modify the global configuration and should not be used as the normal entry point.

Console overview (the screenshot uses bundled defaults and contains no local tokens or private settings):

![Sol Subagent Control console overview](assets/sol-subagent-control-console.png)

Task Type presets, custom entry points, and the Stage list:

![Task Type and Stage configuration](assets/sol-subagent-task-types.png)

### Windows

After installation, you can double-click the following file in the plugin directory:

```text
scripts\open-control-console.cmd
```

You can also locate and run it from PowerShell with one command:

```powershell
$plugin = (codex plugin list --json | ConvertFrom-Json).installed |
  Where-Object pluginId -eq 'sol-advisor@sol-advisor'
if (-not $plugin) { throw 'sol-advisor is not installed' }
& "$($plugin.source.path)\scripts\open-control-console.cmd"
```

### Linux / macOS / Git Bash

```sh
plugin_dir="$(codex plugin list --json | jq -r '.installed[] | select(.pluginId == "sol-advisor@sol-advisor") | .source.path')"
test -n "$plugin_dir" && test "$plugin_dir" != null || { echo 'sol-advisor is not installed' >&2; exit 1; }
sh "$plugin_dir/scripts/open-control-console.sh"
```

The script binds to a random `127.0.0.1` port and opens the browser. Keep the terminal running; pressing `Ctrl+C` stops the local service. Do not share a local URL that may contain the console token. You can also choose a fixed port, for example:

```powershell
& "$($plugin.source.path)\scripts\open-control-console.cmd" --port 58046
```

```sh
sh "$plugin_dir/scripts/open-control-console.sh" --port 58046
```

In a Codex conversation, saying “Open the Sol Subagent Control configuration console” is still the equivalent recommended entry point.

If a new task cannot see the `sol_control_*` tools, the plugin MCP server was not activated; this does not mean that the configuration has reverted to defaults. Do not start the server manually from the project shell or automatically switch to another route. Reload or update the plugin, then create a new task. If reading the global configuration fails only with `EPERM` or `EACCES`, approve access to the global configuration directory above and retry once.

## Configure Task Types, Stages, and Providers

A Provider describes “who does the work and through which connection”; a Task Type describes “what kind of task this is and which steps it follows.”

1. In **Providers**, enable the Providers you are ready to use.
2. In **Task Types and stages**, use a bundled preset, copy an existing task, or create a blank task.
3. Select exactly one **Pinned provider** inside each Stage.
4. Select `read_only` for read-only work. For repository changes, select `bounded_write` and enable task approval.
5. Save the configuration.

Bundled presets are starting points, not a closed list. You can delete, restore, copy, rename, or edit them, change their templates, or create entirely custom Task Types. Cursor, Grok, web review, and native agents are Providers; they should not be encoded into Task Type names.

## First real-world test

Use a disposable Git repository for the first test, and enable only one Provider at a time.

### 1. Probe the connection

```text
Use $sol-advisor:sol-control-plane.
Read metadata once; call sol_connector_probe for grok-local, using the current Git repository root as the workspace.
Do not send a task, and do not treat a successful probe as task completion.
```

### 2. Read-only task

Create a `read_only` Task Type Stage and pin it to `grok-local` or `cursor-local`, then say:

```text
Use $sol-advisor:sol-control-plane.
Select the read-only test Task Type I configured and have it read the first heading in README.
Wait for completion, report the real remote identity, and verify that Git status is completely unchanged.
```

Cursor should return `task_id`, `agent_id`, and `target_id`. Grok should return `task_id`, `session_id`, and `run_id`.

### 3. Bounded write task

Create a `bounded_write` Stage, pin it to the Provider under test, and require approval. Then explicitly approve one minimal path:

```text
Use $sol-advisor:sol-control-plane.
I explicitly approve calling grok-local for this task, and it may modify only smoke/grok.txt.
Select the bounded-write test Task Type I configured; allowed_paths must be exactly ["smoke/grok.txt"].
After completion, inspect the real diff, changed_paths, outside_paths, and Git status. Do not rely only on the subagent's text result.
```

The test passes only if the specified file is the only changed path, `outside_paths` is empty, task identity remains continuous, and the primary agent completes independent verification.

## Temporarily disable the control plane

- Turn off **Control plane enabled** in the console: no control-plane task is parsed.
- Turn off an individual Provider: its configuration remains, but it cannot be selected.
- Set `SOL_CONTROL_DISABLED=1` before starting Codex: this is an environment-level kill switch that the console cannot bypass.
- Close the terminal running the one-click console or press `Ctrl+C`: this stops only the configuration webpage and does not change saved enablement state.

The configuration webpage is only a policy editor. Actual calls are made by the control-plane skill and MCP tools in a new Codex task. If the primary model or reasoning effort cannot be observed, show one reminder and continue; stop the controlled subagent route only when an explicit model or level mismatch is observed.
