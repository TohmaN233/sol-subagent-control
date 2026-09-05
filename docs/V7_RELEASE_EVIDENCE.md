# v7 release evidence

Candidate v0.8.0, 2026-09-05. Base4a77f31702e888609cb0c7b10b0a695bc1df61f6.
Implementation is split into the reviewed-scope foundation, storage, migration,
scheduler, Provider, Strict, import, reference, parallel, editor and recovery commits.
The accepted five amendments are in V7_VISUAL_WORKFLOW_EXECUTION_PLAN.md.

| Required scenario | Evidence |
| --- | --- |
| Legacy bounded change and judgment-heavy flow | workflow-service synthetic host handoff E2E preserves Provider/template/access; main acceptance and fresh journal replay |
| Complete/idempotent v6 migration | workflow-migration tests: backups, generation CAS, crash/torn-tail recovery, disabled Provider and scope preservation |
| Coarse import with source removed | actual manager probe6 cases/17 requests; resource read and bounded write succeed from pinned bytes |
| Conflicting/ambient Skills | actual request/catalog probes plus three previously authorized official-login model cases; original config hashes unchanged |
| Explicit SkillRef and child inheritance | actual manager linked-Skill and deleted-child-Pack cases; pin/scope/ancestry regression tests |
| Source update | source_status and editor test report update_available; resources/revisions unchanged; old-Run pin tests |
| Read-only parallel and Join | scheduler/runtime tests |
| Concurrent bounded writes and merge | actual overlapping App Server parallel probe2 cases/14 requests plus real-Git integration tests |
| Overlapping scopes | branch planner rejects intersecting write scopes before dispatch |
| Crash/resume/cancel | real process/connector tests, same-attempt recovery, stale lease and duplicate payload rejection, durable failure tests |
| UI round-trip | opaque metadata adapter test, immutable save/reopen, real browser Draft/Ready/layout/Provider save/Run recovery/finalization |
| Missing capabilities | validator/service tests for absent or disabled Provider, Skill, MCP, executable and Strict qualification |

M12 full suite:183 passed in57.46s. Its focused34 and actual Windows App Server
6-case/17-request streaming run passed, zero errors. Relevant reports are under
`baselines/v7-strict-2026-09-04`; they distinguish local synthetic responses from
real model calls and retain original limitations. Three authorized official-login
cases are complete and were not repeated for M12/M13. No real user migration.

Browser fixture Run3f7c8657-0d1a-4e0d-9687-abcdbf68db01 succeeded at sequence7,
one final attempt, zero model calls. Invalid JSON blocked submission. A malformed
graph containing a null node showed “草稿无法绘制” with an IR repair path, preserving
its data and navigation. Live previews were verified through actual App Server
deltas and a bounded-preview/journal-metadata regression test.

Observed local, package and remote CI results are recorded below. Windows Git
Bash is not Linux/macOS execution. Core tests on those platforms do not qualify their Strict
executor; unsupported Strict remains fail-closed. Independent external review and
maintainer merge are separate from automated testing. No remote release or installed
plugin update is claimed by this candidate document.

Rollback: preserve the full state directory, stop active executors, restore the
hash-checked v6 backup through the human migration API if needed, and reinstall
the previous plugin version. Immutable Workflow/Run stores remain for later use.

## Final local checks

Both repository POSIX verification scripts passed on Windows Git Bash after the
platform and Cursor fixes. The full control-plane suite passed189 tests in46.55s;
native role checks passed4. TypeScript, exact generated web assets/licenses, plugin
manifest and Skill validation passed. A final four-line guard retains terminal
state if concurrent cleanup causes a late cancellation error; its three relevant
scope-stop/cancellation tests passed and the final PR head is checked separately.

## Actual remote CI

[PR CI33954142382](https://github.com/TohmaN233/sol-subagent-control/actions/runs/33954142382)
on commit0d3e82561e29355b99de1e3dc7b954877c04798c passed all8 jobs:

| Runner/check | Observed result |
| --- | --- |
| Windows core + native | 189/189 core;4/4 native |
| Linux core + native | 187 core passed;2 Windows-only alias tests skipped;4/4 native |
| macOS core + native | 187 core passed;2 Windows-only alias tests skipped;4/4 native |
| Web | pinned dependency install, TypeScript and exact asset/license comparison passed |
| Isolation invariants | passed on Windows, Linux and macOS |
| Full repository | both POSIX verification scripts passed on Ubuntu |

Each core job includes actual loopback console startup, authenticated migration,
graph asset serving and token/CAS checks. macOS explicitly tests refusal of its
unsupported process-ownership profile; this is not a skipped Strict qualification.
The first two CI failures and root-cause fixes are in V7_WORK_LOG.md.

The post-path-change actual Windows probes are release-path-manager.json (6 cases,
17 local-provider requests) and release-path-parallel.json (2 cases,14 requests).
All cases passed, zero errors; profiles were cleaned and shared config hashes
were unchanged. Each report pins source and executable hashes.

The final browser source-update fixture showed both expected hashes and
update_available while remaining r1 Draft. Its browser warning/error log was empty.
No model call or user configuration migration was performed by that UI check.

