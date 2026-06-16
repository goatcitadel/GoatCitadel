# GoatCitadel Product Gap Review Synthesis

> **⚠️ SUPERSEDED (2026-05-31).** The P0 sequence this synthesis recommends — Trust & Policy
> surface, Universal Run Detail, observability dashboard — largely shipped within ~24–48h of this
> review (`50b4f1694` trust + run-trace surfaces, `c6df40fbd` Ops quality dashboard), with
> semantic memory recall wired into `candidate-ranker.ts` and a Code Mode execution-backend
> registry in `267882b5c`. Truth-reconciliation items (remote-MCP catalog honesty, memory
> "default-enabled") verified already-truthful in code on `main`. Treat as historical context.
> Current verdict + remaining fast-follow plan:
> `~/.claude/plans/please-review-goatcitadel-for-golden-candy.md`.

Date: 2026-05-30  
Inputs:

- `GOATCITADEL_PRODUCT_GAP_REVIEW_CODEX.md`
- `GOATCITADEL_PRODUCT_GAP_REVIEW_CLAUDE.md`

Purpose: merge the two independent product/platform reviews, preserve the strongest findings from each, correct claims that do not match the current checkout, and turn the result into one prioritized view.

This is still a report-only artifact. It does not include source fixes, refactors, branches, commits, or test runs.

## Bottom Line

The two reviews agree on the main strategic diagnosis:

GoatCitadel's strongest product is not "another personal AI assistant." It is a governed local-first AI operations console: a place where serious AI work can be delegated, approved, inspected, constrained, resumed, audited, and remembered without pretending partial trust boundaries are complete sandboxes.

The most important merged finding is:

**GoatCitadel has built a trust and runtime-truth machine, but the operator still cannot see enough of that machine in one coherent place.**

Codex emphasized the need for a universal run trace, capability firewall, first-run success path, execution backend abstraction, ecosystem delegation, and trust-as-product positioning. Claude sharpened the critique: existing backend capability is outrunning Mission Control, and the next product leap should be surfacing what already exists rather than building yet another subsystem.

Merged recommendation:

1. Make trust visible.
2. Make runs explainable.
3. Make first-run successful.
4. Make memory semantically useful and governable.
5. Make browser/code/workflow execution pluggable and inspectable.
6. Stop chasing parity for its own sake.

## What Each Report Got Most Right

### Codex Report Strengths

The Codex report was strongest on product positioning and system-level synthesis:

- GoatCitadel should be framed as a governed AI operations console, not a generic assistant.
- The primary UX missing piece is a Universal Run Detail / Trace Explorer across Chat, Cowork, and Code.
- Capability governance should converge into a single Capability Firewall surface.
- GoatCitadel should delegate to specialized external engines where appropriate: Aider/OpenHands/Open SWE/Goose for code, Stagehand/browser-use-style primitives for browser work, n8n/Activepieces for commodity workflow automation, and Langfuse/Phoenix/Opik/Promptfoo-compatible paths for evals/observability.
- Docker, Code Mode, MCP, desktop automation, and memory claims should stay explicitly truth-gated.
- The first-run path needs one successful governed job, not a tour of 39 routes.

### Claude Report Strengths

Claude's report was strongest on concrete backend-to-UI gaps and several technical product gaps Codex underweighted:

- Browser session APIs exist in `apps/gateway/src/routes/browser-sessions.ts`, but Mission Control does not appear to have a browser session viewer or live takeover surface.
- Durable run timeline and checkpoint APIs exist in `apps/gateway/src/routes/durable.ts` and `apps/gateway/src/services/durable-run-service.ts`, but they are not yet a first-class run-inspection product surface.
- `packages/memory-core/src/candidate-ranker.ts` currently ranks memory candidates with lexical matching, recency, and small diversity weighting; semantic/vector recall is not obviously wired into this core ranking path.
- Prompt-injection defense around assembled prompts is regex-based in `apps/gateway/src/services/assembled-prompt-injection-guard.ts`; a governance-first product should have native adversarial eval/red-team packs and broader untrusted-content ingress coverage.
- Remote MCP is still the highest ecosystem-pressure gap if users expect hosted MCP servers, while the release path remains local stdio plus Approval Inbox.
- Trust and policy controls should become a first-class Mission Control surface rather than scattered across Library, Ops, and Settings.

Claude's best phrase is worth keeping: **GoatCitadel built a trust machine and then hid too much of it.**

## Corrections To Claude's Report

Claude's report is useful and mostly directionally right, but several claims are too absolute against the current checkout.

### Permission Profiles And Tool Grants Are Not "No UI"

