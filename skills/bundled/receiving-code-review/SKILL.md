---
name: receiving-code-review
description: "Use when code review feedback arrives from a person or an automated reviewer, before changing code in response, and especially when a suggestion seems wrong, unclear or out of scope."
metadata:
  version: "0.1.0"
  tags:
    - code-review
    - code
    - collaboration
  tools:
    - fs.read
    - shell.exec
  keywords:
    - review feedback
    - review comments
    - reviewer said
    - reviewer suggested
    - address the review
    - pr comments
    - code review feedback
---

# Receiving Code Review

> Adapted from obra/superpowers (`receiving-code-review`) at commit `2ce8aa1` (MIT License). Changes are listed in `UPSTREAM.md`.

Treat each review comment as a technical claim to check against the code, not a request to agree with. Correctness wins in both directions: push back when the reviewer is wrong, and change the code when they are right.

## When to use

- Review comments arrive (from a teammate, a bot, or the operator relaying either) and code would change in response.
- A suggestion seems wrong for this codebase, unclear, or larger than the change needs.

## When not to use

- Reviewing someone else's code (use `qa`).
- The operator directing their own design: the decision is theirs, so check the scope and act.

## Workflow

1. **Read every comment first.** Change nothing until you have the whole set; items are often related.
2. **Restate each as a claim:** "replacing the Map with a plain object would make this lookup faster."
3. **Check each claim against the code.** Does it hold for this codebase, its inputs, platforms, and versions? Does the current code have a reason (a test, a comment, a compatibility constraint)? Did the reviewer have that context?
4. **Sort the items:** correct, wrong, unclear, or out of scope. For "implement this properly" or "also add X", search for real callers first; unused code is a candidate for removal, not expansion.
5. **Ask about unclear items before changing anything,** because a partial reading of related items produces the wrong change. Say which items you understand and which need clarifying.
6. **Push back on wrong items with evidence:** the input that breaks, the test that would fail, the constraint the reviewer could not see. Say what would change your mind, such as a benchmark or a reproduction.
7. **Apply correct items one at a time,** blocking issues first (breakage, security), then simple fixes, then larger ones, and run the relevant check after each.
8. **If you pushed back and were wrong,** say what you checked and what you found, then fix it.

## What the operator decides

- Whether to override a pushback and apply a change anyway.
- Anything that conflicts with an earlier decision of theirs or changes the architecture.
- Whether a reply goes to the reviewer, and its wording.

## Output

1. Each item with its verdict (correct, wrong, unclear, out of scope) and the evidence.
2. For correct items: what changed and the check that ran.
3. For wrong items: a short, factual reply the operator can send.
4. Questions on unclear items.
5. What you could not verify.

Start with the substance. Openers that praise the review or agree before checking ("Great point", "You're right") carry no information; for a correct item, the fix is the acknowledgment.

## Boundaries

- Draft replies to the reviewer; the operator decides what is posted.
- Commands run through `shell.exec` under the operator's shell policy and approvals.

## Related skills

- `qa` to verify each applied change.
- `debugging` when a comment reports a defect whose cause is unknown.
