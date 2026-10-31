---
name: debugging
description: "Use when a bug, crash, failing or flaky test, or unexpected behavior needs its cause found before anything is changed, including failures that appear only in CI, only in production, or intermittently."
metadata:
  version: "0.1.0"
  tags:
    - debugging
    - code
    - testing
  tools:
    - fs.read
    - shell.exec
  keywords:
    - root cause
    - flaky test
    - intermittent failure
    - stack trace
    - debug this
    - works locally but
---

# Debugging

> Adapted from obra/superpowers (`systematic-debugging`) at commit `2ce8aa1` and mattpocock/skills (`diagnosing-bugs`) at commit `4ae2317` (MIT License). Changes are listed in `UPSTREAM.md`.

Find the cause before changing anything. One fast command that goes red on this exact bug is worth more than any amount of reading code: build it first, then let it judge every hypothesis.

## When to use

- A test fails, a build breaks, or something crashes or returns the wrong result.
- A failure is intermittent, or happens only in CI, in production, or on one machine.
- An earlier fix did not hold.

## When not to use

- A planned feature or refactor with nothing failing (use `coding`).
- Running or reporting on a test suite with no defect to chase (use `qa`).

## Workflow

1. **Read the evidence.** Read the whole error, stack trace, and log, not only the last line. Note what changed recently (commits, dependencies, config, environment) and how the failing environment differs from a passing one.
2. **Build the feedback loop.** Find one command that reproduces the operator's exact symptom: a focused test, a script with a fixture input, an HTTP call, a replayed payload. Make it fast and deterministic by pinning the clock, timezone, random seed, and filesystem. For an intermittent bug, raise the reproduction rate (loop it, run in parallel, vary the timezone or test order) until it fails often enough to judge a change. Run it and show the output.
3. **Shrink it.** Remove inputs, steps, and config one at a time while it stays red, until every remaining piece matters.
4. **Compare.** Find similar code that works and list every difference between it and the broken path.
5. **Hypothesize.** Rank two to four causes. Each states a prediction: "if the timezone is the cause, `TZ=UTC` fails every run." Share the ranked list with the operator, who may already have ruled one out.
6. **Test one variable at a time.** Probe only what separates the hypotheses: a breakpoint, or a log line at a boundary tagged with a unique prefix such as `[DEBUG-a4f2]` so cleanup is one search. For slowness, measure a baseline before changing anything.
7. **Trace to the source.** When a bad value surfaces deep in the stack, follow it back through each caller to where it was first produced, and fix it there.
8. **Fix with a regression test.** Turn the shrunken repro into a failing test, make one change at the source, watch the test pass, then rerun the original loop and the surrounding suite. Where bad data crossed several layers, add a check at each boundary it crossed. In tests, replace sleeps and fixed timeouts with waits on the real condition.
9. **Clean up.** Remove the tagged debug lines and throwaway scripts.

If three fixes in a row have failed, or each fix exposes a new problem somewhere else, stop changing code and bring the operator what you tried and why the design itself is suspect.

If no loop can be built, say so, list what you tried, and ask for access to the failing environment, a captured log or payload, or permission to add temporary instrumentation.

## What the operator decides

- Whether to ship, hold, or quarantine a failing test while the cause is open. A skip or a retry hides the bug, so it is their call with the facts in hand.
- Which hypothesis to test first, when they know the history.
- Whether to take on a design change after repeated fixes fail.

## Output

1. The symptom in one line, with the evidence you read.
2. The reproduction command and what it showed, or what you need to build one.
3. The ranked hypotheses, each with its prediction.
4. Once confirmed: the cause, the fix at its source, the regression test, and the verification run.
5. What remains unverified.

## Boundaries

- Redact secrets in commands, logs, and captured output before showing them: write `<REDACTED>`, and quote only the lines that carry the signal.
- Commands run through `shell.exec` under the operator's shell policy and approvals.
- Retries, longer timeouts, and skipped tests are not fixes. Offer one only as a labeled stopgap for the operator to choose.

## Related skills

- `tdd` for writing the regression test first.
- `qa` for confirming the fix with evidence.
- `coding` for the change itself.
