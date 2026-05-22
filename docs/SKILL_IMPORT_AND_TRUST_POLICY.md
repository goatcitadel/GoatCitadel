# Skill Import and Trust Policy

This document defines how GoatCitadel imports third-party skills safely.

## Core Rules

1. All third-party skills are treated as untrusted by default.
2. No marketplace result is auto-installed.
3. Every import must pass validation before install.
4. Every installed skill starts `disabled`.
5. High-risk imports require explicit operator confirmation.
6. Deny-wins policy and approval gates remain authoritative.

## Supported Sources

GoatCitadel supports:

- local folder (`local_path`)
- local zip (`local_zip`)
- git URL (`git_url`)

Marketplace discovery merges:

- `agentskill.sh`
- `skillsmp.com`
- reviewed ClawHub sources as native-overlap catalog records

with equal source priority and explicit provenance.

## Native Overlap Dispositions

Reviewed ClawHub sources are not imported as raw callable skills when GoatCitadel already has a native owner. Mission Control Next must show the operator-facing disposition plainly:

- `Native overlap`: use the GoatCitadel owner instead of importing the listing.
- `Reference only`: keep as inspiration or docs input.
- `Conditional install`: install only after validation, provenance review, and explicit operator action.
- `Rejected`: do not install; route the idea to a future governed capability design if still useful.

Current ClawHub defaults are documented in `docs/CLAW_HUB_NATIVE_CAPABILITY_GUIDANCE.md`.

## Intake Workflow

1. Search sources in Mission Control (`Playbook`).
2. Select a candidate and run validation.
3. Review:
   - frontmatter validity
   - description quality
   - suspicious script indicators
   - network usage indicators
   - license signal
4. Install only if acceptable.
5. Enable manually after review and policy checks.

## Risk Levels

- `low`: valid structure, no major suspicious indicators
- `medium`: potentially sensitive behavior (for example network indicators)
- `high`: invalid structure or suspicious script patterns

High-risk installs are blocked unless `confirmHighRisk` is explicitly set.

## Provenance and Audit

Installed skills are copied into:

- `skills/extra/<normalized-skill-id>`

with a provenance manifest:

- `skills/extra/<skill-id>/source.json`

Validation/install actions are recorded in:

- skill import history
- skill activation events/audit stream

## Duplicate Handling

Marketplace duplicates are merged using a canonical key:

- repository/source reference normalization
- dedupe across providers
- one primary row with alternate provider references

## API Endpoints

- `GET /api/v1/skills/sources`
- `POST /api/v1/skills/import/validate`
- `POST /api/v1/skills/import/install`
- `GET /api/v1/skills/import/history`

## Operator Review Checklist

Before enabling an imported skill:

- confirm scope and expected behavior
- review scripts for destructive commands
- verify network behavior is expected
- verify license compatibility
- keep state as `sleep` or `disabled` unless needed
- test in a low-risk workspace first

## Failure Mode Expectations

If external sources are unavailable:

- source status is shown as degraded/unavailable
- local/git import still works

If validation fails:

- install is blocked
- validation errors/warnings are returned explicitly
