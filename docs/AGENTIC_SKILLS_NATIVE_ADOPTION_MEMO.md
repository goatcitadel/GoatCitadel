# GoatCitadel Agentic Skills Native Adoption Memo

Last updated: 2026-04-01

## Purpose

This memo turns two external research inputs into a GoatCitadel-native decision:

- a ChatGPT deep-research report on "truly agentic" skill systems
- a Perplexity report on modular agentic skill stacks

The goal is to keep the valuable ideas while aligning them to GoatCitadel's existing architecture, trust model, and operator surfaces.

## Executive Judgment

Both reports contain useful ideas. The ChatGPT report is the stronger fit for GoatCitadel because it prioritizes:

- policy and approval gates
- durable execution and checkpoints
- bounded memory and reflection
- explicit stop conditions
- multi-agent coordination as a controlled workflow, not a default mode

The Perplexity report is more speculative. It is useful as a pattern library and brainstorming input, but it over-rotates toward heavyweight "skill modules" and later-stage experimental concepts such as self-modifying prompt governance, reputation systems, and identity persistence.

## Core Framing Decision

GoatCitadel should adopt this boundary and keep it explicit:

- **Skills** are lightweight instruction and playbook artifacts loaded from `SKILL.md`.
- **Runtime systems** are policy, durability, orchestration, memory, and audit infrastructure.
- **Agentic workflows** are compositions of skills plus runtime systems.

GoatCitadel should not create a second plugin or module system that duplicates the current skill loader with per-skill orchestrators, executors, and memory adapters.

## Report Comparison

| Topic | ChatGPT report | Perplexity report | GoatCitadel decision |
| --- | --- | --- | --- |
| Overall fit | Stronger | Mixed | Prefer ChatGPT framing |
| Policy / approvals | Strong | Moderate | Adopt now |
| Durable execution | Strong | Strong | Adopt now |
| Memory / reflection | Strong | Strong | Adopt now, bounded |
| "Skill" packaging | Over-structured, but still grounded | Too heavyweight for GoatCitadel skill model | Reject as skill shape |
| Multi-agent workflows | Useful if contract-based | Useful but more framework-shaped | Adapt later |
| Self-improving / self-modifying layers | Experimental and clearly labeled | More eager to productize | Defer |
| Reputation / identity persistence | Minimal | Heavy emphasis | Reject for first wave |

## What GoatCitadel Can Use Now

### 1. Tight policy and approval posture

Use now because GoatCitadel already has a real policy engine, approval gates, risk classification, and audit behavior.

Repo-native mappings:

- `packages/policy-engine`
- `packages/contracts/src/approvals.ts`
- `packages/contracts/src/tools.ts`
- `packages/storage` approval and audit repositories
- Mission Control surfaces:
  - `apps/mission-control/src/pages/ApprovalsPage.tsx`
  - `apps/mission-control/src/pages/ChatPage.tsx`
  - `apps/mission-control/src/pages/OfficePage.tsx`
  - `apps/mission-control/src/pages/ToolsPage.tsx`

Adopted principle:
- "Agentic" behavior must remain subordinate to explicit operator review for risky actions.

### 2. Durable runs, checkpoints, and resumability

Use now because GoatCitadel already stores durable run state and checkpoints and already exposes human-in-the-loop orchestration semantics.

Repo-native mappings:

- `packages/storage/src/durable-run-repo.ts`
- `packages/contracts/src/durable.ts`
- `packages/contracts/src/orchestration.ts`
- `packages/orchestration`
- Mission Control surfaces:
  - `apps/mission-control/src/pages/ApprovalsPage.tsx`
  - `apps/mission-control/src/pages/PromptLabPage.tsx`

Adopted principle:
- Long-running autonomy only counts if it can pause, resume, explain what is blocked, and avoid replaying unsafe side effects.

### 3. Memory retrieval, distillation, and conflict handling

Use now because GoatCitadel already has memory candidate collection, ranking, distillation, and learned-memory conflict concepts.

Repo-native mappings:

