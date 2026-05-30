# GoatCitadel Product Improvement Review

Date: 2026-05-30

Scope: broad, report-only review of product gaps and improvement opportunities across the current GoatCitadel repo, with emphasis on `apps/mission-control-next`, gateway-owned runtime truth, docs, release evidence, and checked-in screenshots. This is not a bug report and no product code was changed.

## Method

I reviewed the canonical product docs, route taxonomy, native route owners, runtime truth docs, selected gateway surfaces, release evidence, visual baseline coverage, and checked-in Mission Control screenshots.

Primary evidence used:

- `docs/1_0_CONTRACT.md`
- `docs/CANONICAL_RUNTIME_STATE_MODEL.md`
- `docs/1_0_RELEASE_SURFACE_SCOPE.md`
- `docs/1_0_RELEASE_EVIDENCE.md`
- `apps/mission-control-next/src/app/route-model.ts`
- `apps/mission-control-next/src/app/MissionControlNextApp.tsx`
- `apps/mission-control-next/src/features/native-routes/**`
- `apps/mission-control-next/src/features/threaded-surface/workflow/CodeWorkbenchPanel.tsx`
- `apps/gateway/src/services/agentic-capability-availability.ts`
- `scripts/verification/lib/release-surface-manifest.mjs`
- `scripts/verification/baselines/visual/mission-control-next`
- `docs/screenshots/mission-control-next/*.png`

I did not run the app, browser flows, tests, or verification lanes for this review. The comments below are product opportunities inferred from code, docs, screenshots, and existing evidence.

## Executive Read

GoatCitadel's strongest product asset is already clear: it treats runtime truth, approvals, capabilities, memory, artifacts, and release evidence as first-class operator surfaces. That is much more differentiated than another polished chat box.

The main improvement frontier is not adding more routes. It is making the existing truth easier to act on. Several surfaces are structurally complete but still feel like evidence dashboards built by and for the implementation team. The product can become much stronger by turning raw state, catalogs, and proof artifacts into guided next actions.

The highest-leverage gaps are:

1. Chat's first-run and empty-session experience does not yet communicate the product's value.
2. Projects should become the intake and continuity hub for real work, not just an object manager.
3. Code has strong machinery but needs a clearer "review to ready" product loop.
4. Cowork should make durable execution more visually understandable as a plan, phase, and checkpoint graph.
5. Library should evolve from inspectable catalogs into action workbenches for capabilities, skills, memory, files, artifacts, and knowledge.
6. Ops has the ingredients for a release-proof command center, but some panes still expose runtime snapshots more than decisions.
7. Cost visibility needs real daily/provider time series, not just aggregate spend cards.
8. External writeback and A2A interoperability are truthfully marked as gaps and would be powerful strategic expansions if implemented through gateway-owned durable execution.
9. Add-ons should either graduate into a governed install lifecycle or remain clearly experimental until trust/provenance/operator controls are complete.
10. The desktop/mobile/installer story should be surfaced as continuity and control, not only platform support.

## Priority Map