Claude says permission profiles, tool grants, and local operator overrides have no editor UI. Current code does include Settings UI for these:

- `apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx` has a `permissions` section.
- It loads permission profiles around `fetchPermissionProfiles`.
- It creates profiles through `createPermissionProfile`.
- It displays effective profiles and active local overrides.
- It can create and revoke temporary local operator overrides.
- It loads and displays tool grants in the Tools section.

Corrected finding:

**The gap is not "no UI." The gap is that trust controls are fragmented, dense, and not unified into one action-first Trust & Policy surface.** Capability, tool grant, profile, MCP, add-on, browser-session, Code Mode, integration, and memory permission states still need one coherent operator matrix.

### MCP Quarantine Is Enforced In Key Runtime Paths

Claude says MCP quarantine is documented but not enforced. Current evidence shows enforcement paths:

- `apps/gateway/src/services/mcp-runtime.ts` excludes servers whose trust tier is `quarantined`.
- `apps/gateway/src/services/tool-invocation-coordinator-service.ts` rejects execution for quarantined MCP servers.
- Tests reference quarantined MCP server behavior.

Corrected finding:

**MCP quarantine exists and is enforced in at least the core runtime invocation path.** The remaining product gap is broader: quarantine state should be visible, explainable, editable, auditable, and consistently represented across MCP, skills, add-ons, generated candidates, browser sessions, and external agent adapters.

### Provider Secrets Do Have UI

Claude says there is no secrets/credentials manager. Current `SettingsNativePage.tsx` includes provider secret status, save, and delete flows, with copy explaining keychain/env/inline/none sources and non-roundtripping saved values.

Corrected finding:

**There is provider-secret UI, but not a unified credentials and secret-use audit surface.** The useful next step is not "add any secrets UI"; it is "show which secrets exist, which tools/providers can use them, which runs used them, and how to rotate/revoke them."

### Durable Timeline Is Partly Surfaced, But Not Canonical

Claude says durable timelines are queryable but not surfaced. Current Mission Control does expose some timeline/checkpoint concepts:

- Cowork execution glance shows phase timeline and checkpoint summaries.
- Ops Runtime consumes an observe timeline aggregate.
- Approvals shows durable checkpoint/resume details.

Corrected finding:

**Durable state is partially surfaced, but not as a canonical Universal Run Detail.** This supports the shared recommendation rather than weakening it: scattered timeline fragments should converge into one run-inspection surface.

### Gateway Service Count

Claude cites 687 gateway service files. In this checkout:

- `rg --files apps/gateway/src/services | Measure-Object` reports 727 files.
- `rg --files apps/gateway/src | Measure-Object` reports 1037 files.

The exact number is not strategically important. The real point stands: gateway backend surface area is large enough that product surfacing and decomposition need active restraint.

### Remote MCP Is Important, But Not An Emergency Above Trust UI

Claude argues remote MCP should be treated as an emergency because Goose and the hosted MCP ecosystem can speak transports GoatCitadel blocks. I agree it is a high-leverage P1, but I would not put it ahead of visible trust/run truth.

Corrected priority:

1. Trust & Policy surface.
2. Universal Run Detail.
3. First-run successful governed job.
4. Then governed remote MCP.

Remote MCP without visible trust/run truth would expand the blast radius of the current UX gap.

## Merged Product Thesis

GoatCitadel should explicitly become:

**A local-first control plane for governed AI work.**

That means:

- Chat is the fast input surface.
- Cowork is the supervised long-running work surface.
- Code is the governed implementation surface.
- Library is provenance, memory, skills, capabilities, artifacts, and reusable knowledge.
- Ops is runtime truth, approvals, costs, diagnostics, schedules, and quality.
- Settings is configuration, credentials, providers, channels, tools, MCP, and permission posture.

The product should not primarily compete on:

- number of chat channels
- number of agent frameworks embedded
- number of marketplace items
- "autonomy" theater
- hostile-code sandbox claims it cannot prove
- local inference maturity from optional sidecars
- generic workflow-builder breadth

The moat is trust, governance, and evidence.

## Merged Parity View

