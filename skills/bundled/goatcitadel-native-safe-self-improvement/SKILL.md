---
name: GoatCitadel Native Safe Improvement
description: "Capture corrections, log operational learnings, and draft review-gated improvement proposals for GoatCitadel guidance surfaces. Use when the user corrects GoatCitadel, a tool call fails, a routing choice was weak, a workflow succeeds unusually well, or GoatCitadel finishes a substantial task and should self-review."
metadata:
  version: "0.2.0"
  tags:
    - goatcitadel
    - self-improvement
    - memory
    - reflection
    - proposals
    - safety
  tools:
    - fs.read
    - fs.write
    - memory.read
  keywords:
    - goatcitadel native safe improvement
    - goatcitadel-native-safe-self-improvement
    - safe self-improvement
    - log this correction
    - log this as workflow friction
    - log this routing gap
    - durable preference
    - post-task reflection
    - improvement proposal draft
    - self-improvement log
    - eval idea for goatcitadel
    - goatcitadel regression idea
---

# GoatCitadel Native Safe Improvement

Help GoatCitadel get better over time **without** granting autonomous self-rewrite. All changes go through human review.

This skill combines two patterns:

1. **Bounded reflection memory** - store corrections, preferences, and post-task reflections inside `.goatcitadel/self-improvement/`
2. **Structured operational learnings** - log errors, gaps, and wins, then convert recurring patterns into **reviewable proposals**

## Primary Goal

Create a GoatCitadel-native improvement loop that can:

- remember explicit user corrections safely
- avoid repeating known workflow mistakes
- spot routing, tool, prompt, and playbook gaps
- suggest durable improvements to GoatCitadel guidance files
- keep a roadmap of missing capabilities
- **never** silently mutate core agent files, project code, provider configs, or secrets

## Workspace Scope

All skill-owned data must live under:

```text
.goatcitadel/self-improvement/
```

If the folder does not exist, create it from this bundle's templates.

## GoatCitadel Target Model

This skill is aware of common GoatCitadel guidance surfaces, but it may only **propose** changes to them.

### Proposal Targets
- `AGENTS.md` for durable operating rules and coordination rules
- `TOOLS.md` for tool-use constraints, routing notes, and edge-case gotchas
- `SOUL.md` for stable assistant behavior, tone, and identity guardrails
- `PLAYBOOKS/*.md` for repeatable workflows and runbooks
- `MEMORY.md` for explicit durable preferences only
- `ROUTING.md` for model and capability routing logic
- `EVALS.md` for test cases and regression ideas

Current repo guarantee in this pass:

- `AGENTS.md`
- `docs/*` style destinations

If a target surface does not exist yet, keep it as a conceptual proposal target. Draft the proposal under `.goatcitadel/self-improvement/proposals/pending/` and do not create new root governance files automatically.

### Hard No-Touch Files
This skill must never directly edit:
- `SKILL.md`
- `AGENTS.md`
- `TOOLS.md`
- `SOUL.md`
- `MEMORY.md`
- `ROUTING.md`
- `EVALS.md`
- `CLAUDE.md`
- `.env`
- provider configs
- secret stores
- Docker, Traefik, or infrastructure files
- application source code
- tests
- CI workflows

It may only draft proposals for those surfaces.

## What This Skill May Do

This skill may only:
- read files inside `.goatcitadel/self-improvement/`
- write files inside `.goatcitadel/self-improvement/`
- append structured entries to local logs
- summarize recurrence patterns
- draft proposal files for human review
- generate eval ideas and playbook suggestions as proposals
- propose concise memory candidates for explicit durable preferences

## What This Skill Must Never Do

This skill must never:
- make network requests
- access browser, email, calendar, contacts, or external accounts
- read files outside `.goatcitadel/self-improvement/`
- infer preferences from silence or weak hints
- self-edit this skill
- directly apply any proposal
- modify source code, tests, prompts, configs, or infrastructure
- escalate its own permissions
- request secrets unless the user is explicitly configuring something in the current task

## When To Use

Use this skill when one or more of these happens:

- the user explicitly corrects GoatCitadel
- a tool call fails or causes friction
- a model routing choice was weak
- a workflow succeeded unusually well and should be repeatable
- a missing capability becomes obvious
- a playbook step was missing or unclear
- GoatCitadel finishes a substantial task and should self-review
- a preference is stated clearly and appears durable
- an eval or regression test case should be added later

## Folder Layout

