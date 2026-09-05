# Skill isolation feasibility probe (M1, partial)

These are opt-in feasibility probes, not Workflow executors. The metadata entry
point never starts a turn. The request-capture entry uses an actual App Server with
a loopback model stub. The separately approved live entry uses official managed
authentication and only synthetic fixtures. None copies shared credentials,
installs a plugin, or changes real user configuration. No production code imports
this directory.

The combined evidence supports a bounded Windows implementation candidate; see
`../../docs/baselines/v6-2026-09-04/M1-FEASIBILITY.md`. A zero exit code is a successful
probe, never permission to execute a production Strict workflow. Reports retain
`strict_proven: false` and `m1_gate: "incomplete"` independently of the combined
development decision.

## Run

Requires Node 20+ and a local Codex executable with the App Server methods below.
Use an executable, not a Windows `.cmd`/`.ps1` wrapper. Obtain its path from your
installed CLI; the probe never downloads or selects a different Codex release.

```text
node spikes/skill-isolation/run-app-server-probe.mjs <absolute-codex-executable> <existing-work-root> <new-report.json>
node --test spikes/skill-isolation/assertions.test.mjs
node --test spikes/skill-isolation/fixture-policy.test.mjs
node spikes/skill-isolation/run-request-capture.mjs <absolute-codex-executable> <absolute-work-root> <new-absolute-report.json>
```

The report parent must exist. Use a fresh report filename: the probe refuses to
overwrite prior results. Keep it outside generated `skill-isolation-*` directories.
Reports contain local skill paths and should be reviewed before sharing.

## What is exercised

- Two simultaneous stdio App Servers with separate temporary `CODEX_HOME` values.
- A disposable repository root and a repo fixture, plus per-profile user fixtures.
- Identical skill names in different scopes, compared by absolute path.
- `initialize`, `skills/list` with `forceReload`, and `skills/config/write`.
- All discovered paths except one disabled in each profile, with different allows.
- A second inventory after both policies have been applied, checking contamination.
- SHA-256 comparison of default and active real `config.toml` files before/after.
- Child shutdown before cleanup, bounded Windows file-lock retries, and observable
  failures with retained directory paths when cleanup cannot finish.
- Presence and enabled state of the allowed skill, not just absence of other skills.
- Explicit reporting of unobserved scopes; absent admin skills never count as tested.

Only metadata is read from ambient discovered skills; their instructions are not
opened by the probe. The sole host file-read check reads our own repo fixture. It
does **not** show what a model can access through its tools.

The allowed fixture has `allow_implicit_invocation: false`. The metadata probe
does not test its effect; actual request capture verifies catalog omission and
explicit injection separately.

## Request capture and live turns

The local capture tests eight cases, including real dynamic-tool serialization,
denied explicit input, repo/user duplicate catalogs, post-policy discovery changes,
mid-turn child termination and persisted deny state after restart. Model outputs
in this report are stubs and must never be presented as actual inference.

`run-synthetic-live.mjs` requires `--live-approved`, the executable/work root,
a passing capture report, and fresh report/login-information file paths. Before
launching it, review the actual synthetic payload and obtain any required network
authorization. It verifies executable and fixture-source hashes, uses a new
managed-login profile, and runs three synthetic Sol/low cases. The transient login
file is removed on exit. Do not publish it. Failed turns stop the probe.

Live threads have no execution environment. The dynamic reader exists only for
nonempty allowlists and enumerates permitted paths; its handler returns preloaded
fixture text, never reads a model-provided filesystem path. Normal background
Skills are disabled before authentication and rechecked before each fresh thread.

## Production qualification still required

1. Reproduce these controls in the production executor, including pinned resources
   and actual code-task tool integration. A fixture probe cannot grant its capability.
2. Real user `.agents/skills`, admin, installed plugin skills, repo ancestors,
   new/changed skills during a run, and unknown runtime schema handling.
3. Parent-process crash, orphan process/profile recovery, and authenticated profile
   lifecycle without changing or copying shared credentials.
4. Capability boundaries for AGENTS.md, hooks, MCP, nested workers and direct file
   reads, according to the isolation definition approved by the user.
5. Linux and macOS live evidence before qualifying those platforms.

Do not wire this result into a `ready`/Strict permission gate. Do not silently
downgrade an imported Workflow to Cooperative. The architecture and five reviewed
amendments are accepted; qualified executors are still a later production gate.
