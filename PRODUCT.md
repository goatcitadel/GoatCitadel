# PRODUCT.md

Product context for coding agents working on GoatCitadel. Read it with `DESIGN.md` before changing anything an operator sees or relies on. It restates the framing that `AGENTS.md`, `docs/1_0_CONTRACT.md`, and `docs/CANONICAL_RUNTIME_STATE_MODEL.md` make binding; when they disagree, those documents and the current implementation win. This file is repository guidance only: the runtime never injects it, and a workspace's own `PRODUCT.md` (Settings › Workspaces › Design context) is a separate, operator-owned document.

## What GoatCitadel is

A local-first AI operations console: chat, coding, orchestration, memory, tools, approvals, and operator-visible runtime truth in one place. It is chat-first, multi-provider, and skill-aware. Operators chat naturally, supervise agentic work, build and review code, manage providers, tools, memory, skills, integrations, approvals, and runtime health, and can always see what the system did, why, and what still needs human judgment.

The Fastify gateway is the control plane and the source of operational truth. Mission Control is an API client, never a second backend. Native Windows desktop hosting, installers, and Docker are part of the product shape; none of them replaces auth, approvals, path jails, or policy.

## Who it is for

- **Curious first-timers** who want an assistant that is safe by default and does not present a wall of knobs. They get guided setup, safer defaults, and plain-language status.
- **Operators** who run real work through it every day: planning, research, drafting, approvals, and governed code changes from one Chat surface, with an Inbox that holds every decision waiting on them.
- **Experts** who need to inspect provider, model, cost, latency, tool, memory, and policy behavior, and who expect compressed, inspectable controls rather than hidden ones.

Progressive disclosure serves all three: beginners never face expert fields by default, and experts never lose them.

## What it values

1. **Truth beats theater.** Roadmap, diagnostics, and partial support are never dressed as finished behavior. Experimental, compatibility-only, advisory, and manually governed things are labeled as such.
2. **Trust is a feature.** Every turn can show which model and provider ran, why they were selected, which tools and capabilities were available and used, where memory and context came from, which approvals were required, what persisted as evidence, and what still needs a human.
3. **One runtime, one Chat surface.** Planning, delegation, approvals, memory, tools, and governed Code Mode all live inside Chat; there are no separate Cowork or Code products.
4. **Human in the loop by default.** Risky actions, durable memory writes, code execution, external side effects, and capability activation stay visible and governed. Deny-wins policy, approval gates, path jails, allowlists, and auth boundaries cannot be overridden by documents or prompts.
5. **Safe iteration over heroic rewrites.** Small, validated, reversible changes that respect architecture boundaries.
6. **Cyberpunk, but legible.** Sharp and neon-lit only where readability, hierarchy, spacing, accessibility, and responsiveness are already secured.

## Surfaces

| Surface | Purpose |
| --- | --- |
| Chat | Conversation, drafting, planning, research, approvals, agentic work, artifacts, and code-capability context |
| Inbox | Every decision waiting on the operator, in one list |
| Work | Operational tasks and runs |
| Library | Skills, memory, files, artifacts, and capability evidence, with provenance |
| System | Runtime health, activity, cost, diagnostics, backups, and release proof |
| Settings | Providers, models, tools, integrations, channels, auth, and workspace controls, in seven pages |

The cockpit is the default layout. The Classic shell remains only as an explicit rollback surface and receives no new product work.

## Voice

The product speaks to "you" in sentence case, with verbs on buttons and errors that say what happened and what to do next. The assistant says "I" only inside chat messages. Plain names come first and Citadel names second. Nothing claims hostile-code sandboxing, ungoverned autonomous activation, local-inference maturity, or proof that was not actually produced.

## Non-goals

- A generic chat wrapper with no runtime truth behind it.
- Separate Cowork or Code applications.
- Mission Control writing runtime files, databases, or skill directories directly.
- Any surface whose primary operator experience is raw JSON, raw event payloads, or an unbounded table.
- Supported provider surfaces for xAI, Grok, or X.
