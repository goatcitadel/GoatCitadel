---
name: tdd
description: "Use when the operator asks for test-driven development, test-first work, or red-green-refactor."
metadata:
  version: "0.1.0"
  tags:
    - testing
    - tdd
    - code
  tools:
    - fs.read
    - fs.write
    - shell.exec
  keywords:
    - tdd
    - test-driven
    - test driven
    - write the test first
    - write the tests first
    - red-green-refactor
---

# Test-Driven Development

> Adapted from mattpocock/skills (`tdd`) at commit `4ae2317` (MIT License). Changes are listed in `UPSTREAM.md`.

Write one failing test, watch it fail for the reason you expect, write the least code that passes it, and repeat. Tests describe behavior through the public interface, so they survive a rewrite of everything behind it.

## When to use

- The operator asks for TDD, test-first work, or red-green-refactor.
- A change is easier to get right when each behavior is pinned before it is built.

## When not to use

- Running or triaging an existing suite (use `qa`).
- Finding the cause of a failure (use `debugging`, which hands its reproduction back here as the first test).

## Workflow

1. **Pick the seam.** Name the public interface the tests will go through (an exported function, an HTTP route, a CLI command) and what it should catch. For anything wider than one function, confirm the seam with the operator before writing tests.
2. **List the behaviors, smallest first.** One line each, in the order you will build them. Do not write their tests yet.
3. **Red.** Write the test for the first behavior only. Take the expected value from the request or a worked example, never from logic that mirrors the code. Run it and confirm it fails because the behavior is missing, not because of a typo or an import error.
4. **Green.** Write the least code that makes that test pass, with no option or case a later test has not asked for. Run the test, then the file's other tests.
5. **Repeat** steps 3 and 4 for the next behavior, letting what you learned reshape the list.
6. **Refactor on green.** When the slice is complete, tidy names and duplication with every test passing, then run them again.

## Good tests

- Go through the public interface, so a refactor that keeps behavior keeps them green.
- Read as specifications: "slugify collapses repeated spaces", not "calls replace twice".
- Cover one behavior each, with an independent expected value.
- Mock only at system boundaries: network, clock, randomness, and sometimes the filesystem or database. Never mock your own modules; pass boundary dependencies in so a test can supply a fake.

## Signs a test is wrong

- It breaks on a refactor that changed no behavior: it is coupled to private helpers, call counts, or a side channel such as querying the database instead of reading back through the interface.
- It passed the first time it ran: it tests existing behavior, or nothing.
- Its expected value is computed the way the code computes it, so it can never disagree.

## What the operator decides

- The seams worth testing when the scope is wider than one function.
- Which edge cases matter enough to pin.

## Output

1. The seam and the behavior list.
2. For each cycle: the failing test, the command and its failing output, the code, and the passing output.
3. The final run of the affected tests.

## Boundaries

- Show real command output. If the tests cannot be run, say so and mark the cycle unverified.
- Commands run through `shell.exec` under the operator's shell policy and approvals.

## Related skills

- `debugging` hands its shrunken reproduction to this skill as the first failing test.
- `codebase-design` when the interface itself is in question.
- `qa` for verifying the finished change.