| Area | Current GoatCitadel Read | Merged Gap | Priority |
|---|---|---|---|
| Mission Control shell | Strong route model and release-scope discipline | Too many surfaces before the operator sees one successful governed loop | P0 |
| Trust and permissions | Strong backend concepts and some Settings UI | Fragmented; needs unified Trust & Policy / Capability Firewall | P0 |
| Run truth | Durable APIs, approvals, artifacts, runtime timeline fragments | No canonical Universal Run Detail across Chat/Cowork/Code | P0 |
| First-run onboarding | Ship route exists | Needs outcome-based guided job with artifact and trace | P0 |
| Browser automation | Browser session APIs and policy concepts exist | No watchable browser-session Mission Control surface; browser work is not productized | P1 |
| Memory | Lifecycle, provenance, edit/forget, maintenance are strong | Core candidate ranking appears lexical/recency; needs semantic recall and why-used explanations | P1 |
| Red-team/evals | Prompt packs and proof lanes exist | No first-class security/red-team eval packs for prompt/tool/memory/web injection | P1 |
| MCP | Local stdio and Approval Inbox are honest ship path; remote blocked/experimental | Need governed remote MCP preview after visible trust is strong | P1 |
| Code | Trusted-code posture and artifacts are strong | Needs execution backend abstraction and external coding-agent delegation | P1/P2 |
| Workflow/connectors | Channels/integrations have real setup work | Avoid connector treadmill; integrate n8n/Activepieces under policy | P2 |
| Add-ons/skills | Trust policies are strong | Portable bundle/import/export and marketplace posture should wait for stronger manifests/rollback | P2 |
| Observability | Internal proof lanes and runtime evidence are strong | Product-facing quality/eval dashboard is missing | P1 |

## Combined Priority Roadmap

### P0: Make Existing Governance Visible

1. Trust & Policy / Capability Firewall surface

   Combine:
   - permission profiles
   - tool grants
   - local operator overrides
   - MCP trust tiers
   - skill lifecycle state
   - add-on trust state
   - Code Mode execution posture
   - browser-session grants
   - integration/channel permissions
   - memory write policy
   - last used / last failed / last approved / last blocked evidence

   This is Claude's strongest point and should merge with Codex's Capability Firewall recommendation.

2. Universal Run Detail / Trace Explorer

   One screen should answer:

   - What did the user ask?
   - Which mode handled it?
   - Which model/provider was used?
   - What memory/context was included, and why?
   - What tools/capabilities were available?
   - Which tools were actually called?
   - Which approvals were required?
   - Which side effects happened?
   - What failed or retried?
   - What artifacts were produced?
   - What did it cost?
   - What can be replayed, resumed, or only audited?

3. First-run successful governed job

   Setup should end in one concrete proof:

   - provider configured or local/demo path selected
   - one Chat/Cowork/Code task run
   - one approval or explicit no-approval explanation
   - one artifact or durable trace
   - one link to the Universal Run Detail

4. Truth reconciliation pass

   Preserve GoatCitadel's truth-first brand by ensuring docs, catalog entries, release claims, and UI copy do not imply unsupported behavior:

   - remote MCP
   - hosted/cloud sandboxing
   - Code Mode isolation
   - NPU/local inference maturity
   - A2A callability
   - marketplace/add-on lifecycle
   - scheduled automation autonomy

### P1: Close Capability Gaps That Affect Real Use

5. Semantic memory retrieval and why-used explanations

   Fuse vector/semantic recall into the live memory candidate path, keep citation/provenance discipline, and expose why a memory was selected.

6. Browser session viewer and governed browser automation

   Build a Mission Control browser session surface before desktop automation:

   - session list
   - event list
   - screenshots/screencast where feasible
   - takeover/stop
   - grant scopes
   - allowed hosts
   - approval-gated state changes
   - artifact capture

7. Native security/red-team eval packs

   Add prompt-injection, tool-output injection, web-content injection, and memory-poisoning eval packs. Make them visible as quality gates, not just hidden CI.

8. Governed remote MCP preview

   Implement only after trust UI has somewhere to show:

   - transport
   - auth source
   - origin
   - trust tier
   - tool/resource/prompt separation
   - per-tool approval behavior
   - blocked/quarantined state
   - invocation audit

9. Product-facing observability/evals

   Expose run quality, repeated failures, cost anomalies, tool latency, approval churn, memory misses, and regression deltas. Optional export to Langfuse/Phoenix/Opik/OpenTelemetry-style traces can come after the native product view.

### P2: Platform Leverage Through Delegation

10. ExecutionBackend interface

   Convert the current trusted host/Docker boundary story into a selectable product abstraction:

   - local trusted
   - Docker local
   - remote sandbox slot
   - SSH slot
   - browser-only slot
   - future Windows desktop slot

   Do not claim hostile-code sandboxing until the selected backend proves it.

11. External coding-agent adapter

   Start with Aider or OpenHands:

   - create scoped workspace/worktree
   - run external engine under policy
   - capture diff/test/output/artifacts
   - require approval before applying/pushing

