# v7 parallel worktree contract

Read-only branches execute concurrently under ordinary Run leases. Writing
branches require the qualified Strict broker and an actual Git working-tree root.
The service does not qualify cooperative native/main handoff packets as filesystem
isolation. Provider and Run permissions remain authoritative and cannot expand.

At Run start, `pins.parallel` records graph regions, sibling scopes, overlap and
repository identity. Preflight requires a clean tracked/untracked workspace.
Custom checkout filters, merge drivers, configuration includes, symbolic links,
submodules and unsupported portable paths fail explicitly. System/global Git
configuration is suppressed for these owned operations; no shell, hooks, external
diff tool or network Git command is invoked.

On first dispatch in a region, the journal records intent and then a content
snapshot of its current source workspace. This includes preceding serial changes,
without committing a user branch or updating its index. Every sibling worktree
uses that same synthetic base commit. Sequential branch nodes share one workspace;
nested regions fork from their enclosing branch and integrate back into it.
Claim/execution envelopes name the exact derived branch path. Provisioning records
stable ownership before creating worktrees and reopens matching complete creations.
Partial/corrupt ownership is retained and reported, never reset over user files.

A writing Join stays blocked until all branches succeed or are intentionally
skipped and the main controller integrates a reviewed proposal. `prepare_integration`
verifies actual branch changes, including ignored new files, against narrowed
scopes. It rejects failed branches and merge conflicts. The complete merge patch
is a content-addressed Run artifact; `review_integration` returns that exact patch
and branch tree evidence. Unrelated source files and refs remain unchanged.

`integrate_parallel` requires controller authority, `accepted: true` and the exact
patch hash. An intent precedes the file side effect. The target must match either
the recorded source tree or the exact accepted resulting tree; the latter permits
reconciliation after an apply/acknowledgement crash. Any other/partial tree remains
an explicit error. Parent authority is rechecked immediately before application.
Git applies only the reviewed patch to working files, preserving the user's HEAD
and index. The resulting tree is verified before the Join releases downstream work.

`cleanup_parallel` runs only for terminal Runs with confirmed branch completion.
It checks immutable accepted branch snapshots and exact Git/worktree back-references,
journals ownership before deletion, and removes inner worktrees before enclosing
ones. A completed deletion can be reconciled from that intent. Unmerged, changed,
unowned or incompletely stopped worktrees are retained for inspection. Failures
remain in the Run journal; an audit-write failure is never reported as success.

This is application-controlled worktree and tool isolation, not an OS ACL. Bounded
Git calls can still fail or time out; no general exactly-once side-effect or
tree-wide process termination guarantee is claimed. Windows actual Git and Codex
App Server evidence is in the work log. Runtime UI, interrupted remote/helper
recovery and cross-platform release qualification remain subsequent gates.
