# ADR 0004: Run-scoped Skill catalog and injection isolation

Status: accepted by the user on 2026-09-04. Bounded Windows feasibility is recorded
in `../baselines/v6-2026-09-04/M1-FEASIBILITY.md`; production qualification remains open.

Strict means the qualified executor controls the fresh node's discovered Skill
catalog and explicit Skill instruction injection. It is not an OS sandbox and
does not promise that arbitrary filesystem access cannot read a Skill source.
AGENTS.md, system instructions, hooks and other tools are separate capabilities;
their presence must not be misrepresented as physically removed.

Default policy denies implicit Skills and permits only explicit node SkillRefs,
declared ambient allows, and current-Run user grants. Imported sources are shadowed.
Skill authorization is by canonical identity/path and content pin, never name alone.
Each node gets a newly prepared profile and fresh execution context; temporary
CODEX_HOME policy never edits the user's shared config or installed Skill sources.

Discover and deny within the actual execution profile, re-enumerate before launch,
and verify actual injection. Unknown paths, discovery errors, unsupported schema,
uncontrolled Skills or changes invalidate Strict capability. Current-context
execution is Cooperative. External Providers must independently demonstrate their
catalog/injection boundary; missing capability blocks Strict, with no downgrade.

M1 must establish fixture coverage, explicit injection, ambient suppression,
concurrent policy separation, configuration integrity and lifecycle cleanup.
Evidence is scoped to the tested binary/schema, executor, platform and roots.
Neither an empty sentinel response nor metadata-only success grants Strict.

Credential handling must use supported host/account flows without changing or
copying shared credential files into Run artifacts. Logs exclude tokens, cookies,
auth bodies and prompt secrets. A pending login is a blocked capability, not a
reason to weaken the isolation contract.
