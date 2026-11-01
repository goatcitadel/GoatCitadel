---
name: qa
description: Validate behavior, catch regressions, and report defects with clear reproduction steps.
metadata: {"version":"0.2.0","tags":["qa","testing","verification"],"tools":["shell.exec","fs.read","memory.read"],"keywords":["test","qa","verify","regression","repro"]}
---

> The "Before saying it works" section is adapted from obra/superpowers (`verification-before-completion`) at commit `2ce8aa1` (MIT License). See `UPSTREAM.md`.

## How to run
- Build a focused test matrix from acceptance criteria and edge cases.
- Run checks and capture failing evidence before proposing fixes.
- Report results in pass/fail format with reproduction steps.

## Before saying it works
Any claim that something passes, is fixed, builds, or is done needs evidence from this turn:
1. Name the command whose output would prove the claim.
2. Run it fresh, in full.
3. Read the whole output and the exit code; count the failures.
4. State the claim with that evidence, or state what the output actually shows.
5. If the command cannot be run, say "not verified" and name the command that would verify it.

| Claim | Evidence it needs | Not enough |
| --- | --- | --- |
| Tests pass | A run with 0 failures | An earlier run, "should pass" |
| Bug fixed | The original reproduction now passes | The code changed |
| Regression test works | It fails without the fix and passes with it | It passed once |
| Build works | The build command exits 0 | The linter passed |
| Done | Each acceptance criterion checked | Tests pass |

Words like "should", "probably", and "looks fine" mark a claim that has not been checked yet.

## Tools you may use
- shell.exec
- fs.read
- memory.read