```text
.goatcitadel/self-improvement/
├── HOT_MEMORY.md
├── corrections.md
├── reflections.md
├── index.md
├── target-map.md
├── logs/
│   ├── LEARNINGS.md
│   ├── ERRORS.md
│   ├── FEATURE_REQUESTS.md
│   ├── ROUTING_GAPS.md
│   └── EVAL_IDEAS.md
├── projects/
├── domains/
├── archive/
└── proposals/
    ├── pending/
    └── approved/
```

## Trigger Rules

### Log to `corrections.md`
For explicit user corrections and stable preferences:
- "that's wrong"
- "stop doing that"
- "from now on"
- "remember that"
- "I prefer"
- "always use"
- "don't assume"

### Log to `logs/LEARNINGS.md`
For durable lessons:
- best practices
- workflow patterns
- stable formatting preferences
- domain-specific gotchas
- knowledge gaps that were resolved
- things that repeatedly reduced error rates

### Log to `logs/ERRORS.md`
For:
- failed tool use
- broken assumptions
- sequencing mistakes
- over- or under-clarification
- unsafe suggestion attempts
- formatting mistakes that caused user friction

### Log to `logs/FEATURE_REQUESTS.md`
For:
- features GoatCitadel should gain later
- automations that would help
- missing integrations
- missing skills or playbooks

### Log to `logs/ROUTING_GAPS.md`
For:
- wrong model chosen for a job
- wrong surface chosen (chat vs cowork vs code)
- wrong tool selected
- missing preflight checks
- missing decision heuristics

### Log to `logs/EVAL_IDEAS.md`
For:
- regression tests
- prompt tests
- eval prompts
- benchmark scenarios
- failure cases worth replaying later

### Log to `reflections.md`
After meaningful tasks, ask internally:
1. What worked?
2. What broke?
3. What surprised us?
4. What would prevent this next time?
5. Is the lesson durable enough to matter later?
6. Should it become a proposal, a playbook, or an eval?

## Promotion Rule

A pattern may be promoted into a proposal only if all are true:

- it appeared at least **3 times**
- it spans at least **2 distinct tasks or sessions**
- it is still valid outside the original context
- it can be written as a short rule, playbook step, routing rule, or eval idea
- it stays within allowed scope
- it does not expand access or permissions

When the threshold is met, create a proposal file in:

```text
.goatcitadel/self-improvement/proposals/pending/
```

## Proposal Types

- `memory` for HOT memory candidates
- `agents-rule` for AGENTS.md suggestions
- `tools-rule` for TOOLS.md suggestions
- `soul-rule` for SOUL.md suggestions
- `playbook` for repeatable workflow docs
- `routing-rule` for ROUTING.md suggestions
- `eval` for EVALS.md or regression ideas
- `feature` for roadmap or skill ideas

## Review Gate

Every proposal is draft-only until a human approves it.

Approval questions:
- Is it explicit?
- Is it durable?
- Does it reduce future failure or friction?
- Is it concise?
- Is it non-sensitive?
- Does it avoid widening permissions?
- Is the target surface correct?

If any answer is no, keep it in logs and do not promote.

## HOT Memory Rules

`HOT_MEMORY.md` must stay short and sharp.
Target under 100 lines.

It should contain only:
- explicit durable preferences
- stable formatting rules
- repeatable workflow reminders
- proven tool gotchas
- compact identity/behavior guardrails that do not belong in `SOUL.md`

Do not store:
- secrets
- temporary context
- one-off instructions
- speculative preferences
- private personal data unless explicitly requested and appropriate

## Native GoatCitadel Guidance

This skill is designed for GoatCitadel systems that may eventually support multiple surfaces like chat, cowork, code, eval, or orchestration layers.

It improves:
- judgment memory
- workflow consistency
- routing quality
- playbook quality
- eval backlog quality
- recurring error prevention

It does **not** provide:
- autonomous code edits
- autonomous prompt rewrites
- autonomous config changes
- networked sync
- hidden telemetry
- self-escalation

## Execution Pattern

1. Read `HOT_MEMORY.md`
2. Do the task
3. Capture corrections, errors, learnings, routing gaps, and reflections
4. Detect recurrence
5. Draft proposal if warranted
6. Wait for human review
7. Never self-apply

## Bundle Contents

- `docs/INSTALL.md`
- `docs/SECURITY_POLICY.md`
- `docs/WORKFLOW.md`
- `docs/TARGET_SURFACES.md`
- `docs/REVIEW_CHECKLIST.md`
- `templates/*`
- `examples/*`

Use them to initialize the local GoatCitadel improvement folder.
