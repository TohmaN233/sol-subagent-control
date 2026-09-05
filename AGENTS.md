# Maintainer context

The v0.8.0 candidate is `plugins/sol-advisor`; its control-plane package/server is
0.5.0. Configuration v7 is activated through explicit transactional migration.
`default-config.json` remains the v6 migration seed and compatibility fixture;
installation and tests must not migrate real user configuration automatically.
The current language is in CONTEXT.md and docs/V7_UPGRADE.md. Release evidence is
docs/V7_RELEASE_EVIDENCE.md; do not describe pending CI or release steps as complete.

The user's v7 plan and five amendments were accepted on2026-09-04. ADR0002–0007
and docs/V7_VISUAL_WORKFLOW_EXECUTION_PLAN.md are authoritative architecture.
The submitted proposal is preserved under docs/proposals as design material.
Use separate branches for large changes. Fix root causes, surface failures and
keep meaningful journal/audit diagnostics. Never suppress audit durability errors.

Workflow Packs have immutable whole-content revisions, CAS writes, bounded resource
manifests and delete-to-trash. Runs pin the complete dependency closure and use a
fsynced hash-chain journal, writer lock and explicit recovery. Definitions edited
or deleted after Run start never replace its intact pinned material. See
V7_CORE_CONTRACT, V7_RUN_CONTRACT and V7_SERVICE_CONTRACT.

Provider bindings, approval semantics and non-glob path boundaries are user policy.
No auto-enable, substitute Provider, implicit retry or Strict downgrade. Structural
Ready is separate from launch readiness. Main acceptance is required on every
successful path. Worker output is an assertion to verify, not authority.

Strict under lib/execution is default-off and accepts only the qualified Windows
x64 Codex0.145.0 SHA from strict-config.mjs. Catalog controls include independent
orchestrator.skills and orchestrator.mcp namespaces. Its boundary covers verified
catalogs, explicit injection and the controlled workspace/resource broker, not an
OS ACL. Unsupported tools, platforms and admin roots fail closed. Never use the
old current-thread adapter as imported Strict or copy shared auth into profiles.
Actual local and three synthetic official-login qualification cases are recorded
under docs/baselines/v7-strict-2026-09-04. A fixture pass is not new qualification.

Skill discovery uses actual configured-profile metadata RPCs. Imports retain complete
bounded resources and visible dependencies; source paths are never edited. AI
expansion uses a selected native Provider and its own read-only planning Run. It
requires main acceptance and exact-source CAS before another unreviewed Draft.
SkillRef pins explicit source/name/hash/nested snapshots; SubWorkflow inherits exact
permissions and child revisions. Source status observes SKILL.md hashes only.
Read V7_SKILL_IMPORT_CONTRACT before changing these rules.

Parallel writers need qualified Strict brokers and owned detached Git worktrees.
Join requires exact patch review, acceptance and target CAS. Never clean an
unaccepted or changed worktree. Git helper uncertainty persists and blocks all
further integration/cleanup until reconciled. See V7_PARALLEL_CONTRACT and
V7_RECOVERY_CONTRACT for controller/lease rotation, exact reattachment and cancellation.
Cursor runtime scope violations persist evidence before Stop and share manual
cancel's exact-identity confirmation. A Stop click alone is not terminal evidence;
identity loss keeps the task unconfirmed and blocks acceptance.

The React/TypeScript/React Flow editor is in web-src; committed web/workflows.*
assets are built with pinned esbuild and include all bundled licenses. No runtime
npm is required. Canvas/transient layout is never a second IR authority. Draft
errors remain visible and repairable. Browser tokens remain in memory; reconnecting
requires explicit human tree adoption. Live output is a bounded unverified suffix;
durable artifacts and main acceptance determine completion.

Checks:

```text
node plugins/sol-advisor/control-plane/test/run-tests.mjs
node --test plugins/sol-advisor/scripts/test/native-role-tools.test.mjs
node --test spikes/skill-isolation/assertions.test.mjs spikes/skill-isolation/fixture-policy.test.mjs
cd plugins/sol-advisor/control-plane
npm ci --ignore-scripts --no-audit --no-fund
npm run check:web
```

Also run both repository verify scripts and the Windows/Linux/macOS core/console
CI matrix. Real Codex probes are opt-in bounded tests outside the runtime package;
never use real credentials without existing authorization. Consult V7_WORK_LOG for
observed failures/fixes and distinguish actual platform evidence from emulation.
