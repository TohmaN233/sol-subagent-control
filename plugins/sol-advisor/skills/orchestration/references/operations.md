# Native operations

This is the maintainer and operator reference for Sol Advisor's native custom-agent
workflow. Keep the README user-facing; use this page when installing, delegating,
inspecting routing, or validating a release.

## Role pins and spawn contract

The installed TOMLs are the source of truth:

| Role type | Model | Effort | Use |
|---|---|---|---|
| sol_advisor_luna_implementer | gpt-5.6-luna | max | Delegate/full bounded routine implementation |
| sol_advisor_terra_implementer | gpt-5.6-terra | high | Delegate/full judgment-heavy or high-risk implementation |
| sol_advisor_sol_reviewer | gpt-5.6-sol | high | Audit/full fresh review; requests read-only sandbox |

Native spawn requests name the role and use a fresh context:

~~~text
agent_type: sol_advisor_luna_implementer
fork_turns: none
~~~

Use the Terra type only when the selected delegate or full route needs it:

~~~text
agent_type: sol_advisor_terra_implementer
fork_turns: none
~~~

Use a fresh Sol reviewer only for audit or full after parent verification:

~~~text
agent_type: sol_advisor_sol_reviewer
fork_turns: none
~~~

Do not attach model or reasoning overrides. An explicit conflicting role/model/effort
result stops the native lane; never substitute another role. An unavailable optional
checker is reported as unverified but does not stop the task.

## Selective route declaration, preflight, and caching

GPT-5.6 Sol is the default. GPT-5.6 Terra also qualifies. GPT-5.6 Luna never qualifies.
The reasoning effort must be high, xhigh, or max. Companion installation is separate
from task routing because plugin installation does not register user-owned TOMLs.

At installation or update time, run the repository-relative installer and its exactness
check:

~~~text
node plugins/sol-advisor/scripts/install-agents.mjs
node plugins/sol-advisor/scripts/install-agents.mjs --check
~~~

When operating from an installed skill, resolve the same script relative to this
reference's parent skill. The installer is `../../scripts/install-agents.mjs` relative
to the orchestration skill directory:

~~~text
node <absolute-plugin-path>/scripts/install-agents.mjs --check
~~~

The `.sh` installer remains a Linux compatibility wrapper. Windows and PowerShell use
the `.mjs` entry directly and do not require Git Bash, WSL, `sh`, `jq`, or Unix tools.

The installer is fail-closed and performs its own post-install exactness check. It
recognizes only byte-exact historical templates, including the shipped v0.2.0 profiles
and the v0.5.0 Luna/Terra profiles during a v0.5.1 update. Modified/unsafe/nonregular/
symlinked/conflicting destinations remain refusals, and all mutations are preflighted.

The root emits one machine-auditable declaration before its first task tool call:

~~~text
SELECTIVE ROUTE
mode: solo | delegate | audit | full
risk: <concise, task-specific rationale>
~~~

Delegate is the default for light or ordinary work; full is required for difficult,
broad, or high-risk work. Solo requires an explicit primary-only request and is never an
activation-error fallback. The root may emit a later declaration only to escalate when
newly observed risk justifies it. It records that evidence and never silently
downgrades.

The existing --check flag verifies all three roles. For task-scoped preflight, check
only the auxiliaries selected by the declaration; every executed check is non-mutating
and fails on an explicit mismatch:

| Route | Required companion checks |
|---|---|
| solo | None |
| delegate (Luna) | `--check --check-role luna` |
| delegate (Terra) | `--check --check-role terra` |
| audit | `--check --check-role sol` |
| full (Luna) | `--check --check-role luna --check-role sol` |
| full (Terra) | `--check --check-role terra --check-role sol` |

For example:

~~~text
node plugins/sol-advisor/scripts/install-agents.mjs --check --check-role luna
node plugins/sol-advisor/scripts/install-agents.mjs --check --check-role sol
~~~

Unknown or missing role arguments fail before any destination mutation. A selective
check ignores unselected role destinations, while the all-role --check behavior
remains unchanged. Cache successful checks only for the task; never carry them across
later tasks, installation/update, or routing/configuration changes.

