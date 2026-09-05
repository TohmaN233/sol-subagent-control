# v6 baseline and first isolation evidence

Captured 2026-09-04 from main commit
`4a77f31702e888609cb0c7b10b0a695bc1df61f6`, in an isolated clone on branch
`codex/v7-isolation-foundation`. The checkout was clean before the experiment.

| Item | Observed value |
| --- | --- |
| Plugin name / manifest version | sol-advisor / 0.7.11 |
| Control-plane package version | 0.4.5 |
| Configuration schema | 6 |
| Node | 24.14.1 |
| Codex CLI | 0.145.0 |
| Host platform | win32 |
| Existing control-plane tests | 64 passed; 0 failed |
| Existing native role tests | 4 passed; 0 failed |
| New probe invariant tests | 6 passed; 0 failed |
| Actual request capture | 8 scenarios passed |
| Actual model inference | 3 synthetic cases passed |
| POSIX verification scripts via Git Bash | Both passed |
| Manifest validation | Passed |
| New JavaScript syntax checks / authored diff whitespace | Passed |
| Existing report overwrite attempt | Rejected; report SHA-256 unchanged |

The original 64 + 4 tests ran on the unmodified baseline. Both full verification
scripts subsequently passed before production changes. Probe tests were rerun
after changes; failed intermediate attempts are not passing evidence.

Raw test output is in `control-plane-tests.txt`, `native-role-tests.txt`, and
`probe-tests.txt`. `skill-discovery-result.json` contains sanitized live evidence;
temporary path prefixes were replaced with `$PROBE_ROOT`, and any remaining real
home prefix with `$USER_HOME`. This metadata report performs no model turns.
`request-capture-result.json` records actual local-provider requests, and
`synthetic-live-result.json` records three authenticated synthetic model cases.

The live experiment passed the metadata allowlist checks in two concurrent App
Servers. repo, user (`CODEX_HOME/skills` fixtures), and system scopes were observed.
admin scope, real user `.agents/skills`, and installed plugin discovery remain
unqualified. See `M1-FEASIBILITY.md` for the combined development decision;
individual probe reports keep `strict_proven: false`.

## Bundled configuration

`default-config.json` is a byte copy of the bundled v6 configuration, not the user's
private configuration. SHA-256:
`86767cd0e193b50d3e40a63e0d7ccdb0dbb3ad308ad73d2acf609bb89a365599`.

Task Types: `bounded-code-change`, `judgment-heavy-change`, `cross-review`,
`brainstorm`, `repository-analysis` (enabled); `implementation-with-review`,
`hard-path-web-advice` (disabled).

Providers: `native-luna`, `native-terra`, `native-sol-reviewer` (enabled);
`cursor-local`, `grok-local`, `chatgpt-web-pro`, `custom-openai-compatible` (disabled).

## Submitted proposal and console reference

The submitted plan was copied without changes. SHA-256:
`2a2f231a2fddcf5050f0271a5fdd0c7c9cc43277b849adbbd3bb3da8ec09187c`.
This is the capture-time file hash. Its existing trailing blank lines are retained;
the imported proposal is excluded from the authored-change whitespace check.

Existing repository console screenshots were retained as reference assets:

- `docs/assets/sol-subagent-control-console.png`:
  `2428fd097090e5f93931ca883a69cc7eb4b71e034a05e5ca0001c68332a11122`
- `docs/assets/sol-subagent-task-types.png`:
  `d62b46e25b32aa3a864bce39aaf4f8ade99970cff27a2cc77e86065985d81744`

`console-fresh.png` is a newly captured viewport of the actual v6 console using
only a disposable configuration. SHA-256:
`6d58543ac22fcac00844e4be3ec6e3096ad74d2f2d6ed9d8e30ae5e6037cd389`.

## Limits and rollback

The POSIX scripts passed via the installed Git Bash after adding task-local jq
1.8.1 (verified against the official release SHA-256) and a wrapper to the existing
Python interpreter. Outputs are `verify-core.txt` and `verify-control-plane.txt`.
The first core-script sandbox attempt could not create a disposable fixture;
the same script passed after a reviewed escalation. Linux/macOS live runtime and
remote CI runs are not claimed. The CI matrix covers probe invariants only.

M0 is complete; M1 supports bounded Windows implementation. No installed plugin
change, remote push or release was performed during the baseline work. The v7
runtime, migration and graph editor are subsequent work.

Rollback is to discard the additive foundation branch or reverse its patch. No
user configuration, installed plugin, source Skill, Provider binding or v6 state
requires restoring.
