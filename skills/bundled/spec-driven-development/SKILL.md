---
name: spec-driven-development
description: "Use when the operator asks for spec-driven development, or wants a written specification agreed before any code is written for a feature."
metadata:
  version: "0.1.0"
  tags:
    - planning
    - specification
  tools:
    - fs.read
    - fs.write
---

# Spec-Driven Development

> Adapted from addyosmani/agent-skills (`spec-driven-development`) at commit `8bfcc1f` (MIT License). Changes are listed in `UPSTREAM.md`.

Agree what is being built before building it. A short written spec turns assumptions into decisions the operator can see and correct while they are still cheap to change.

## When to use

- The operator names this skill, or asks for a spec to approve before any code.
- A feature is large or ambiguous enough that building the wrong thing would be expensive.

## When not to use

- A small, clear change (use `coding`).
- An open-ended design conversation (use `grilling` first, then this skill).

## Workflow

1. **Read the context.** Look at the code and docs the feature touches, so the spec names real modules, tables, and routes instead of guesses.
2. **Write the spec** with these parts, in order:
   - **Objective:** the outcome, in one or two sentences, and why it matters.
   - **Users:** who uses it and in what situation.
   - **Scope:** what is included.
   - **Non-goals:** what is deliberately left out of this version.
   - **Acceptance criteria:** numbered, observable statements a test or a person can check.
   - **Constraints:** compatibility, security, performance, data, and deadline limits.
   - **Open questions:** each with your recommended answer.
3. **Ask the operator to approve or change it.** Stop there; write no code before the spec is approved.
4. **Plan the tasks.** Once approved, break the work into small tasks in build order, each with the acceptance criteria it satisfies and the check that proves it.
5. **Keep the spec current.** When scope changes during the build, update the spec first and say what changed.

Keep the spec in Chat unless the operator names a file to save it in.

## What the operator decides

- Approval of the spec, and every open question.
- Any scope change during the build.

## Output

- **First reply:** the spec in the order above, ending with a request to approve or change it.
- **After approval:** the task list, each task with its acceptance criteria and check.

## Boundaries

- No code, migrations, or file changes before the spec is approved.
- Mark anything you inferred rather than read as an assumption.

## Related skills

- `grilling` to settle open design questions before the spec.
- `planning` for milestones across several specs.
- `tdd` to build each task against its acceptance criteria.
