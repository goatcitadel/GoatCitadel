<!--
Agent PR template — Claude Code, Codex, and any other coding agent.

Use it with:
  gh pr create --body-file .github/PULL_REQUEST_TEMPLATE/agent.md
or in the browser by appending ?template=agent.md to the compare URL.

Read AGENTS.md before filling this in. The rules that matter most here:
"Truth Beats Theater", the Validation Expectations lanes, and the
"Claims Agents Must Not Make Without Fresh Proof" list.

Delete the guidance comments as you fill each section. Do not delete a
section because it is inconvenient — write "n/a" and say why.
-->

## Agent and accountable human

| Field | Value |
| --- | --- |
| Agent | <!-- e.g. Claude Code (Opus 5) / Codex --> |
| Accountable human | <!-- @handle — the person who reviewed this before it was opened --> |
| Session or task ref | <!-- optional: internal task id, HX ticket, or run id --> |

The accountable human owns this PR. Agent authorship does not transfer
responsibility for correctness, scope, or claims made below.

## What changed

<!-- Plain-language summary. What a reviewer needs to know before reading the diff. -->

## Why

<!-- The problem. Link the issue or the finding that motivated it. -->

## Where it changed

<!--
The runtime owners you touched, not just a file list — e.g.
"gateway policy gate (apps/gateway/src/services/policy/*)" rather than "12 files".
Name the owner you identified before editing, per AGENTS.md step 1.
-->

## Scope discipline

- [ ] Diff is surgical — no unrelated formatting churn
- [ ] No new dependencies (or: justified below)
- [ ] No user data, secrets, generated evidence, or runtime state mutated
- [ ] Docs, UI copy, and implementation still agree with each other

<!-- If you ticked a box you cannot honestly defend, untick it and explain. -->

## What was validated

<!--
Paste real command output. An agent asserting "verify:fast is green" without the
run is treated as a fabricated claim, not a shortcut. If a lane is red, slow, or
unavailable on this host, say so explicitly — a documented gap is reviewable.
-->

| Lane | Ran? | Result |
| --- | --- | --- |
| Focused package/app tests | | |
| `pnpm typecheck` | | |
| `pnpm lint` | | |
| `pnpm docs:check` | | |
| `pnpm verify:fast` | | |
| Other named lane | | |

```
```

## What was NOT validated

<!--
Required. List the gates you did not run and why — no POSIX host, no Docker,
lane too slow for the change, out of scope. "Everything was validated" is
almost never true; if it is, say which lanes you consider exhaustive and why.
-->

## Claims check

Confirm this PR does not assert any of the following without fresh proof
attached above (see AGENTS.md → *Claims Agents Must Not Make Without Fresh Proof*):

- [ ] No claim of hostile-code sandboxing for Code Mode
- [ ] No claim of ungoverned autonomous high-risk tool activation
- [ ] No claim of local-inference maturity from the retired NPU sidecar path
- [ ] No screenshot, baseline, or release proof cited that was not actually produced
- [ ] No backup/restore guarantee beyond the documented offline operator paths

## Risk and blast radius

- [ ] Touches policy, approvals, or Ward enforcement
- [ ] Touches secrets, the vault, or credential handling
- [ ] Adds or changes a storage migration
- [ ] Changes a REST route, status code, or realtime event envelope
- [ ] Changes packaging, the installer, or release tooling
- [ ] None of the above

<!-- For anything ticked: what is the rollback, and what breaks if this is wrong? -->

## Remaining risk and follow-ups

<!--
Per AGENTS.md → Final Reporting. What you are least confident about, what you
deliberately deferred, and what a human should look at hardest.
-->

---

Contributed under the [Apache License 2.0](../../LICENSE). The accountable human
above has read the [Code of Conduct](../../CODE_OF_CONDUCT.md), including the
AI-assisted contributions addendum.
