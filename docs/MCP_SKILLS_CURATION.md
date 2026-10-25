# MCP + Skills Curation Matrix (GoatCitadel)

This document captures the curated MCP server and skill strategy for GoatCitadel production hardening.

## Selection principles

1. Prefer free/self-hostable paths first.
2. Keep overlapping tools minimized to reduce risk and token waste.
3. Enforce trust tiers and explicit policy boundaries before enabling broad automation.
4. Start with a curated core; phase in optional/specialized stacks later.

## MCP server curation

## Core set (enable first)

| Server | Category | Cost posture | Default trust | Reason |
|---|---|---|---|---|
| GitHub MCP | development | mixed | restricted | High-value repo/PR workflows, mature ecosystem |
| Stripe MCP | automation | mixed | restricted | High-value billing, customer, and subscription workflows when Stripe is already part of the stack |
| Playwright MCP | browser | free | restricted | Deterministic browser automation and extraction |
| Context7 MCP | research | unknown | restricted | Strong coding/docs context retrieval |
| Microsoft Learn MCP | research | free | trusted | Official Microsoft documentation source with low side-effect risk |
| n8n MCP | automation | mixed | restricted | Workflow automation hub with self-host path |
| GPT Researcher MCP | research | mixed | restricted | Deep source synthesis workflows |
| OpenSpec MCP | orchestration | unknown | restricted | Structured spec and planning support |

Native complement: Obsidian stays a built-in local integration rather than an MCP server, which is the preferred path when the operator already uses a local Obsidian vault.

## Vendor-hosted catalog

61 vendor-hosted remote MCP servers reviewed in Hermes Agent's `optional-mcps` catalog ship as templates (Notion, Linear, Atlassian, Sentry, Figma and others). They sign in through MCP metadata discovery, start `restricted` with first-tool approval and strict redaction, and stay disabled until an operator registers, allowlists and connects them. Money-moving servers carry risk notes. See `docs/MCP_VENDOR_CATALOG_PROGRAM.md`.

## Optional set (phase 2)

| Server | Category | Cost posture | Default trust | Notes |
|---|---|---|---|---|
| MindsDB MCP | data | mixed | restricted | Useful if data/ML query workflows are active |
| Blender MCP | creative | free | restricted | Useful for 3D/media pipelines |
| Task Master MCP | orchestration | unknown | restricted | Validate maintenance status before rollout |

## Deprioritized overlaps

- Chrome DevTools MCP
- Chrome Browser MCP
- Steel Browser MCP

Decision: Playwright remains primary browser automation layer to avoid duplicate browser-control surfaces.

## Quarantine candidates (insufficient confidence)

- Superpowers
- Ruflo
- Skill Seeker
- Archon / Claude Flow / Zen / HexStrike (enable one at a time only after validation)

## MCP enforcement defaults

1. `trustTier = restricted` by default.
2. `policy.redactionMode = basic` by default.
3. `policy.requireFirstToolApproval = false` by default; set to true for sensitive servers.
4. Use allow/block tool patterns before enabling mission sessions.

## Skills curation

## Core keep set

- github-integration-3
- coding-agent-orchestrator-1
- mcp-integration-1
- skill-finder-installer
- react-code-fix-linter
- web-automation-browser-control
- javascript-seo-auditor
- resource-curator
- frontend-design-7
- web-design-guidelines-auditor

## Conditional keep set

- heroui-react-v3-component-guide
- google-workspace-cli-assistant
- n8n-pull-request-creator
- next-js-cache-components-expert
- next-js-documentation-updater
- interactive-book-translator

## Overlap reductions

1. `prompt-finder-enhancer` over `prompt-lookup`
2. Keep JS doc workflow + fact checker, sleep standalone writer
3. Keep minimal plugin/command/skill authoring cluster; sleep redundant variants

## Skill runtime lifecycle

- `enabled`: always eligible for activation.
- `sleep`: guarded auto mode (high confidence + first-use confirmation).
- `disabled`: never selected by resolver until manually re-enabled.

## Guarded auto defaults

- `guardedAutoThreshold = 0.72`
- `requireFirstUseConfirmation = true`

## Operational concerns

1. Treat external skill/MCP repos as untrusted by default.
2. Verify license, maintainer activity, and security posture before enabling.
3. Keep audit trails for state/policy changes and activation outcomes.
4. Revalidate curated set monthly or before major release freezes.

## Marketplace source governance (skills)

GoatCitadel can discover skills from multiple marketplaces. Current providers:

1. AgentSkill (`agentskill.sh`)
2. SkillsMP (`skillsmp.com`)

Source priority is equal by design. Ranking is based on quality/freshness/trust signals,
not on provider favoritism.

### Intake policy

1. Discovery is allowed.
2. Auto-install is not allowed.
3. Validate before install is mandatory.
4. Installed skills start `disabled`.
5. High-risk installs require explicit operator confirmation.

### Provenance policy

Every installed third-party skill must keep provenance metadata:

- source provider
- source reference URL/path
- canonical key
- validation checks and risk level at install time

Store provenance in `source.json` under installed skill directory.

### Source outage behavior

When marketplace providers are unavailable:

1. Mark provider status as degraded/unavailable.
2. Continue supporting local folder/zip/git imports.
3. Surface clear operator-facing status and avoid silent failures.

## Skill review checklist (before enable)

Use this checklist before switching an imported skill to `enabled`:

1. `SKILL.md` frontmatter parses and includes required fields.
2. Description is specific enough to understand intended behavior.
3. Suspicious script indicators are reviewed.
4. Network indicators are expected and acceptable.
5. License signal exists or has an explicit exception decision.
6. Tool requirements fit current policy and trust posture.
7. Initial rollout state is `sleep` or `disabled` unless justified.
