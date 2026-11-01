---
name: ponytail
description: "Use only when the operator names ponytail; it then makes the smallest complete change, with every addition justified."
metadata:
  version: "0.1.0"
  tags:
    - code
    - minimal-change
  tools:
    - fs.read
    - fs.write
    - shell.exec
---

# Ponytail

> Adapted from DietrichGebert/ponytail (`ponytail`, `ponytail-review`) at commit `96608e0` (MIT License). Changes are listed in `UPSTREAM.md`.

Solve the whole problem with the least new code. Work the way a senior developer who values small diffs works: lazy about the solution, never about finishing it. This applies to the turn it is invoked in.

## When to use

- The operator names ponytail for a change or a review.

## When not to use

- Any turn that does not name it (use `coding`).

## Workflow

1. **Scope first.** Read the task and the code it touches. List every place the change must reach (callers, tests, fixtures, config, exports) and what it could break: data it would destroy or expose, callers that would stop working. Extra features are not scope.
2. **Take the first option that fully works:** skip what nobody asked for and name it in one line; reuse an existing helper or pattern the way the surrounding code does; then the standard library or platform; then an installed dependency (never a new one for a few lines); then one readable line; otherwise the minimum code that works.
3. **Finish it.** Update every caller, test, and fixture the change breaks. A bug fix finds every caller first and fixes the root cause once, in the shared code.
4. **Check it.** New non-trivial logic (a branch, a parser, money, security) leaves one small test; trivial changes need none.

- No abstraction, wrapper, option, config, or "for later" code nobody asked for. Deleting beats adding. Keep the codebase's existing structure.
- Comment only the reason the code cannot show, in one line. A shortcut with a known limit gets `shortcut: <the limit>, <when to upgrade>`.

## Levels

If the operator names a level, apply it: **lite** builds what was asked and names the smaller option in one line; **full** (the default) follows the rules above; **ultra** also pushes back, before building, on any part of the request the need does not justify.

## Review mode

When asked to review in ponytail, check in this order: correct, safe, holds at the expected load, risky logic tested, fast enough, lean (dead code, reinventions of existing helpers, abstractions with one implementation). Each finding names a concrete input that breaks or a line that can go, and the smallest fix; group them as must fix, should fix, nice to have, and end with a verdict.

## What the operator decides

- Anything in the `Left out:` line they want after all, and whether to accept a named shortcut.
- The level, when they want other than full.

## Output

1. The change, as the smallest diff that does the whole job.
2. The test, when the logic is non-trivial.
3. A closing line: `Left out:` what you deliberately skipped or did not check, and any risk the operator must know.

## Boundaries

- Never cut validation at trust boundaries, error handling that prevents data loss, security, accessibility, or anything the operator asked for.
- Commands run through `shell.exec` under the operator's shell policy and approvals.

## Related skills

- `coding` for the ordinary workflow when ponytail is not invoked.
- `codebase-design` when the right answer is a different module shape rather than a smaller diff.
