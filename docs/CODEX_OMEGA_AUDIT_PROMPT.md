# Codex Omega++ Audit Prompt (GoatCitadel)

Use this in Codex for a repo-specific structural truth, state ownership, event integrity, operator trust, maintainability, and future platform readiness audit.

This prompt is intentionally not a generic "review the codebase" prompt. It is tuned to GoatCitadel as it exists in this repository today.

---

```text
You are performing a repo-specific Omega++ audit of GoatCitadel.

Repo root: F:\code\personal-ai
Platform: Windows + PowerShell
Mode: READ-ONLY (no file edits)

This is not a basic production-readiness pass.
A prior review has likely already covered:
- bugs
- correctness
- reliability
- performance
- testing gaps
- basic security posture
- production-readiness defects

Do not spend output budget repeating that work unless a conventional defect is directly relevant to:
- truthfulness
- authority boundaries
- state ownership
- event integrity
- replay/audit semantics
- maintainability
- operator trust
- future connector/platform survivability

Your job is to determine whether GoatCitadel is becoming:
- a truthful, coherent, supportable, extensible operator platform
or
- a system that increasingly looks more capable and authoritative than its runtime semantics justify

Treat GoatCitadel as a real multi-surface control plane, not a chat app.

Current repo context you must ground in before judging:
- public beta posture from README and docs
- Mission Control shell spaces: Operate, Observe, Configure
- current primary surfaces: Chat, Cowork, Code, Tasks, Approvals, Activity, Sessions, Artifacts, Costs, System, Quality
- runtime/apps: apps/gateway, apps/mission-control, apps/npu-sidecar
- shared packages: contracts, storage, orchestration, gateway-core, memory-core, policy-engine, mesh-core, skills, extensions-sdk
- current truth boundaries called out in docs: partial memory lifecycle, partial replay-driven quality loops, partial proactive workflows, missing mobile companion

You are not reviewing for style.
You are reviewing for:
- conceptual honesty
- system story vs system reality
- state ownership clarity
- event truth integrity
- replay/history truthfulness
- cross-surface coherence
- supportability under pressure
- maintainability and reasoning cost
- connector/platform scaling readiness

Operate like a blend of:
- principal engineer
- product systems architect
- SRE
- support escalation investigator
- future maintainer with zero folklore context
- operator who needs to trust the system's claims

Your standard is not:
"Does this work?"

Your standard is:
"Would I trust this system's claims, states, histories, approvals, and operator surfaces under growth, failure, reconnect, restart, and future connector expansion?"

## Non-Negotiable Analysis Rules

1. Never confuse UI confidence with runtime confidence.
2. Never confuse product naming with engineering truth.
3. Never confuse events with canonical facts.
4. Never confuse stored history with trustworthy auditability.
5. Never confuse shared code with shared semantics.
6. Never confuse flexibility with clarity.
7. Never assume current engineers will remember hidden assumptions later.
8. Never flatten authoritative records, derived projections, activity signals, UI summaries, heuristics, caches, and telemetry into one class of truth.
9. Never stop at "it works today."
10. Prioritize truth over elegance.

## Shallow-Analysis Failure Conditions

If you do any of the following, your audit is incomplete:
- make major claims without file/path evidence
- describe GoatCitadel at a generic platform level without tying findings to actual repo modules
- treat README/docs language as proof of runtime semantics
- rely on directory names, wildcard labels, or "if present" placeholders without resolving them to actual current files
- collapse authoritative state and projections together
- discuss replay/history without distinguishing replay-for-display vs replay-for-behavior
- discuss approvals without distinguishing approval display vs approval enforcement
- discuss surface consistency without comparing UI, gateway, contracts, storage, and docs
- produce recommendations that cannot be mapped to concrete layers or files

If a section cannot be proven from the repo, say so explicitly and downgrade confidence.

## Mandatory Repo-Grounding Pass Before Findings

Before producing findings, inspect and use evidence from these sources:

### Documentation and product story
- README.md
- docs/VISION_STATUS_MATRIX.md
- docs/A2UI_CONTRACT.md
- docs/COMPANION_CONTRACT.md
- docs/AGENTIC_FEATURE_GAP_MATRIX.md

### Mission Control shell, routing, and operator semantics
- apps/mission-control/src/content/page-registry.ts
- apps/mission-control/src/content/copy.ts
- apps/mission-control/src/App.tsx
- apps/mission-control/src/api/client.ts
- apps/mission-control/src/state/event-stream-status-store.ts

### Operator surfaces that most directly express system truth
- apps/mission-control/src/pages/ApprovalsPage.tsx
- apps/mission-control/src/pages/SystemPage.tsx
- apps/mission-control/src/pages/SessionsPage.tsx if present
- apps/mission-control/src/pages/Activity* if present
- apps/mission-control/src/pages/chat/*
- apps/mission-control/src/pages/*Quality* and prompt-pack related pages if present

### Gateway routes that define surface/runtime boundaries
- apps/gateway/src/routes/chat.ts
- apps/gateway/src/routes/approvals.ts
- apps/gateway/src/routes/durable.ts
- apps/gateway/src/routes/events.ts
- apps/gateway/src/routes/memory.ts
- apps/gateway/src/routes/sessions-list.ts
- apps/gateway/src/routes/improvement.ts
- apps/gateway/src/routes/orchestration.ts
- apps/gateway/src/routes/connectors.ts
- apps/gateway/src/routes/tools-invoke.ts

### Gateway services that likely own runtime semantics
- apps/gateway/src/services/gateway-service.ts
- apps/gateway/src/services/prompt-pack-service.ts
- apps/gateway/src/services/memory-maintenance-service.ts
- apps/gateway/src/services/mcp-approval-inbox.ts
- packages/gateway-core/src/event-ingest.ts

### Shared contracts that define cross-surface meaning
- packages/contracts/src/approvals.ts
- packages/contracts/src/durable.ts
- packages/contracts/src/replay.ts
- packages/contracts/src/session.ts
- packages/contracts/src/monitoring.ts
- packages/contracts/src/memory.ts
- packages/contracts/src/prompt-pack.ts
- packages/contracts/src/policy.ts
- packages/contracts/src/connectors.ts

### Storage repositories that likely reveal canonical state vs projections
- packages/storage/src/approval-repo.ts
- packages/storage/src/approval-event-repo.ts
- packages/storage/src/approval-inbox-repo.ts
- packages/storage/src/pending-approval-action-repo.ts
- packages/storage/src/chat-inline-approval-repo.ts
- packages/storage/src/durable-run-repo.ts
- packages/storage/src/realtime-event-repo.ts
- packages/storage/src/realtime-stream-lease-repo.ts
- packages/storage/src/transcript-outbox-repo.ts
- packages/storage/src/chat-turn-trace-repo.ts
- packages/storage/src/chat-stream-event-repo.ts
- packages/storage/src/session-repo.ts
- packages/storage/src/chat-session-meta-repo.ts
- packages/storage/src/chat-session-prefs-repo.ts
- packages/storage/src/memory-maintenance-repo.ts
- packages/storage/src/memory-context-repo.ts
- packages/storage/src/memory-qmd-run-repo.ts

You may inspect additional files, but you must not skip these categories.

## Path Resolution and Repo-Drift Rules

- If a listed file has moved or been renamed, you must find the current equivalent with repo search and cite the substitute path explicitly.
- Do not use a wildcard or directory reference as your final evidence when an exact file can be resolved.
- If a listed category no longer appears to exist, say that explicitly and treat the absence itself as evidence where relevant.
- If GoatCitadel lacks a single canonical architecture/state/event document, treat that as a first-order finding rather than silently inventing a canonical story.

## Evidence Contract

For every major finding:
- cite the exact file paths used
- cite the exact route, service, store, contract, repo, or page involved
- cite exact files, not just folders, for all top-ranked findings
- separate:
  - Observed: directly supported by code/docs inspected
  - Inferred risk: likely consequence of observed structure
  - Unknown: what cannot currently be proven

For any top-10 ranked finding:
- provide at least 2 evidence points
- if the finding is cross-surface, include evidence from at least 2 layers among:
  - UI
  - gateway/runtime
  - contracts
  - storage
  - docs

Do not invent capabilities, hidden files, or unstated guarantees.
If the repo contains competing semantics rather than one coherent model, name each competing model, where it lives, and which layers reinforce it.

## Critical Distinctions You Must Enforce Throughout

- authoritative state vs derived projection vs cached state
- domain fact vs event envelope vs activity signal vs UI summary vs telemetry artifact
- replay for display vs replay for behavior
- approval display vs approval enforcement
- durable record vs best-effort trace
- surface consistency vs surface-specific local truth
- implemented capability vs partial capability vs aspirational language
- causal linkage vs narrative convenience

## Required End-to-End Flow Tracing

Trace these flows end-to-end and compare expected behavior vs actual semantics:
- Chat / Cowork / Code run lifecycle
- approval creation, decision, enforcement, replay, and auditability
- session continuity and history inspection
- live feed / event stream / activity rendering
- durable runs and restart behavior
- memory/context assembly, browsing, maintenance, forgetting, provenance
- prompt-pack / quality / replay-driven loops
- integrations/connectors/channel delivery paths

For each traced flow, identify:
- authoritative record(s)
- derived projection(s)
- UI summary layer(s)
- event stream(s)
- enforcement boundary
- replay/resume semantics
- restart/reconnect behavior
- most likely operator misunderstanding

## Required Audit Domains

### 1. System Story vs System Reality
- Reconstruct what GoatCitadel claims in README/docs and what it actually supports.
- Identify where product language outruns runtime semantics.
- Identify where the system is most honest and where it is overselling itself.

### 2. Conceptual Integrity and Vocabulary Drift
- Analyze core concepts including: run, session, event, action, task, step, approval, request, decision, feed item, history entry, message, memory, context, orchestration state, replay, restore, resume, status.
- Find duplicated concepts, overloaded terms, and unclear ownership.
- Decide whether each major issue requires merge, split, rename, or re-owning.

### 3. State Ownership Audit
For every critical domain, identify:
- canonical owner
- projection holders
- mutation points
- persistence class
- restart/reconnect behavior
- cross-surface drift risk
- authority confidence score

Cover at minimum:
- run lifecycle state
- session state
- approval state
- event/history/feed state
- UI projection state
- memory/context state
- replay/restoration state
- connector/client-related state
- pending/in-flight work

### 4. Event Truth Audit
For major event classes, identify:
- origin
- semantic class
- fact / hint / projection / mixed classification
- ordering assumptions
- replay suitability
- audit suitability
- causal linkage quality

Separate:
- domain events
- transport events
- UI/activity events
- audit events
- telemetry/noise

Identify where event history looks authoritative but is not.

### 5. Replay, Restoration, Resume, and Auditability
- Determine what can actually be reconstructed, resumed, replayed, or merely redisplayed.
- Separate replay-for-display from replay-for-behavior.
- Identify where histories, traces, or feeds imply more determinism than exists.

### 6. Mission Control Truth vs Theater
- Evaluate Mission Control as an operator surface, not just UI.
- Determine where it is trustworthy and where it compresses ambiguity into false confidence.
- Focus on status signals, live views, activity feed, sessions, system, approvals, artifacts, and quality surfaces.

### 7. Gatehouse / Approvals / Trust Boundaries
- Treat approvals as a system primitive, not a feature widget.
- Review request creation, decision lifecycle, enforcement linkage, replayability, auditability, cross-surface consistency, and post-approval traceability.
- Determine whether approvals are enforceable truth or partially representational.

### 8. Cross-Surface Coherence
- Compare Mission Control claims with gateway/runtime truth, storage truth, contracts truth, and docs truth.
- Determine whether GoatCitadel is:
  - one coherent system with multiple views
  - one runtime with competing projections
  - or multiple semantic islands wearing the same brand

### 9. Memory / Context Lifecycle Truth
- Review memory and context as a trust and explainability problem.
- Identify what memory means in practice, what is durable vs heuristic, what is operator-visible, what can stale silently, and where scope boundaries are weak.

### 10. Maintainability and Reasoning Cost
- Identify areas that are hard to trace, hard to change safely, or dependent on folklore.
- Focus on distributed logic, unclear ownership, over/under abstraction, duplicated derivation logic, and hidden lifecycle semantics.

### 11. Human Failure Modes and Supportability
Simulate real support/operator confusion:
- "It said complete but didn't do anything."
- "I approved it and nothing happened."
- "Chat and Mission Control disagree."
- "The history looks clear but I still can't tell what happened."

Identify which current behaviors invite these tickets.

### 12. Connector / Client / Platform Stress Audit
- Stress the current model against 3 new equally important connectors/clients.
- Identify non-portable contracts, UI-bound semantics, current-surface privilege, and assumptions that will fork instead of scale.

### 13. Complexity Growth and Calcification
- Identify patterns that work today but will rot under more state, more surfaces, more connectors, and more partial implementations.
- Call out what must not absorb more complexity before cleanup.

### 14. Naming, Semantic Signaling, and Documentation Truth
- Audit naming across services, stores, statuses, docs, events, routes, and UI labels.
- Identify names that imply canonicality or durability not actually present.
- Identify README/docs claims that should be tightened.

### 15. Authority Class Separation
- Explicitly classify major system artifacts as:
  - authoritative record
  - derived projection
  - activity signal
  - UI summary
  - heuristic
  - cache
  - telemetry artifact
- Find where these classes are currently blended.

### 16. Event Taxonomy Cleanup
- Determine whether GoatCitadel currently needs or already partially has categories such as:
  - domain events
  - transport events
  - UI events
  - audit events
  - telemetry events
  - lifecycle events
- Identify where the taxonomy is muddy enough to create downstream drift.

### 17. State-Machine / Lifecycle Formalization
- Identify critical flows that currently behave like soft state machines spread across conditionals.
- Call out lifecycle gaps that should become explicit contracts or state machines.

### 18. Uncertainty Signaling
- Identify where operator-facing surfaces should say "observed", "derived", "inferred", "stale", "partial", or "unknown" instead of presenting a clean but misleading answer.

### 19. Causal Chain Integrity
- Evaluate whether GoatCitadel can clearly tie together:
  request -> approval -> action -> event -> projected state -> displayed history
- Identify where the chain breaks, blurs, or becomes unprovable.

### 20. Incident Explainability
- Determine whether GoatCitadel can explain itself truthfully after weirdness.
- This is not generic logging review; focus on forensic clarity, causal linkage, and operator-trust recovery.

## Required Deliverables

You must include every section below. Keep them concrete and directly actionable.

1. **System Story vs System Reality**
   - Include: claimed behavior, observed implementation, divergence, severity, smallest corrective move.

2. **Evidence Ledger**
   - Columns:
     - ID
     - Finding
     - Observed evidence
     - Inferred risk
     - Unknown / unprovable
     - Confidence
     - Why it matters

3. **Authority Map**
   - Explicitly map major artifacts as:
     - authoritative record
     - derived projection
     - UI summary
     - cache
     - heuristic
     - telemetry artifact
   - Include:
     - artifact / concept
     - owning layer
     - readers
     - mutation points
     - drift risk
     - recommendation

4. **State Ownership Matrix**
   - Columns:
     - domain
     - state type
     - canonical owner
     - secondary/derived holders
     - mutation points
     - persistence class
     - restart/reconnect behavior
     - drift risk
     - authority confidence
     - recommendation

5. **Event Truth Matrix**
   - Columns:
     - event class
     - origin
     - intended meaning
     - actual semantic role
     - fact / hint / projection / mixed
     - ordering assumptions
     - replay suitability
     - audit suitability
     - causal linkage quality
     - risk
     - recommendation

6. **False Confidence Matrix**
   - Columns:
     - ID
     - area
     - false confidence pattern
     - expected assumption
     - actual reality
     - risk
     - recommendation
     - severity
     - confidence

7. **Mental Model Mismatch Report**
   - For each major mismatch, include:
     - what a reasonable operator/new engineer assumes
     - what the repo actually does
     - where the wrong assumption comes from
     - smallest high-leverage fix

8. **Surface Truthfulness Review**
   - Separate sections for:
     - Mission Control
     - Chat
     - Cowork
     - Code
     - Gatehouse / Approvals
     - Prompt Lab / Quality
     - memory/context surfaces
     - history/replay/audit surfaces
   - For each:
     - what it implies
     - what it actually guarantees
     - where it is honest
     - where it is theater or misleading compression
     - top corrective actions

9. **Semantic Consolidation Map**
   - Include:
     - duplicated / overloaded concepts
     - where they live
     - conflicting meanings
     - if meanings truly compete rather than drift, name the competing models directly
     - merge/split/rename/re-own recommendation
     - recommended canonical vocabulary

10. **Claim Honesty Ledger**
    - Columns:
      - claim from docs/UI/product language
      - actual implementation state
      - confidence
      - safe wording that would be truthful today

11. **Maintainability Risk Matrix**
    - Columns:
      - ID
      - area
      - risk type
      - why it will hurt later
      - trigger for pain
      - future cost
      - recommendation
      - urgency
      - confidence

12. **Likely Support Tickets**
    - At least 10.
    - For each:
      - realistic complaint
      - probable root cause
      - affected subsystem
      - why the system invited this misunderstanding
      - best structural fix
      - best short-term mitigation

13. **Causal Chain Breakage Table**
    - Trace where request -> approval -> action -> event -> projection -> displayed history loses fidelity.

14. **Lifecycle Formalization Candidates**
    - Identify flows that most need explicit state machines or stricter lifecycle contracts.
    - For each:
      - current soft lifecycle
      - failure mode
      - recommended formalization target
      - best owning layer

15. **Docs Drift Risk List**
    - What is likely to become misleading first and why.

16. **Do Not Build Further On This Yet**
    - List subsystems that should not absorb more features until semantics or ownership are cleaned up.

17. **Refactor Priority Ladder**
    - Buckets:
      - Clean Up Now
      - Clean Up Soon
      - Acceptable Debt
      - Do Not Touch Yet Without Broader Design Work

18. **Connector Stress Analysis**
    - Explicitly include:
      - what breaks if 3 connectors are added next quarter
      - which abstractions fork instead of scale
      - which current assumptions privilege web/Mission Control

19. **New Engineer Onboarding Audit**
    - Explicitly include:
      - what a new staff engineer next week would not understand without folklore
      - where contribution would be risky without tribal knowledge

20. **Merge / Split / Rename / Re-Own Recommendations**
    - For each major semantic issue, choose a concrete structural action.

21. **Remove Magic / Increase Explicitness Recommendations**
    - Identify where implicit conventions should become explicit contracts, states, or lifecycle rules.

22. **Top 10 Future Pain Multipliers**

23. **Top 10 Working-but-Dangerous Findings**

24. **Top 5 Fix-Before-Calcification Issues**
    - Explain the non-linear cost of waiting.

25. **Architecture Honesty Recommendations**
    - Highest-value changes that would most improve truthfulness, ownership clarity, auditability, and connector readiness.

26. **What Will Age Poorly**

27. **What the Project Can Honestly Claim Today**
    - Separate into:
      - truly implemented
      - partially implemented
      - aspirational

28. **Minimum Structural Cleanup Plan**
    - Propose the smallest high-leverage set of structural fixes that would most improve:
      - truthfulness
      - ownership clarity
      - auditability
      - future connector readiness
    - Include 5-8 items only.
    - For each item include:
      - objective
      - owning layer
      - concrete target files/modules
      - expected risk reduction
      - what feature work should wait on it

29. **Proof Obligations**
    - Identify what claims about GoatCitadel cannot currently be proven from code/runtime semantics.
    - For each include:
      - claim
      - why it is not provable today
      - what record/contract/event/test/trace would need to exist to prove it
      - which current layer is closest to owning that proof
      - whether the gap is missing instrumentation, missing contract, missing durable record, or missing lifecycle formalization

## Output Requirements

- Be adversarial but evidence-driven.
- Rank findings; do not just list them.
- Use file/path or subsystem references for every major claim.
- Separate observed facts from inferred risks.
- Assign severity and confidence.
- Do not collapse everything into generic "needs cleanup."
- Do not soften findings into politeness.
- Do not produce inline code comments; produce a report.
- Do not waste space on style or low-signal cleanup.
- Keep the report dense: use matrices for evidence-heavy sections, and avoid repeating the same warning in multiple sections.
- Spend the most detail budget on the top-ranked findings, the authority/state/event maps, the proof obligations, and the minimum structural cleanup plan.
- Every recommendation must identify the most plausible owning layer:
  - docs/product language
  - Mission Control UI
  - gateway route/service
  - shared contracts
  - storage/state model
  - policy/approval layer

## Final Direct-Answer Section

At the end, answer all of these directly:
- Where is GoatCitadel lying to itself?
- Where is it most honest?
- What are the biggest product-story vs runtime-truth mismatches?
- What are the biggest state ownership problems?
- What are the biggest event truth problems?
- Which events are facts, which are hints, and which are dangerously mixed?
- Which histories or feeds are authoritative, and which merely look authoritative?
- What parts of Mission Control are most trustworthy, and what parts feel like theater?
- Is Gatehouse a real trust-boundary primitive or a partially representational layer?
- What is hardest to understand?
- What is hardest to maintain?
- What will create support nightmares?
- What blocks clean platform scaling?
- What is real architecture vs platform cosplay?
- What must be cleaned up now?
- What must not get more complex yet?
- What should be merged?
- What should be split?
- What should be renamed?
- What should become more explicit and less magical?
- What can the project honestly claim today?
- What should docs/README stop claiming?
- What is GoatCitadel's actual current maturity level?
- Is GoatCitadel structurally becoming a trustworthy platform, or accumulating elegant confusion?
- What is your brutally honest final verdict?
```

## Operator Notes

- This prompt is intentionally stronger than the repo's production-readiness and performance review prompts.
- It is best used after a conventional correctness/reliability pass has already happened.
- If you want to constrain runtime cost, ask the reviewer to prioritize `README.md`, `docs/VISION_STATUS_MATRIX.md`, `apps/mission-control/src/content/page-registry.ts`, `apps/mission-control/src/api/client.ts`, `apps/gateway/src/routes`, `apps/gateway/src/services/gateway-service.ts`, `apps/gateway/src/services/prompt-pack-service.ts`, `packages/contracts`, and `packages/storage`.
