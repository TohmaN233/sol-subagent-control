# ADR 0003: Skill import is one-way and portability is verified

Status: accepted by the user on 2026-09-04.

Import snapshots instructions and eligible resources into a Workflow Draft. It
does not modify, rename, delete, disable or rewrite the source Skill or user
configuration. The resulting preset is the sole process authority; source edits
are shown as provenance changes and never merged automatically.

Every syntactically valid, bounded Skill can produce a coarse instruction Draft.
Only a pack whose relocation and dependency checks pass may be marked verified
self-contained. Otherwise retain explicit external requirements, linked-source
dependencies or unresolved Draft diagnostics. Static analysis does not guarantee
all script dependencies have been discovered. Never execute scripts to infer them.

Vendor scripts, references and assets with per-file hashes and limits. Record
license, source hash, metadata from agents/openai.yaml and SKILL.json, and source
spans for inferred graph parts. Reject escaping, linked, device or excessive
resources; do not import credentials. AI expansion uses an explicitly selected
Provider, remains Draft and preserves the coarse draft on failure.

Linked SkillRef explicitly retains a source dependency. Inlining removes it only
after resources and requirements have been incorporated and validated. A missing
or stale linked source blocks execution rather than silently using another Skill.
