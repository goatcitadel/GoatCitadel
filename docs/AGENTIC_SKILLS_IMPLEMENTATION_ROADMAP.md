# GoatCitadel Agentic Skills Implementation Roadmap

Last updated: 2026-04-01

## Purpose

This roadmap translates the adoption memo into repo-native implementation phases.

It deliberately avoids inventing a second skill runtime. The focus is to tighten the existing runtime systems and then expose them through clearer operator posture and lightweight skills.

## Phase 1: Tighten Policy and Approval Posture

### Objective

Make high-impact tool use more predictable, legible, and surface-aware without weakening the existing deny-wins model.

### Target packages and surfaces

- `packages/policy-engine`
- `packages/contracts/src/approvals.ts`
- `packages/contracts/src/tools.ts`
- `packages/storage` approval and audit repositories
- `apps/mission-control/src/pages/ApprovalsPage.tsx`
- `apps/mission-control/src/pages/ChatPage.tsx`
- `apps/mission-control/src/pages/OfficePage.tsx`
- `apps/mission-control/src/pages/SettingsPage.tsx`

### Success criteria

- Risky tool calls consistently surface the same policy reasoning across API, audit, and Mission Control.
- Approval-required behavior is easier to scan from Chat, Approvals, and Office.
- Surface posture is explicit:
  - Chat stays low-ceremony
  - Cowork/Office exposes workflow state and approval dependencies
  - Code remains stricter and proof-oriented

### Notable risks

- Over-tightening policy can make low-risk workflows annoying.
- Inconsistent copy between surfaces can reduce trust even when the policy behavior is correct.

### Explicit non-goals

- No new policy engine rewrite
- No new tool execution substrate
- No marketplace-driven trust model changes

## Phase 2: Strengthen Durable Run and Checkpoint Integration

### Objective

Make durable runs, approvals, and orchestration feel like one system instead of adjacent systems.

### Target packages and surfaces

- `packages/storage/src/durable-run-repo.ts`
- `packages/contracts/src/durable.ts`
- `packages/contracts/src/orchestration.ts`
- `packages/orchestration/src/engine.ts`
- `apps/mission-control/src/pages/ApprovalsPage.tsx`
- `apps/mission-control/src/pages/PromptLabPage.tsx`

### Success criteria

- Approval-paused work can be traced back to a durable run consistently.
- Resume-from-checkpoint behavior is visible and legible from operator surfaces.
- Orchestration runs and durable runs share clearer IDs, status mapping, or correlation conventions.

### Notable risks

- Status-model drift between orchestration and durable-run layers
- Added resume paths may expose edge cases in partial side-effect handling

### Explicit non-goals

- No general workflow-engine replacement
- No speculative long-horizon autonomy features beyond current approval and checkpoint semantics

## Phase 3: Improve Memory Retrieval and Distillation Quality

### Objective

Improve memory usefulness and reduce noisy recall without expanding memory scope irresponsibly.

### Target packages and surfaces

- `packages/memory-core/src/candidate-collector.ts`
- `packages/memory-core/src/candidate-ranker.ts`
- `packages/memory-core/src/context-composer.ts`
- `packages/memory-core/src/distiller.ts`
- `packages/contracts/src/memory.ts`
- `packages/contracts/src/learned-memory.ts`
- `packages/storage/src/sqlite.ts`
- `apps/mission-control/src/pages/MemoryPage.tsx`

### Success criteria

- Retrieved memory is more relevant and less repetitive.
- Distilled memory preserves facts, risks, open questions, and safer next steps in a stable format.
- Learned-memory conflicts are operator-visible and easier to resolve intentionally.

### Notable risks

- Aggressive ranking can hide useful but low-frequency context.
- Over-distillation can lose nuance that matters in later sessions.

### Explicit non-goals

- No uncontrolled long-term memory expansion
- No autonomous preference storage beyond existing consent and conflict boundaries

## Phase 4: Add Surface-Aware Routing and Activation Rules

### Objective

Make skills and orchestration respect the user’s current surface and posture.

### Target packages and surfaces

- `packages/skills/src/activation.ts`
- `packages/skills/src/loader.ts`
- `packages/contracts/src/skills.ts`
- `packages/contracts/src/chat.ts`
- `apps/mission-control/src/pages/ChatPage.tsx`
- `README.md` and operator-facing guidance docs as needed

### Success criteria

- Skill activation can reflect Chat, Cowork, and Code posture instead of treating every prompt as equivalent.
- Lightweight advisory skills are favored in Chat.
- Structured workflow and checkpoint-oriented skills are favored in Cowork.
- Verification and proof-oriented skills are favored in Code.

### Notable risks

- Overfitting activation rules can make skills harder to discover.
- Surface-aware activation can become too implicit if not explained well in UI.

### Explicit non-goals

- No global autonomous router that ignores user-visible mode
- No skill activation behavior that silently escalates into multi-agent orchestration

## Phase 5: Add Optional Structured Delegation

### Objective

Support advanced contract-based delegation where it improves results, while keeping it explicit and reviewable.

### Target packages and surfaces

- `packages/orchestration`
- `packages/contracts/src/agents.ts`
- `packages/storage/src/task-repo.ts`
- `packages/storage/src/task-subagent-repo.ts`
- `apps/mission-control/src/pages/OfficePage.tsx`
- `apps/mission-control/src/pages/DashboardPage.tsx`

### Success criteria

- Delegated work carries ownership, acceptance criteria, and visible state.
- Operator surfaces show blocked, waiting, active, and approval-bound work clearly.
- Structured delegation is optional and scoped, not the default answer to every task.

### Notable risks

- Coordination overhead can exceed the value of delegation on small tasks.
- Free-form multi-agent chatter can leak back in if contracts are weak.

### Explicit non-goals

- No general-purpose swarm mode by default
- No reputation-driven autonomous delegation in the first wave

## Sequencing Notes

Recommended order:

1. policy and approvals
2. durable run and checkpoint integration
3. memory retrieval and distillation
4. surface-aware routing and skill activation
5. optional structured delegation

Reason for this order:

- Policy and durability are the trust foundation.
- Memory becomes more valuable once long-running state is easier to reason about.
- Surface-aware activation should be added after the underlying systems are clearer.
- Delegation should remain a later opt-in capability, not an early architecture driver.

## Roadmap Guardrails

Across all phases:

- do not create a second plugin system
- do not treat runtime infrastructure as a `SKILL.md`
- do not weaken approval-required flows
- do not erase the distinction between Chat, Cowork, and Code
- do not ship experimental self-modifying or identity-persistence concepts in the first wave
