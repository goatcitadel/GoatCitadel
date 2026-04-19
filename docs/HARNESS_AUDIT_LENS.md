# Harness Audit Lens

GoatCitadel treats external "harness" skills as design references first.

This audit lens exists to help operators review the GoatCitadel runtime across seven native pillars without importing a second control plane:

1. Skill composition
2. Context engineering
3. Orchestration and routing
4. Persistence and state
5. Quality gates and feedback
6. Permissions and safety
7. Ergonomics and trust calibration

## Why this exists

Some marketplace skills are useful as framing devices, but not as direct runtime installs.

- `Harness Engineer`: `reference_only`
  - Useful for its seven-pillar structure.
  - Not a good direct install because GoatCitadel already owns orchestration, memory, approvals, and lifecycle governance natively.

- `Capability Evolver Pro`: `reject`
  - Useful only as bounded inspiration for report-first improvement loops.
  - Not allowed as a direct runtime install because autonomous self-modification conflicts with GoatCitadel's proposal-before-activation trust model.

## Native destinations

Use the audit and its follow-on actions in native GoatCitadel surfaces:

- `Configure > Agents`
- `Skills > Candidate Lifecycle`
- `Observe > Improvement`
- `Cowork > Replay Overrides`

## Safety rule

Harness audit outputs are inspectable only.

They may produce:

- reference patterns
- proposal drafts
- specialist candidate suggestions
- routing-gap summaries

They may not:

- widen the callable surface silently
- mutate code or memory autonomously
- activate capabilities without explicit operator review
- bypass approval-backed governance