Luna / Max is for bounded, fully specified work. Terra / High is selected for
judgment-heavy, high-risk, context-heavy, or wide-blast-radius work. A Luna result
may justify a declared Terra escalation only when it shows newly observed risk. One
corrected Luna attempt is reserved for a specification error and is not a prerequisite
for Terra.

If public metadata omits model or effort, use the local inspector below as a fallback
for those omitted fields only. Do not use it to replace available public evidence.

## Runtime routing evidence

The public spawn/details record is authoritative for the selected role and any exposed
model/effort. When model or effort is omitted, resolve the helper relative to the
installed skill and inspect the exact native thread ID. The helper is
`../../scripts/inspect-agent-runtime.mjs` relative to the orchestration skill directory:

~~~text
node <absolute-plugin-path>/scripts/inspect-agent-runtime.mjs <native-subagent-thread-id>
~~~

For a disposable fixture or non-default session root:

~~~text
node <absolute-plugin-path>/scripts/inspect-agent-runtime.mjs --sessions-dir <absolute-path-to-sessions> <native-subagent-thread-id>
~~~

If Node or either `.mjs` entry cannot be found or executed, emit
`ROLE VALIDATION UNAVAILABLE`, name the check that did not run, and continue the task.
You must not claim the missing check or runtime fields were verified. An explicit
mismatch returned by a check must stop the affected native lane.

The helper searches one exact rollout filename suffix and emits only allowlisted
routing fields. It refuses invalid IDs, zero/multiple matches, missing fields, or
conflicting model/effort/sandbox/permission/working-directory values. It never prints
prompts, messages, environment variables, tokens, configuration, or arbitrary rollout
payloads.

Accepted routing is Luna / max for bounded delegate/full implementation, Terra / high
for higher-risk delegate/full implementation, and Sol / high for audit/full review.
If public and local evidence both exist, they must agree. The local inspector is not a
model-selection fallback.

## Read-only reviewer interpretation

The reviewer TOML requests sandbox_mode = read-only. Capture the observed sandbox
policy type and permission profile type from public metadata or the inspector:

- Observed read-only sandbox: isolation is enforced.
- Broader host policy: continue only when hard isolation is not required, the prompt
  forbids edits, and the parent captures exact before/after repository and artifact
  state. Report the broader policy and profile as residual risk.
- Unobservable isolation, required hard isolation, or any mutation: stop the review and
  do not claim read-only isolation.

A reviewer returns exactly ship, fix-first, or rethink. A fix invalidates the prior
verdict; parent verification and a new fresh review are required.

## Worker packet and parent acceptance

Every Luna or Terra prompt uses the five-part packet in role-contracts.md:

- OBJECTIVE
- FILES AND OWNERSHIP
- INTERFACES
- CONSTRAINTS
- VERIFICATION

It must also request the structured implementation report. The parent owns architecture,
complete diff inspection, verification reruns, correction/escalation decisions, and
acceptance. Worker claims never replace direct inspection.

In solo, the root plans, implements, tests, and self-reviews with no auxiliary. In
delegate, one selected Luna or Terra implementer completes the spec and the root
verifies with no fresh reviewer. In audit, the root implements and verifies, then a
fresh Sol reviewer reviews. In full, one selected implementer completes the spec, the
root verifies, and a fresh Sol reviewer reviews. Auxiliary work substitutes for root
work; it does not duplicate it. A reviewer never fixes its own findings.

## Maintainer verification

From the repository root on every supported platform, run:

~~~text
node --test plugins/sol-advisor/scripts/test/native-role-tools.test.mjs
node plugins/sol-advisor/control-plane/test/run-tests.mjs
git diff --check
git status --short
git diff --stat
~~~

On Linux, also run the full compatibility wrapper suite:

~~~sh
sh plugins/sol-advisor/scripts/verify.sh
~~~

The verifier covers the v0.7.6 manifest, exact three-role TOMLs, selective-routing
contracts, concise README journey, absence of retired workflow references, installer
safety fixtures, Luna runtime evidence, JSON/TOML validity, Node syntax, and Linux
wrapper compatibility.