| Priority | Opportunity | Why it matters | Likely owner |
|---|---|---|---|
| P0 | Make Chat useful before the first message | The checked-in Chat screenshot has a largely empty main canvas; the flagship fast path should immediately show readiness, context, and useful starters. | `apps/mission-control-next` Chat/threaded surface |
| P0 | Convert Projects into work intake | Projects are the natural bridge from "I have a folder/task/goal" to Chat, Cowork, Code, Library, and Ops proof. | Projects route plus gateway project/session APIs |
| P0 | Productize Code's review loop | Code already has workbench, file tree, diff, ledger, artifacts, and run log; the user-facing product loop should end in a clear review packet. | Code workbench plus durable Code Mode |
| P1 | Make Cowork execution understandable at a glance | Durable sessions are central, but users need a plan/phase/checkpoint mental model, not only task cards and logs. | Cowork native route plus durable execution summaries |
| P1 | Turn Library detail views into action cards | Capabilities, artifacts, knowledge, and files still lean on code blocks, previews, or JSON-like detail. | Library native routes |
| P1 | Build an in-app release proof dashboard | The repo has extensive release evidence; users need "what was proven on this build" without reading docs. | Ops release proof / diagnostics |
| P1 | Add cost time series and anomaly insight | The Costs route is designed for a chart, but current code notes that live cost responses lack daily series. | Gateway cost summary plus Ops costs UI |
| P1 | Make runtime controls actionable even when external | Ops shows start/stop/restart are externally owned; the UI should provide a concrete next handoff. | Ops runtime plus desktop/service manager |
| P2 | Add durable external writeback envelopes | Docs state integration writeback paths remain one-shot/non-resumable. Durable external side-effect tracking would make channels/integrations more trustworthy. | Gateway durable execution, integrations, audit |
| P2 | Add governed A2A interoperability | Runtime availability explicitly says A2A is unavailable. A first-class A2A bridge could map GoatCitadel tasks/artifacts into an ecosystem protocol. | Gateway protocols/contracts |
| P2 | Decide Add-ons product posture | Add-ons are experimental while SDK/scaffold work exists. The product should either graduate install/enable/trust flows or keep this clearly out of 1.0. | Settings Add-ons, extensions SDK, gateway add-on APIs |
| P2 | Make desktop/mobile continuity visible | Native Windows and mobile companion work are part of the product shape, but the continuity story could be more explicit in-app. | Desktop, Settings Access, channels/mobile |

## Surface Notes

### Chat

Current strength: Chat is correctly treated as the low-friction surface and shares the threaded runtime with Code/Cowork foundations.

Product gap: the default/empty experience is too quiet. The `docs/screenshots/mission-control-next/chat.png` shot shows a mostly blank main area, plus peripheral status/toast elements. That is honest, but it does not sell the user's first 30 seconds.

Suggested improvements:

- Add a compact first-run canvas with recent sessions, suggested prompts, provider/model readiness, memory/context status, and one-click "start from project" affordances.
- Show "what GoatCitadel knows right now" in plain language: selected provider, workspace, whether memory is active, available tool groups, and pending approvals.
- Include a low-noise "last useful things" panel: recent project, recent artifact, unresolved approval, and last Cowork or Code continuation.
- Keep advanced model/tool detail inspectable, but do not make the empty state feel like nothing is happening.

Why this matters: Chat is the doorway. If it feels blank, the rest of the operations console looks powerful but distant.

### Cowork

Current strength: Cowork has task lanes, deliverables, continuation, status, and durable-session orientation. It looks like a real supervised agentic workspace rather than a chat tab renamed "agents."

Product gap: the durable execution model is not yet visually obvious enough. The user should be able to answer, at a glance: What is the plan? Which phase is active? What changed since I last looked? What is blocked? What can I approve or redirect?

Suggested improvements:

- Add a plan graph or phase timeline that sits above task lanes and uses durable run/checkpoint truth.
- Show "last checkpoint" and "next checkpoint" as first-class cards.
- Make blocked, waiting, retrying, and resumed states visually distinct without requiring log inspection.
- Add a synthesis integrity panel: sources used, child runs delegated, contradictions found, confidence, and remaining human judgment.
- Provide a "resume with constraints" control so the operator can restart durable work with new boundaries without re-explaining the whole task.

### Code

Current strength: Code is already a serious workbench. `CodeWorkbenchPanel.tsx` includes file tree, Monaco editor, diff tabs, run log, artifact inspection, Code Mode ledger references, source selection, and run comparison.

Product gap: the workbench has the pieces of a strong implementation product, but the product endpoint should be more explicit. A user should finish a Code session with a review-ready packet: changed files, intent, validation, risks, rollback, artifacts, and remaining questions.

Suggested improvements:

