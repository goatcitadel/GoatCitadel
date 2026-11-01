---
name: codebase-design
description: "Use when deciding module boundaries, judging whether an abstraction earns its interface, or restructuring code that has many thin pass-through layers."
metadata:
  version: "0.1.0"
  tags:
    - architecture
    - code
    - design
  tools:
    - fs.read
  keywords:
    - deep module
    - shallow module
    - module boundaries
    - design it twice
    - information hiding
    - pass-through layer
---

# Codebase Design

> Adapted from mattpocock/skills (`codebase-design`) at commit `4ae2317` (MIT License). Changes are listed in `UPSTREAM.md`.

Prefer deep modules: a lot of behavior behind a small interface, placed where something genuinely varies, and tested through that interface. Callers get leverage; maintainers get one place to change.

## Vocabulary

- **Module:** anything with an interface and an implementation, from a function to a package.
- **Interface:** everything a caller must know to use the module correctly: the signature, plus invariants, ordering, error modes, configuration, and performance.
- **Depth:** behavior a caller can use per unit of interface they must learn. Deep means a small interface over a lot of behavior; shallow means the interface is nearly as big as what it hides.
- **Seam:** the place a module's interface lives, where behavior can change without editing the callers.
- **Adapter:** a concrete thing that fills a seam (a Postgres repository, an in-memory fake).

## When to use

- Deciding where a boundary goes, or whether a class, service, or layer should exist.
- Code where calls pass through several layers that add little.
- Making code easier to test without mocking its own parts.

## When not to use

- Visual or interface design (use `impeccable`).
- A change that does not touch module shape (use `coding`).

## Workflow

1. **Read the modules and their callers.** For each module, write down its interface and what it hides from callers.
2. **Apply the deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through. If the same complexity reappears in every caller, it earns its keep.
3. **Check the seams.** One adapter is a hypothetical seam; two (usually production and test) make a real one. Do not add a seam nothing varies across.
4. **Classify each dependency.** In-process code can simply merge. Something with a local stand-in (an in-memory filesystem, an embedded database) is tested with the stand-in. A service you own across the network gets an interface with a production adapter and an in-memory one. A third-party service is passed in, so tests can supply a fake.
5. **Design it twice.** Sketch at least two clearly different interfaces for the module: for example, the smallest possible one (one to three entry points), and one shaped around the most common caller. For each, show a short usage example, what it hides, and its trade-off.
6. **Recommend one** and say why, comparing depth, where future changes will land, and where the seam sits. Combine the sketches when a hybrid is stronger.
7. **Plan the tests:** tests at the new interface replace tests of the shallow parts it absorbed.

## Signs of a shallow design

- Methods that only forward their arguments to another layer with the same methods.
- Callers that must call things in a particular order, or know internal states, to get a correct result.
- Tests that mock the module's own collaborators, or break on refactors that kept behavior.
- A rule (validation, normalization) applied in one method of a layer but not in its siblings.

## What the operator decides

- Which design to adopt, and whether to change the interface now or later.
- Whether a public interface that other packages import can change.

## Output

1. Each module with its interface and what it hides, and its deletion-test result.
2. Two or more interface sketches with usage examples and trade-offs.
3. Your recommendation and the reason.
4. The migration and test plan.

## Boundaries

- Recommend; do not restructure code unless the operator asks for the change.
- Name what you could not see (callers in other packages, runtime configuration) as unverified.

## Related skills

- `tdd` for building the chosen interface test-first.
- `grilling` when the open questions are product decisions, not code shape.
