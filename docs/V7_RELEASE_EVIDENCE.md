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

Final local, package and remote CI results are appended below when observed.
Do not treat a configured CI matrix as a completed run. Windows Git Bash is not
Linux/macOS execution. Core tests on those platforms do not qualify their Strict
executor; unsupported Strict remains fail-closed. Independent external review and
maintainer merge are separate from automated testing. No remote release or installed
plugin update is claimed by this candidate document.

Rollback: preserve the full state directory, stop active executors, restore the
hash-checked v6 backup through the human migration API if needed, and reinstall
the previous plugin version. Immutable Workflow/Run stores remain for later use.

## Final local checks

Both repository POSIX verification scripts passed on Windows Git Bash. The full
control-plane suite passed185 tests in47.06s and native role checks passed4.
Final service16 passed after the Draft-only MCP publication guard. TypeScript,
exact generated web assets/licenses, plugin manifest and Skill validation passed.
Remote CI results are still pending for this candidate.

