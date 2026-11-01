---
name: agentic-skill-architect
description: Design or review an "agentic skill" without confusing lightweight skills with runtime infrastructure. Use when deciding what belongs in a SKILL.md versus orchestration, policy, memory, durability, approvals, or operator UX, and when you need a practical skill concept, trust boundary, activation rules, and evaluation checklist.
metadata:
  version: "0.2.0"
  tags:
    - skills
    - architecture
    - agentic
    - review
    - safety
  tools:
    - fs.read
    - memory.read
  keywords:
    - agentic skill architect
    - design an agentic skill
    - review this skill architecture
    - is this actually a skill
    - skill vs runtime
    - should this be a skill or infrastructure
    - audit this skill design
---

# Agentic Skill Architect

Use this skill when someone wants to design, audit, or share an "agentic skill" and the real question is:

- what should be inside the skill itself
- what should stay in runtime infrastructure
- what safety, durability, and approval requirements must exist before the workflow is trustworthy

This skill is intentionally useful to both:

- builders designing new skill systems or shareable skills
- practical users trying to judge whether an AI workflow is sensible or over-engineered

## What This Skill Does

- separates lightweight skill logic from runtime dependencies
- converts vague "make it agentic" requests into a concrete design review
- identifies trust boundaries, side effects, and approval needs
- recommends activation posture and evaluation checks
- returns a shareable skill concept without pretending runtime infrastructure belongs inside `SKILL.md`

## What This Skill Does Not Do

- it does not install or enable a skill automatically
- it does not invent a second plugin system
- it does not treat policy, checkpoints, or memory stores as skill-owned code by default
- it does not assume that more autonomy is always better

## When To Use

Use this skill when the user asks things like:

- "Design an agentic skill for this workflow."
- "Review this skill architecture."
- "Is this actually a skill or is it runtime infrastructure?"
- "Help me make this shareable."
- "What belongs in `SKILL.md` versus the underlying system?"

## When Not To Use

Do not use this skill when:

- the task is simply to author a basic skill and the structure is already obvious
- the task is to implement runtime code, not design the boundary
- the user is asking for a normal prompt, playbook, or template with no architecture question

## Required Inputs

- the workflow or capability being proposed
- target users or operators
- expected side effects, if any
- environment assumptions:
  - local only
  - cloud
  - hybrid
- trust expectations:
  - read-only
  - approval-gated writes
  - autonomous writes

## Optional Inputs

- current skill or prompt draft
- existing runtime primitives
- target surface or mode
- examples of good and bad prior behavior

## Core Distinction

Start with this rule:

- put **instructions, heuristics, triggers, output expectations, and workflow guidance** in the skill
- put **policy, approvals, durability, memory storage, orchestration state, execution engines, and audit systems** in runtime infrastructure

If a proposal includes per-skill executors, checkpoint stores, approval services, or tool runtimes, assume it is probably drifting out of skill territory unless there is a very strong reason otherwise.

## Review Workflow

1. Clarify the real job:
   - What outcome should the skill help produce?
   - Who is using it?
   - What is the minimum successful behavior?

2. Identify side effects:
   - read-only
   - write to local files
   - external API mutation
   - messaging, billing, deployment, or production control

3. Separate skill content from runtime requirements:
   - Skill content:
     - triggers
     - workflow
     - output contract
     - failure modes
     - examples
   - Runtime requirements:
     - approvals
     - tool execution
     - checkpointing
     - audit logging
     - memory persistence
     - multi-agent coordination

4. Decide activation posture:
   - advisory only
   - operator-guided
   - approval-gated execution
   - highly restricted / not appropriate as a skill

5. Define evaluation:
   - how do we know the skill helped?
   - what regressions would make it unsafe or noisy?
   - what should never happen silently?

## Output Contract

Return these sections:

### Skill Concept
- one-paragraph definition of what the skill is for

### Skill-Owned Contents
- what belongs inside `SKILL.md`

### Runtime Dependencies
- what must exist outside the skill

### Trust Boundary
- what the skill may assume
- what still requires operator or runtime enforcement

### Activation Rules
- when to trigger
- when not to trigger
- how aggressive activation should be