- Add a "Review packet" tab that composes patch intent, file diffs, tests run, tests skipped, artifact hashes, approvals, branch state, and residual risk.
- Add validation presets tied to repo evidence, not just generic commands: for this repo that might mean `verify:surface:regression`, `verify:fast`, `docs:check`, `git diff --check`, or package-focused lanes.
- Parse test output into structured status cards instead of leaving the run log as the primary proof.
- Improve first source binding. The screenshot copy says a code source is required once per session; make this feel like selecting a target workspace with remembered defaults, recent repos, branch awareness, and trust posture.
- Add a "ready to publish" checklist that stays honest about dirty trees, untracked artifacts, stale screenshots, and remote SHA parity.

### Projects

Current strength: the Projects route has create/edit/pin/archive behavior and session creation. It can become the product's organizing spine.

Product gap: Projects still read like a management table plus details view. They should be the fastest path from a user's real-world goal to the right GoatCitadel surface.

Suggested improvements:

- Add project intake flows: import a local folder, connect a repo, start from a document, continue recent work, or create a project from a Chat/Cowork/Code session.
- Make project readiness visible: provider configured, memory scope attached, default model, linked files, active sessions, open approvals, latest artifacts, and verification debt.
- Add "start modes" from the project home: ask, plan, implement, review, research, summarize, and release-proof.
- Let Projects surface stale or missing evidence: last validation, last screenshot, last release proof, last successful durable run.

### Library

Current strength: Library is unusually complete for a local-first AI console. It covers skills, capabilities, memory, files, artifacts, knowledge, agents, and prompt packs.

Product gap: several Library sections are still closer to "inspect the raw thing" than "understand and act on the thing." This is visible in code blocks and JSON-style detail across capabilities, artifacts, files, knowledge, and skills.

Evidence examples:

- `LibraryCapabilitiesSection.tsx` renders "Technical detail" using structured JSON.
- `LibraryArtifactsSection.tsx` renders artifact provenance and content as code blocks.
- `LibraryKnowledgeSection.tsx` and `LibraryFilesSection.tsx` primarily preview text content.
- `LibrarySkillsSection.tsx` necessarily exposes instruction bodies, mutation diffs, evidence, lifecycle truth, and capability proposals, but the operator action model could be clearer.

Suggested improvements:

- Capabilities: add "why available/unavailable", "risk level", "trust source", "activation path", "recent usage", and "safe starter" cards before technical detail.
- Artifacts: add type-aware viewers, artifact timeline, compare-to-previous, export/share, source session, validation status, and "use in Chat/Cowork/Code" actions.
- Knowledge: add ingestion health, retrieval test, stale source detection, source-to-answer trace, and attach-to-project flows.
- Files: add upload/import/link-to-project/bulk organize flows. Template creation is useful but not enough for a personal workspace.
- Skills: add a guided lifecycle lane from draft to validated to callable, with proposal review, test run, rollback, and provenance in one place.

### Ops

Current strength: Ops has the right product center of gravity: runtime health, sessions, approvals, schedules, costs, diagnostics, notifications, activity, improvement, and release proof.

Product gap: Ops sometimes feels like a set of runtime snapshots rather than a command center for decisions. The product should answer "what should I do now?" as strongly as it answers "what is the state?"

Suggested improvements:

- Add an Ops home that groups signals into decisions: urgent approvals, degraded providers, stale durable runs, missing proof, spend anomalies, failed backups, and channel delivery risk.
- Promote release evidence into an in-app "Release proof certificate" with build identity, route coverage, verification lanes, screenshot freshness, docs alignment, and known accepted debt.
- For runtime controls that are external-service-manager owned, show a concrete handoff: command to run, desktop control to open, service name, current owner, and why Mission Control cannot directly restart it.
- Add a "posture diff since last run" panel: what changed in runtime health, costs, routes, capabilities, and docs proof since the previous evidence snapshot.

Costs deserve a specific callout. `RuntimeRoutePage.tsx` has chart UI for stacked daily spend, but comments explain that the live cost response does not yet expose per-day time series. This is a prime product gap because cost trust is part of the core thesis.

Suggested cost improvements:

- Add `dailySeries` to the cost summary contract and gateway response.
- Show provider/model/day breakdowns, unknown-price coverage, anomalies, and budget threshold warnings.
- Link spend back to sessions, tools, prompt packs, and durable runs.

### Settings

Current strength: Settings is broad and real: providers, models, tools, MCP, integrations, channels, runtime, budget, permissions, onboarding, access, workspaces, add-ons, personalities, and general settings are all represented.

Product gap: breadth creates setup fatigue. The route should feel like progressive configuration journeys, not a dense control deck where every section competes for attention.

Suggested improvements:

- Add guided setup paths: "Get first chat working", "Set up governed Code", "Enable channels", "Prepare release proof", "Connect local workspace", and "Harden privacy."
- Convert onboarding into an outcome flow that ends with a proof artifact and first useful project/session.
- Group risky controls by policy boundary: providers, tool grants, path jails, memory writes, channel side effects, and Code Mode execution.
- Keep raw controls available for advanced operators, but make the default path task-oriented.

### Prompt Packs

Current strength: Prompt Packs has a dedicated workbench route through `LazyPromptPacksWorkbenchPage`, API wrappers, tests, visual baselines, and a rich UI variant for Library/Ops contexts. It should not be treated as a missing surface.

Product opportunity: Prompt Packs could become the product's "behavior QA" layer, not just a prompt library.

Suggested improvements:

- Show prompt pack quality as a release signal in Ops.
- Connect pack tests to provider/model drift and cost changes.
- Let Chat/Cowork/Code show which prompt pack or behavior profile shaped an answer.
- Provide "promote to skill" or "attach to project" flows when a prompt pack stabilizes into repeatable work.

## Cross-Cutting Product Gaps

### 1. Truth Is Present, But Next Action Is Often Weak

GoatCitadel is good at showing truth. The next step is making truth actionable. Every high-signal state should answer:

- Why am I seeing this?
- Is it safe?
- What changed?
- What can I do next?
- What proof will be produced if I do it?

### 2. Empty States Are Honest, But Not Yet Productive

The empty-state posture is mostly truthful, which is good. Some surfaces should now move from "nothing here" to "start the right kind of work."

The most important empty states to upgrade are Chat, Projects, Code source binding, Knowledge, Files, and first-time Ops proof.

### 3. Raw Technical Detail Should Become Secondary

Raw JSON, code blocks, previews, and debug records should remain available, but they should not be the main operator UI for product-critical entities. Capability, artifact, skill, memory, and release-proof views should lead with interpreted cards and only then expose raw detail.

### 4. Runtime Proof Should Become User Proof

The repo has an impressive verification culture. The product can expose that advantage by turning docs and proof lanes into in-app, human-readable certificates.

Potential certificate sections:

- build identity
- route coverage
- visual screenshot freshness
- docs alignment
- runtime truth checks
- durable recovery checks
- Code Mode trust boundaries
- accepted debt
- stale or missing evidence

### 5. Interoperability Should Be Additive And Governed

`agentic-capability-availability.ts` truthfully marks A2A protocol interoperability as unavailable and lists missing Agent Cards, discovery routes, JSON-RPC handlers, task lifecycle, streaming, push notifications, and auth scoping.

This is a good gap, not a failure. A2A would be valuable only if it maps into GoatCitadel's existing strengths: durable execution, approvals, audit, policy, artifacts, and operator-visible state. It should not bypass the gateway or become an MCP alias.

### 6. External Writebacks Need Durable Side-Effect Truth

`CANONICAL_RUNTIME_STATE_MODEL.md` states that external writeback sessions remain visible operator sessions, but integration send/retry/edit/stream lanes are still one-shot paths outside durable replay/resume.

Suggested direction:

- Introduce durable external writeback envelopes.
- Record side-effect intent, approval, destination, payload hash, send status, retry state, edit status, and operator override.
- Allow replay/resume only through gateway-owned policy and idempotency guards.
- Surface external side effects in Ops, Activity, session timelines, and project evidence.

### 7. Add-ons Need A Clear Graduation Bar

