# ADR 0007: Parallel work uses explicit branch and write boundaries

Status: accepted by the user on 2026-09-04.

Parallel/join is one graph primitive, including agent-group UI templates. Start
with real read-only concurrency and all_success joins. Track branch identity and
selected/skipped edges; a branch failure cannot accidentally make a Run succeed.

Two workers never write the same working tree concurrently. Each write branch
starts from the same recorded base commit in its own worktree. Bound scope,
verify the full diff and outside paths, then enter an explicit integration gate.
Conflicts require resolution; never choose a side automatically. The main agent
retains integration and acceptance authority.

The initial path language uses workspace-relative non-glob file/directory roots,
matching v6. Effective write scope is the containment intersection of current-Run
authorization, node scope and Provider capability. Empty intersections fail.
Canonical path and symlink checks precede execution; string-set intersection is
not permission intersection. Legacy nodes bind scope explicitly to the Run grant.

Observe attempted/outside writes and verify terminal evidence. Provider-specific
observation is not advertised as an OS sandbox. Cancellation/lease expiry cannot
release a workspace reservation until worker termination or explicit unresolved
state has been recorded. Cross-worktree results require identity and base checks.