- `packages/memory-core`
- `packages/contracts/src/memory.ts`
- `packages/contracts/src/learned-memory.ts`
- `packages/storage/src/sqlite.ts`
- Mission Control surfaces:
  - `apps/mission-control/src/pages/MemoryPage.tsx`
  - `apps/mission-control/src/pages/SystemPage.tsx`

Adopted principle:
- Memory should remain bounded, cited, and conflict-aware instead of becoming a silent long-term dumping ground.

### 4. Surface-aware posture for Chat, Cowork, and Code

Use now because GoatCitadel is explicitly one shell with different operating modes, not one global autonomy stance.

Repo-native mappings:

- `README.md` operator mode definitions
- `apps/mission-control/src/pages/ChatPage.tsx`
- `packages/contracts/src/chat.ts`
- `packages/contracts/src/skills.ts`
- `packages/skills`

Adopted principle:

- `Chat`: lightweight, immediate, low-ceremony, minimal autonomous branching
- `Cowork`: visible orchestration, checkpoints, decomposition, approvals, structured delegation
- `Code`: correctness-first, proof-oriented, bounded autonomy, explicit validation

### 5. Structured delegation as an optional advanced workflow

Use later, not first, because GoatCitadel already has orchestration primitives and operator-facing task/agent surfaces, but structured delegation should remain opt-in and contract-based.

Repo-native mappings:

- `packages/orchestration`
- `packages/contracts/src/agents.ts`
- `packages/storage/src/task-subagent-repo.ts`
- `packages/storage/src/task-repo.ts`
- Mission Control surfaces:
  - `apps/mission-control/src/pages/OfficePage.tsx`
  - `apps/mission-control/src/pages/DashboardPage.tsx`

Adopted principle:
- Multi-agent work should look like accountable handoffs with acceptance criteria, not free-form "agent chat soup."

## Adapt Later

These ideas are promising but should be adapted to GoatCitadel instead of copied directly:

- uncertainty-aware tool routing
- reflection that produces bounded, reviewable guidance
- plan quality scoring and re-planning heuristics
- selective adversarial review for high-stakes workflows

Why "adapt later":

- GoatCitadel already has real runtime packages for the hard parts
- the missing work is integration quality, posture rules, and operator UX
- a fresh "agentic skill stack" abstraction would increase complexity without adding trust

## Reject or Treat as Not Skill-Shaped

These ideas should not be implemented as first-wave GoatCitadel skills:

- a second skill runtime with per-skill orchestrator/executor/memory code bundles
- heavyweight skill folders that behave like capability plugins
- self-modifying prompt governance
- autonomous skill synthesis that writes live runtime capabilities without strict review
- global agent reputation scoring as a routing primitive
- identity or personality persistence as a core autonomy layer
- any cross-surface autonomy model that ignores Chat, Cowork, and Code posture differences

Why rejected:

- they do not fit GoatCitadel's current `SKILL.md` system
- they increase operator surprise
- they blur instruction artifacts with executable runtime infrastructure
- they introduce high-risk governance questions before first-wave reliability work is complete

## Already-Existing GoatCitadel Primitives

GoatCitadel already has concrete runtime primitives that overlap the strongest parts of the research:

- approval-gated tools
- durable runs and checkpoints
- orchestration plans and HITL mode
- learned memory items and conflicts
- skill import validation, trust states, and activation state

This means the immediate opportunity is not "invent more agentic architecture." The immediate opportunity is:

- tighten composition between existing packages
- improve operator-facing proof and control
- make surface defaults more consistent
- keep skill design lightweight and legible

## Non-Goals

This adoption cycle does **not** aim to:

- create a second plugin system
- turn skills into code-heavy runtime modules
- ship a self-modifying agent layer
- create a universal autonomy mode shared equally across Chat, Cowork, and Code
- replace GoatCitadel's trust/import/approval posture with framework defaults from external ecosystems

## Recommended Direction

Use the ChatGPT report as the architecture input and the Perplexity report as a controlled source of patterns and terminology.

The right GoatCitadel interpretation is:

- skills stay lightweight
- runtime stays explicit
- orchestration stays reviewable
- autonomy stays bounded by surface posture and approval policy