Add-ons are currently experimental in the release surface while SDK/scaffold and gateway APIs exist. The product should define the graduation criteria:

- catalog provenance
- install review
- permission grants
- enable/disable truth
- version and update path
- rollback/uninstall
- runtime health
- operator-visible logs
- security posture
- marketplace or local-only claim boundary

Until that is complete, keep public claims conservative.

### 8. Desktop And Mobile Should Feel Like Continuity

Native Windows hosting, installer paths, and mobile companion work are part of the product shape. The product opportunity is to present this as continuity:

- start on desktop, approve on mobile
- inspect runtime health from mobile
- share into a project/session
- see desktop service state
- hand off Code/Cowork results back to desktop
- make auth/device trust explicit

## Suggested Sequencing

### Phase 1: Improve First Contact And Trust Translation

Goal: make the current product feel immediately useful without changing core architecture.

Recommended work:

- Chat first-run canvas.
- Project intake and "start modes."
- Code review packet.
- Library action cards for capabilities and artifacts.
- Ops release-proof certificate read-only view.
- Cost UI fallback copy that clearly says time series are not yet available.

Why first: these changes convert existing truth into visible product value and can be scoped to Mission Control plus existing APIs.

### Phase 2: Tighten Workflow Continuity

Goal: make long-running work easier to resume, inspect, and finish.

Recommended work:

- Cowork phase/checkpoint graph.
- Code validation presets tied to repo proof lanes.
- Project readiness and evidence debt.
- Knowledge ingestion/retrieval health.
- Costs dailySeries contract and gateway implementation.
- Runtime action handoffs for externally managed services.

Why second: these changes deepen the product loop and start adding small contract/runtime extensions where the UI is already asking for data.

### Phase 3: Expand Governed Interoperability

Goal: let GoatCitadel participate in broader ecosystems without weakening gateway-owned truth.

Recommended work:

- Durable external writeback envelopes.
- A2A protocol bridge with Agent Cards, task lifecycle, streaming, push notification safety, auth scoping, audit, and artifacts.
- Add-ons graduation or stricter hiding.
- Desktop/mobile continuity flows.

Why third: these are high-leverage but touch policy, auth, audit, and side effects. They deserve the repo's named proof lanes and careful product truth.

## Things Not To Claim Yet

Keep the existing truth boundaries. Do not claim:

- hostile-code sandboxing for Code Mode
- autonomous high-risk tool activation
- full local inference maturity from optional NPU support
- Add-ons marketplace maturity while the route is experimental
- A2A support while availability marks it unavailable
- durable external writeback replay while docs mark writebacks one-shot
- screenshot or release proof freshness that was not actually produced
- backup restore guarantees beyond documented offline/operator-run paths

## Validation Status

Validated for this report:

- Repo state was inspected before review.
- Current product truth docs were reviewed.
- Canonical Mission Control route model and native route owners were inspected.
- Prompt Packs route ownership was checked and is present via `LazyPromptPacksWorkbenchPage`.
- Mission Control visual baselines were checked; `scripts/verification/baselines/visual/mission-control-next` contains 328 baseline files.
- Selected checked-in screenshots were visually reviewed.
- A2A availability and external writeback truth were checked against current repo evidence.

Not validated:

- I did not run the app locally.
- I did not run Playwright/browser checks.
- I did not run tests or named verification lanes.
- I did not verify live gateway data, providers, costs, channels, desktop service manager behavior, mobile companion behavior, or installer flows.

## Recommended Next Review Questions

1. What is the intended first five-minute user journey for a new local operator?
2. Should Projects become the default intake route for real work?
3. What is the minimum "review packet" that makes Code feel publish-ready?
4. Which Library entities must move from raw detail to action workbench first?
5. Should Ops own a release-proof certificate as a product surface?
6. Is A2A strategically important enough to prioritize ahead of Add-ons?
7. What external writeback destinations need durable side-effect envelopes first?
8. What mobile/desktop continuity moments matter most for daily use?
