# Cockpit Verification Gaps Report

Workstream V of the Cockpit Teardown Remediation program
(`docs/superpowers/specs/2026-10-03-cockpit-teardown-remediation-design.md` §6.2).
The program spec and the V plan are not committed yet, so this report carries the procedures it needs.
Finding IDs (CH-, IN-, WK-, LB-, SY-, ST-, FR-, NV-, GL-) come from the Cockpit UX Teardown review of
2026-10-03, which is kept outside the repository.

- **Base commit:** `da158ef00` (`origin/main` when this report was started)
- **Launcher:** `pnpm testbench` (isolated sandbox runtime, deterministic stub model)

## Prerequisites

Both prerequisites are met on the base commit (plan Task 1, Step 1):

| Prerequisite | Check | Result |
|---|---|---|
| The UX-budgets repair has landed | `git log --oneline 9e8edc056..origin/main -- scripts/verification/lib/ux-budgets.mjs scripts/verification/lib/scenarios/ux-budget-routes.mjs` | `1f4c97663` "test(verification): repair stale ux-budgets and cockpit proofs". `git ls-remote origin fix/ux-budgets-proofs` prints nothing: the branch is gone from origin. |
| The testbench launcher exists | `git ls-tree --name-only origin/main scripts/testbench.mjs` | `scripts/testbench.mjs` (#279) |

## Summary

| Check | Status | New findings | Notes |
|---|---|---|---|
| UX-budgets lane on main | Not run | | |
| Nightly CI wiring | Not run | | |
| SY-02 fresh-install re-test | Not run | | |
| Large data (1,000 records) | Not run | | |
| Cross-browser smoke (Firefox, WebKit) | Not run | | |
| Real browsers (Firefox, Safari) | Not run | | |
| Screen readers | Not run | | |
| Real models (operator) | Not run | | |
| Packaged app and macOS input (operator) | Not run | | |
| Gateway outage and recovery | Not run | | |
| Long session | Not run | | |
| First-answer baseline | Not run | | |

Status values: Not run, Passed, Failed (findings filed), Blocked (reason in Notes).

## New findings

| ID | Severity | Owner | Title | Evidence |
|---|---|---|---|---|

## Withdrawn or closed review findings

| ID | Outcome | Evidence |
|---|---|---|

## Check details

Each check below records the setup used, what was done, what was observed, and links to evidence
(screenshots or run artifacts under `artifacts/verification/`, which are not committed).