### Evaluation Checklist
- concrete pass/fail checks

### Failure Modes
- how the design could go wrong

### Verdict
- `good skill shape`
- `needs narrower scope`
- `runtime feature, not skill`
- `unsafe until policy/durability exists`

## Practical Heuristics

- If the proposal mainly describes execution machinery, it is probably runtime infrastructure.
- If the proposal mainly teaches the agent how to perform a bounded workflow, it is probably skill-shaped.
- If the workflow can cause damage and depends on approvals, that approval logic must live outside the skill.
- If the workflow only makes sense with checkpoints, retries, or audit trails, the skill may describe them, but runtime must own them.
- If a design would surprise a first-time operator, it is too implicit.

## GoatCitadel Appendix

Chat is the only primary operator surface; older Cowork and Code routes open Chat, except `/cowork/tasks` and `/cowork/board`, which open Ops Kanban. Map the framework onto Chat like this:

### Conversation
- prefer lightweight, advisory, low-ceremony skill behavior
- avoid hidden orchestration or autonomous branching

### Agentic work
- visible decomposition, checkpoints, approvals, and delegation run on durable execution and show in the Chat turn

### Code capability
- prefer bounded, correctness-first behavior with explicit validation and proof; governed Code Mode runs are launched and reviewed from Chat

### GoatCitadel Trust Model

Keep these outside `SKILL.md`:

- approval gates
- durable runs and checkpoints
- orchestration plans and HITL state
- learned memory storage and conflict resolution
- skill import validation, trust state, and activation state

In GoatCitadel, skills remain lightweight instruction artifacts. Runtime services remain explicit system components.

## Writing a GoatCitadel Skill

> Adapted from mattpocock/skills (`writing-for-agents`) at commit `4ae2317` and addyosmani/agent-skills (`context-engineering`) at commit `8bfcc1f` (MIT License). See `UPSTREAM.md`.

When the review covers a `SKILL.md` itself, check these, most important first:

1. **The description lists triggers only.** It starts with "Use when" and names situations and symptoms. A description that summarizes the workflow invites the model to follow the summary and skip the body.
2. **The file is self-contained and small.** For bundled skills other than impeccable, the runtime injects `SKILL.md` alone; files under `reference/` never reach the model. Every `SKILL.md` also counts against the shared catalog budget (`node scripts/check-skill-catalog.mjs`), so prune lines that no longer change behavior.
3. **Keywords match as substrings** of the whole message. Use multi-word phrases: "test" also matches "latest", and "review" matches "preview", which loads the skill on unrelated turns. A skill meant to load only on request ships with no keywords and empty routing phrases, so only `use <name>`, `@skill <name>`, or `$bundled:<name>` selects it.
4. **Steer with recipes, not prohibitions.** Name the output's parts in order. A "never do X" list puts X in front of the model and still leaves the wanted shape unstated.
5. **One worked example** beats several thin ones.
6. **Order by stability.** Stable instructions come first; situational detail sits behind an observable condition ("if the operator names a file"); ask the model to read only what the turn needs.
7. **Shipped text passes the promptware scanner.** Describe a risk in plain words; never quote an injection phrase, even as an example of what to refuse.
8. **Tools and side effects stay declared.** List only the GoatCitadel tool ids the workflow uses, and leave approvals, pushes, and other side effects to the runtime's gates.

## Example Invocations

### Builder-focused

- "Design an agentic skill for incident triage and tell me what belongs in the skill versus the runtime."
- "Help me create a shareable skill for agentic research without embedding policy logic inside it."

### Practical-user-focused

- "Is this actually a skill, or am I overcomplicating it?"
- "Audit this skill draft for safety and missing runtime requirements."

## Failure Modes and Boundaries

- turning runtime systems into bloated skill bundles
- assuming operator trust where no approval or audit path exists
- over-triggering on generic "skill" language
- using "agentic" as a license for hidden autonomy
- producing a design that is impressive on paper but unusable in normal operator workflows

If the workflow clearly depends on policy, durability, approvals, or memory that do not yet exist, say so directly and return `unsafe until policy/durability exists`.
