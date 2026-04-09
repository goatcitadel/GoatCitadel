# GoatCitadel Agentic Coding Workflow

This is GoatCitadel's default coding workflow for all code changes.

It is intentionally repo-native:

- source of truth is the current local repo state
- validation uses existing GoatCitadel commands and artifacts
- handoff stays in the repo/task context, not in a separate home-directory memory system
- local machine config stays local unless it is explicitly meant to ship

The workflow applies to bug fixes, refactors, feature work, docs-backed UI changes, and release hardening. The level of validation scales with risk, but the workflow itself is always the same.

Use the repo's tests, validation scripts, and product-facing docs as the source of truth for what proof is strong enough for a change.

## 1. Ground

Before editing:

1. Inspect the current implementation.
2. Check `git status --short`.
3. Treat the local repo as source of truth instead of prior reviews or screenshots.
4. If the work touches chat, routing, storage, auth, TUI, Mission Control, or release readiness, identify the latest verification artifact and note whether it predates the current tree.

Required outputs from grounding:

- current behavior or current implementation shape
- files or subsystems in scope
- any dirty-worktree constraints that should not be reverted

Do not start from memory when the repo can answer the question directly.

## 2. Contract

Define the change before writing code.

Every code change must explicitly state:

- objective: what we are changing
- success criteria: what proves it worked
- non-goals: what must stay untouched
- constraints: stack, runtime, safety, or compatibility limits
- blast radius: what user-facing or operator-facing surfaces may move

For very small changes, this can be compact. It still has to exist.

Examples of good GoatCitadel contracts:

- "Fix the chat follow-up routing bug without changing session storage semantics."
- "Improve the Mission Control stream-status affordance without changing the chat API contract."
- "Simplify OfficeCanvas internals while preserving the `OfficePage` prop interface."

## 3. Smallest Safe Change

Change the minimum amount of code needed to satisfy the contract.

Rules:

- prefer surgical diffs over broad rewrites
- separate behavior change from cleanup whenever practical
- do not expand scope silently
- if scope grows, split it into a follow-up change instead of folding everything into one patch

GoatCitadel-specific expectations:

- keep shared contracts and public prop interfaces stable unless the contract explicitly includes interface changes
- do not commit local machine state by accident, especially `.claude/settings.local.json` or local config experiments
- if a change affects live chat, realtime, TUI, or Mission Control interaction flow, design for direct operator scanability, not just internal correctness

## 4. Prove

Every change needs evidence.

At minimum, run one explicit validation step or state why automation was not possible.

### Validation Ladder

Use the smallest validation that still proves the contract:

- Localized code change:
  - targeted test or targeted typecheck for the touched subsystem
- Shared package, storage, gateway, chat, routing, auth, or contract change:
  - targeted tests plus subsystem typecheck
  - expand to repo-wide checks if the change crosses package boundaries or affects multiple surfaces
- Mission Control, TUI, Office, or interactive UX change:
  - targeted tests/typecheck
  - plus a manual-test note for visible behavior, interaction, or scanability
- Release hardening or public-testing work:
  - `pnpm -r typecheck`
  - `pnpm -r test`
  - `pnpm smoke`
  - `pnpm -r build`

### Proof Requirements

For regressions and bugs:

1. show the failing condition first when practical
2. apply the smallest fix
3. rerun the same check to show the change actually resolved the issue

For interactive work, include the human-facing proof target:

- stream interruption and recovery
- session switching behavior
- stale-state or race-condition handling
- scanability of new status UI
- compatibility of large visual rewrites with existing page props and page-level behavior

When recent verification artifacts exist, say whether they are still representative of the current tree.

## 5. Handoff

Close every coding cycle with a handoff that another engineer or operator can trust.

Required handoff contents:

- what changed
- why it changed
- validation performed
- residual risks or follow-up gaps
- restart or refresh steps if runtime behavior changed
- rollback note when the blast radius is meaningful

Good handoff quality means:

- no hidden assumptions
- no "should be fixed" language without evidence
- no vague validation summaries
- no silent omission of things that could still break manually

## Escalation Rules

Pause and escalate instead of pushing through ambiguity when:

- two attempts fail for the same reason
- the code path under review keeps changing under you
- the worktree contains unrelated edits in the same files
- the validation path is not strong enough to support the claim being made
- the change would force a public interface or behavior shift not covered by the contract

Escalation format:

- what was tried
- what is blocking progress
- the safest next options
- the tradeoff of each option

## GoatCitadel-Specific Traps

Avoid these recurring failure modes:

- trusting an older review more than the current repo
- treating the UI as correct because the API or reducer looks correct
- claiming chat behavior is fixed without direct probes or realistic manual reproduction
- making large visual rewrites without preserving the page-facing interface
- letting local-only hook/config changes bleed into a shared commit
- changing runtime behavior without mentioning restart or refresh requirements
- mixing release hardening with new feature expansion in the same pass

## Explicit Non-Adoptions

This workflow intentionally does not adopt:

- home-directory memory stores such as `~/agentic-coding/`
- implicit telemetry or dashboard aggregation outside repo-owned artifacts
- mandatory subagent spawning as a default coding requirement
- external verification frameworks that exceed GoatCitadel's current trust, privacy, or scope boundaries

Useful ideas can be borrowed. Tooling and persistence models are not adopted automatically.