12. Workflow-engine bridge

   Integrate n8n or Activepieces for commodity connectors and visual flows, but keep GoatCitadel as the policy/evidence/control plane.

13. Portable skill/add-on bundles

   Move toward governed import/export with assets/scripts/templates, declared tools, provenance, validation, and rollback. Do not turn this into a marketplace until the trust model is durable.

14. A2A after side-effect safety

   Keep A2A preview-only until replay-safe side effects, auth, task lifecycle, streaming/push behavior, and audit are real.

## Combined First 10 Tickets

1. Trust & Policy surface MVP
   - Merge Library Capabilities, Settings Permissions, Settings Tools, MCP trust, skill/add-on lifecycle, and last-use evidence into one operator-facing matrix.

2. Universal Run Detail MVP
   - Join durable run, session, approval, tool call, memory context, provider usage, artifact, error, and replay posture into one route.

3. First-run governed job
   - Replace setup-tour energy with one completed outcome and a linked artifact/trace.

4. Capability last-use and caller history
   - Close the explicit gap in `LibraryCapabilitiesSection.tsx`: attach last-run evidence and recent caller history where available.

5. Browser Sessions Mission Control page
   - Surface `apps/gateway/src/routes/browser-sessions.ts` in UI with grants, events, close/revoke/rotate, and session state.

6. Semantic memory retrieval spike
   - Extend the live memory ranking path beyond lexical/recency matching while preserving citation and write-gate behavior.

7. Memory why-used panel
   - For each context pack, show selected memories, scores/reasons, source/provenance, freshness, and edit/forget actions.

8. Security/red-team eval packs
   - Add prompt/tool/memory/web injection eval suites and a visible result surface.

9. Governed remote MCP preview
   - Implement remote Streamable HTTP/SSE only under explicit trust, network, auth, and approval controls.

10. ExecutionBackend contract plus Docker backend
   - Make execution boundaries selectable and truth-labeled; start with local trusted and Docker.

## My Thoughts On Claude's Report

Claude's report is strong. It is more adversarial than mine in a useful way, and its best contribution is shifting the critique from "what features are missing?" to "what already exists but is not visible enough to be product?"

The parts I would absolutely keep:

- "Trust machine hidden in the UI" as the central critique.
- Browser sessions as a concrete backend-to-UI gap.
- Semantic memory retrieval as a real product gap, not just a future enhancement.
- Security/red-team eval packs as a necessary trust feature.
- Remote MCP as the highest ecosystem pressure point after trust/run surfaces.
- Retire or at least demote the OpenClaw parity scoreboard if it keeps pulling GoatCitadel toward consumer-assistant sameness.

The parts I would soften or correct:

- Permission profiles/tool grants/local overrides are not UI-absent; they are UI-fragmented and not yet a coherent Trust & Policy product.
- MCP quarantine is not merely documented; it is enforced in current runtime invocation paths.
- Provider secrets do have UI; the missing piece is unified credential governance and secret-use audit.
- Durable timelines are partially surfaced; the missing piece is canonical run detail, not total absence.
- "Remote MCP emergency" is directionally right but should not outrank visible trust/run truth. Expanding remote tool reach before the operator can inspect capabilities and runs would magnify the current UX gap.
- The exact gateway service file count was off in Claude's report, though the underlying "large backend surface area" point remains true.

My overall grade for Claude's report: high-value and worth merging, but it should be treated as a sharp product critique rather than an implementation-accurate bug list. It sometimes turns "not surfaced coherently enough" into "no UI exists," which matters because GoatCitadel has already done more UI work than that implies.

## Things The Combined Review Should Not Lose

1. GoatCitadel's moat is trust, not feature breadth.
2. First-run success matters more than route count.
3. A universal trace is the product proof surface.
4. Capability governance must be visible and editable.
5. Memory needs semantic recall without losing provenance discipline.
6. Browser automation needs a watchable, stoppable product surface.
7. Remote MCP should be governed, not rushed.
8. Red-team/eval posture should be native to a governance-first product.
9. External engines should be delegated to, not cloned.
10. Public claims must stay stricter than competitor marketing.

## Final Merged Recommendation

For the next product slice, do not add another integration, model provider, channel, agent framework, or backend service unless it directly supports visible trust/run truth.

Build this sequence:

1. Trust & Policy.
2. Universal Run Detail.
3. First-run governed job.
4. Browser Sessions.
5. Semantic memory.
6. Red-team evals.
7. Governed remote MCP.
8. Execution backend abstraction.
9. External coding-agent delegation.
10. Workflow-engine bridge.

That sequence turns GoatCitadel's existing architecture into a product users can understand, trust, and recommend.

