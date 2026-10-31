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

## Before you write

Read the task and the code it touches. List every place the change must reach: callers, tests, fixtures, config, exports. Check what it could break: data it would destroy or expose, callers that would stop working. That is the scope; extra features are not.

## The smallest complete change

Take the first option that fully works:

1. **Does it need to exist?** Skip options and flexibility nobody asked for, and name them in one line. A vague request gets the smallest version that does the core job.
2. **Already in this codebase?** Use the existing helper, component, or pattern the way the surrounding code does.
3. **Standard library or platform feature?** Use it, unless the project has its own.
4. **An installed dependency?** Use it. Never add a dependency for a few lines.
5. **One line a reader understands at a glance?** One line.
6. **Otherwise,** the minimum code that works.

- Finish every part the task needs, including the callers, tests, and fixtures the change breaks.
- No abstraction, wrapper, option, config, or "for later" code nobody asked for. Deleting beats adding. Keep the codebase's existing structure.
- Comment only the reason the code cannot show, in one line.
- A bug fix: find every caller of the function first, then fix the root cause once in the shared code.
- New non-trivial logic (a branch, a parser, money, security) leaves one small test. Trivial changes need none.
- A shortcut with a known limit gets a comment: `shortcut: <the limit>, <when to upgrade>`.

Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, or anything the operator asked for.

## Levels

If the operator names a level, apply it: **lite** builds what was asked and names the smaller option in one line; **full** (the default) follows the rules above; **ultra** also pushes back, before building, on any part of the request the need does not justify.

## Review mode

When asked to review a change in ponytail, check in this order: correct, safe, holds at the expected load, risky logic tested, fast enough, lean (dead code, reinventions of existing helpers, abstractions with one implementation). Every finding names a concrete input that breaks or a line that can go, and the smallest fix. Group findings as must fix, should fix, nice to have; end with a verdict and the lines that could be removed.

## Output

1. The change, as the smallest diff that does the whole job.
2. The test, when the logic is non-trivial.
3. A closing line: `Left out:` what you deliberately skipped or did not check, and any risk the operator must know.

## Related skills

- `coding` for the ordinary workflow when ponytail is not invoked.
- `codebase-design` when the right answer is a different module shape rather than a smaller diff.
