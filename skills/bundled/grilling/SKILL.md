---
name: grilling
description: "Use when the operator wants a plan, design or idea questioned before it is built, for example 'grill me', 'poke holes in this', or a request to be interviewed about a design."
metadata:
  version: "0.1.0"
  tags:
    - planning
    - design
    - interview
  tools:
    - fs.read
    - memory.read
  keywords:
    - grill me
    - poke holes
    - stress-test this design
    - stress-test my plan
---

# Grilling

> Adapted from mattpocock/skills (`grilling` and `domain-modeling`) at commit `4ae2317` (MIT License). Changes are listed in `UPSTREAM.md`.

Question the plan until you and the operator share one understanding of it. Treat it as a design tree: every decision branches into the decisions that hang off it, and you ask only what can be answered now.

## When to use

- The operator says "grill me", "poke holes in this", or asks to be interviewed about a plan.
- A design has open decisions that would be expensive to discover during the build.

## When not to use

- The operator wants the work done now, or has already settled the design (use `planning` or `coding`).
- A written spec to sign off is wanted (use `spec-driven-development`).

## Workflow

1. **Map the tree.** List the decisions the plan depends on and which ones depend on others. Keep this map to yourself unless asked.
2. **Look up facts yourself.** Anything the workspace can answer (current code, data model, existing docs, memory) you read with `fs.read` or `memory.read` before asking. Only decisions go to the operator.
3. **Ask the frontier.** A round is every decision whose prerequisites are already settled. Number each question, give your recommended answer with a one-line reason, and word the question so "yes" accepts the recommendation. A question that depends on another question still open in this round waits for a later round.
4. **Wait for the answers,** then recompute the frontier: settled decisions unlock the questions that hung off them. Ask the next round.
5. **Sharpen the language as you go.** When the operator uses a vague or overloaded term ("account", "share", "owner"), propose one precise meaning and ask them to confirm it. Test boundaries with a concrete scenario ("Ana leaves the workspace; what happens to the notes she wrote?"). When the operator states how something works and the code says otherwise, show the contradiction.
6. **Finish** when the frontier is empty or the operator says enough. Do not start building until the operator confirms the shared understanding.

## Round format

```
Q1. <short title>: <the question, with the options if there are several>
Recommended: <your answer>, because <reason>.

Q2. ...
```

## What the operator decides

- Every design decision. You recommend; they choose.
- When the grilling is done.
- Whether agreed terms are saved as a glossary, and in which file. A decision that is hard to reverse, surprising without context, and the result of a real trade-off is worth offering as a short decision record.

## Output

- Each round: the numbered questions with recommendations, nothing else.
- At the end: the decisions made, the terms defined, the questions still open, and anything you assumed.

## Boundaries

- Read the workspace; do not change it during the interview.
- Never present an assumption as a settled decision; list it as an assumption.

## Related skills

- `codebase-design` for module and interface questions.
- `spec-driven-development` to turn the answers into a spec.
- `planning` to sequence the work once the design is settled.
