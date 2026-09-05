# M1 decision: proceed with the bounded App Server design

Decision date: 2026-09-04. The development feasibility gate is satisfied on the
tested Windows host. This is permission to build M2-M7, **not a production Strict
capability grant**. Individual probe reports deliberately retain
`strict_proven: false` and `m1_gate: incomplete`: no individual test covers the
whole executor contract, and none can authorize a production Run.

## Combined evidence

| Requirement | Evidence |
| --- | --- |
| Disable discovered non-allowed Skills by path | Two real App Servers, different policies, repeated inventories; repo/user/system observed |
| Explicit allowed Skill still executes | Three authenticated Sol/low turns; final explicit output and fixture read verified |
| Implicit fixture really can be invoked | Authenticated baseline produced the marker after an actual dynamic tool read |
| Disabled background is absent | Actual serialized local requests contain no fixture catalog/instructions; authenticated denied turn produced WORKFLOW_ONLY with no fixture read |
| Independent Run policies | Concurrent metadata processes retain distinct allowlists |
| Real configuration unchanged | Before/after byte hashes, including mid-turn child termination |
| Completion/crash cleanup | Child close awaited, generated profile removed, deny policy survives a new process |
| Discovery changes fail closed | New fixture after policy preparation is rejected before thread creation |
| Explicit injection is independently authorized | Disallowed explicit Skill input is rejected before thread creation |

`skill-discovery-result.json`, `request-capture-result.json`, and
`synthetic-live-result.json` are the evidence. The capture uses the real App Server
but a local model stub; the live report uses official managed authentication and
actual model inference. These are different kinds of evidence.

## Candidate boundary

Codex CLI 0.145.0, executable SHA-256
`83751f15cb6a0a7b97df67752c001e3fe1c20e18ffbfec3ff63567296205eb6c`, Windows,
fresh temporary profiles, and fresh App Server threads. The live candidate uses
`environments: []`, a fixture-only catalog, and explicit controlled input/tools.
Repository discovery was separately exercised with the local provider. General
filesystem and code tools are not part of this live probe.

Admin Skills were not installed in this environment; their absence is not a
passing admin test. Real user .agents sources, plugin catalogs, hooks, MCP, nested
workers, mutable source races, parent-process orphan recovery, and other platforms
still require qualification or an explicit unsupported capability. M7 must reject
an executor whose actual catalog/injection surface cannot be enforced. Imported
workflows remain non-executable until that production gate passes.

## Failures found and resolved

- Initial sandboxed managed login failed during token exchange. After the reviewed,
  fixture-only network scope was approved, official managed login succeeded.
- `[tools].view_image = false` is not represented in the tested binary's current
  config schema and did not remove the tool. Disabling the execution environment
  removed general file/image tools; actual request inspection proves that change.
- A read tool advertised with an empty permission set caused the model to request
  a relative path. The request was rejected and the probe stopped. The tool now
  exists only when at least one fixture is allowed and enumerates permitted paths.
  The same absolute-path/allowlist checks still enforce every actual call.

No failed attempt was counted as success. No credentials, authentication bodies,
real Skill contents, or model prompts from user tasks were copied into evidence.
