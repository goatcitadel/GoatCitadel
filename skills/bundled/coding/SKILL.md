---
name: coding
description: "Implement, refactor, and fix code with minimal testable changes and deterministic verification. Use when GoatCitadel needs to write new features, fix bugs, refactor existing code, apply patches, or make code-level changes that require local validation before handoff."
metadata:
  version: "0.1.0"
  tags:
    - code
    - engineering
    - implementation
    - refactoring
  tools:
    - fs.read
    - fs.write
    - shell.exec
    - git.exec
  keywords:
    - implement
    - refactor
    - fix
    - test
    - code
    - patch
    - bug fix
    - feature
---

# Coding

Implement, refactor, and fix code with minimal testable changes and deterministic verification.

Use this skill when:
- A new feature, route, or component needs implementation
- A bug needs diagnosis and a targeted fix
- Existing code needs refactoring for clarity, performance, or maintainability
- A patch or migration needs to be applied and verified

Do not use this skill when:
- The task is purely operational (use `operations` instead)
- The task is test strategy without code changes (use `qa` instead)
- The task is documentation-only (use `documentation` instead)

## Workflow

### Inspect

1. Read the relevant contracts, route files, and service files before editing
2. Understand the current behavior and its dependencies
3. Identify the objective, success criteria, non-goals, and constraints

### Implement

1. Make minimal, focused changes — one concern per diff
2. Prefer additive, backward-compatible changes
3. Use shared contract types from `packages/contracts` where applicable
4. Keep control flow deterministic and names clear

### Verify

1. Run `pnpm -r typecheck` to confirm type safety
2. Run `pnpm -r test` to confirm existing tests pass
3. Add or update tests for bug fixes and behavior changes
4. Run `pnpm smoke` for integration confidence
5. Summarize what changed, what was validated, and what still needs attention

## Safety Rules

- Keep policy precedence and safety boundaries intact
- Do not mix unrelated cleanup into behavior changes
- Do not silently change behavior — document material impacts
- Preserve deny-wins, approvals, and grants precedence

## Tools You May Use

- `fs.read` — inspect source files and contracts
- `fs.write` — apply code changes
- `shell.exec` — run builds, tests, and validation commands
- `git.exec` — manage commits and diffs
