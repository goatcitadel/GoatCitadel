# Executive summary

Mission Control Cowork has the right product thesis and more real systems depth than most "agentic" surfaces, but the current surface still does not feel release-ready as an operator console. The codebase clearly intends Cowork to be workflow-primary: the layout config marks Cowork as `dominantArtifact: "workflow"`, puts the thread in a support role, and keeps orchestration visibility explicit. In practice, the operator experience is still fragmented across four competing zones: session rail, workflow overview, support-thread chat, and a dense context dock. The product promise is "structured multi-step work with visible state." The lived experience is still "a chat page with a board, a trace, and a lot of side panels."

The deepest problem is trust, not styling. Cowork can still present one provider/model in the surface while execution inherits another from global runtime state when the session is not explicitly pinned. The code now surfaces requested vs effective routing in trace details, which is good, but that truth is still too buried for a high-trust operator surface. If the user sees `No runtime`, does not select `llama.cpp`, and Cowork still executes against a local provider path or fails trying to, the product is breaking the operator contract.

The second problem is hierarchy. The workflow overview is trying to be the board of truth, but critical execution truth is split between the board, run trace, suggestions, and system notices. The board itself has improved a lot, but it still mixes status cards, callouts, attention lists, truncated plans, timeline snippets, and role activity in one stacked pane. The thread is intentionally demoted to a support lane, but it is still the richest readable artifact. That creates an identity conflict: the board is supposed to lead, but the thread is still where meaning is easiest to recover.

The third problem is failure presentation. The underlying durable/orchestration model is strong, but the UI often leaks internal implementation detail instead of explaining what failed, what the operator should do next, and whether the system can recover. Raw failure strings, internal IDs, and trace-heavy language still show up in places where the operator needs a decision, not a forensic dump.

This review is repo-grounded and screenshot-grounded. Live browser validation was not available during the final pass because `localhost:5173` was not accepting connections.

# Top 3 problems

1. **Cowork still has a routing-trust gap.** `[systems/trust] [trust-breaking]`
   - What is wrong: session-level provider/model can remain unpinned, the UI resolves a selection from runtime defaults, and the gateway falls back to global active provider state when a request is not explicitly pinned end to end.
   - Why it matters: Cowork is a control surface. "What will run?" is a first-order trust question.
   - Operator harm: the operator can believe they are using one provider while execution uses another, especially around local runtimes and unavailable models.
   - Smallest safe fix: pin `providerId` and `model` into session prefs when Cowork session creation or first Cowork entry occurs, and surface requested vs effective routing directly in Cowork controls.
   - Better long-term fix: make routing a first-class execution contract with explicit requested/effective state in the main surface, not only in trace details.

2. **The page is still structurally fragmented.** `[UX] [structural]`
   - What is wrong: workflow board, support thread, run trace, suggestions, learned memory, and session controls all compete as semi-primary artifacts.
   - Why it matters: a workflow surface must answer "what is happening now?" in one glance.
   - Operator harm: the operator has to scan multiple panels to reconstruct state, especially during failure or handoff moments.
   - Smallest safe fix: collapse or demote session controls, suggestions, and memory by default on Cowork; keep the board and thread as the only always-open work artifacts.
   - Better long-term fix: redesign Cowork as a true three-lane surface: board of truth, active conversation/work log, and collapsible diagnostics/context.

3. **Failure states are still explained like internals, not like operator decisions.** `[hybrid] [structural]`
   - What is wrong: trace cards and notices expose raw system strings, recovery-state fragments, and internal IDs without consistently translating them into operator meaning.
   - Why it matters: resilience UX is where trust is won or lost.
   - Operator harm: users can see that something failed, but not always whether the run is recoverable, what the next action is, or whether the system is lying about readiness.
   - Smallest safe fix: normalize all Cowork failure surfacing to three operator questions: what failed, what the system already did, what you should do next.
   - Better long-term fix: separate operator status from engineering trace, with a human-readable run-state layer and a secondary forensic layer.

# What is working

- The **product direction is strong**. Cowork is not pretending to be a toy chat wrapper. The code and docs clearly aim for explicit orchestration, durable ownership, worktree-backed execution, and visible run truth.
- The **surface config is conceptually correct**. `surface-config.ts` makes Cowork workflow-primary, support-thread-secondary, and dock-as-drawer. That is the right high-level posture.
- The **board of truth exists**. `CoworkCanvasPanel.tsx` now gives Cowork a real workflow board instead of only a dock-side summary.
- The **runtime model is serious**. Durable execution and orchestration linkage are well-defined in `docs/CANONICAL_RUNTIME_STATE_MODEL.md`.
- The **trace model is richer than average**. `ChatTraceCard.tsx` surfaces requested vs effective routing, fallback use, API style, recovery state, tool timeline, and orchestration summary.
- The **refresh path for active orchestration is intentional**. `useChatDockWorkbenchController.ts` subscribes Cowork to orchestration run/checkpoint refresh instead of forcing page re-entry.
- The **manual QA expectations are mostly the right ones**. The repo already encodes that Cowork should be visibly distinct from Chat and that requested vs effective routing must be legible.

# Critical UX issues

1. **Cowork still feels like several panels assembled around a chat shell instead of one coherent work surface.** `[UX] [structural]`
   - Evidence: `ChatSurfaceLayout.tsx`, `ChatContextDockPanels.tsx`, `ChatDockSessionSection.tsx`, screenshots.
   - Why it matters: the operator needs one dominant mental model.
   - Operator harm: scanning cost is high; attention is spent on layout decoding instead of work.
   - Smallest safe fix: on Cowork, keep only workflow board + support thread expanded by default; collapse dock panels behind explicit toggles.
   - Better long-term fix: make the board and thread the core composition and turn the dock into a true slide-over utility rail.

2. **The workflow board is better, but still over-mixes summary, status, action, and diagnostics.** `[UX] [structural]`
   - Evidence: `CoworkCanvasPanel.tsx`
   - Why it matters: a board should separate "state now" from "details below."
   - Operator harm: important state is harder to parse because callouts, status tiles, attention items, plans, and mini timelines all sit in one continuous stack.
   - Smallest safe fix: split the board into three fixed blocks: current state, next actions, recent progress.
   - Better long-term fix: move plan steps, timeline, and role activity into tabbed board subviews instead of stacking all of them.

3. **The support thread is still the clearest artifact on the page even though it is supposed to be secondary.** `[UX] [structural]`
   - Evidence: `surface-config.ts`, `ChatSurfaceLayout.tsx`, screenshots.
   - Why it matters: if the secondary column is where meaning is easiest to recover, the primary column is not doing its job.
   - Operator harm: the operator falls back to reading the conversation to infer workflow truth.
   - Smallest safe fix: make the board summarize the current run in plain language as clearly as the assistant thread does.
   - Better long-term fix: convert the support thread into an "activity log + operator thread" with tighter structure and explicit linkage to steps/checkpoints.

4. **Session controls consume too much strategic attention for their actual value during active work.** `[UX] [structural]`
   - Evidence: `ChatDockSurfaceSection.tsx`, screenshots.
   - Why it matters: model/policy controls are important, but they are setup and adjustment tools, not the main work artifact.
   - Operator harm: configuration competes with execution.
   - Smallest safe fix: collapse advanced controls into a "Session settings" disclosure on Cowork.
   - Better long-term fix: move persistent model/policy editing into a separate compact control tray with clear requested/effective state.

5. **Suggestions and specialist management are overexposed for the maturity of the rest of the page.** `[UX] [cosmetic->structural]`
   - Evidence: `ChatDockSuggestionsSection.tsx`, `useMissionControlSurfaceState.ts`
   - Why it matters: suggestion systems should help momentum, not become another inbox the operator must triage.
   - Operator harm: "Suggested next moves," specialist suggestions, saved specialists, delegation suggestion, and proactive runs create another full workflow beside the actual workflow.
   - Smallest safe fix: show only the single highest-value suggestion inline; move the rest behind "More recommendations."
   - Better long-term fix: separate "team composition" from "next move suggestion" into different surfaces or states.

# Critical systems/trust issues

1. **Provider/model truth is still too implicit.** `[systems/trust] [trust-breaking]`
   - Evidence: `useChatProviderRoutingController.ts`, `useChatOutboundExecution.ts`, `chat-turn-prep-service.ts`, `llm-completion-service.ts`
   - What is wrong: the UI resolves provider/model from session prefs or runtime active defaults; the gateway persists incoming prefs override when present; the completion layer still uses global active provider if none is explicitly carried.
   - Why it matters: Cowork cannot be trustworthy if routing is inferred in multiple places.
   - Operator harm: silent inheritance, especially around `llama.cpp`, makes the surface feel deceptive.
   - Smallest safe fix: ensure every Cowork turn has explicit session-pinned `providerId` and `model`, and show both requested and effective routing in the main Cowork controls.
   - Better long-term fix: unify selection, persistence, and execution around a single routing contract with explicit provenance: user-picked, session-default, workspace-default, or system-fallback.

2. **Requested vs effective routing is still buried in trace instead of visible at the moment of decision.** `[systems/trust] [structural]`
   - Evidence: `ChatTraceCard.tsx`
   - Why it matters: the operator should not need to open the trace to learn that execution drifted from the requested target.
   - Operator harm: fallback is discoverable, but late.
   - Smallest safe fix: add a routing strip to the Cowork header or session-controls card: `Requested`, `Effective`, `Fallback reason`.
   - Better long-term fix: make routing state a core run-status concept with badges and transition history.

3. **The page can still imply runtime readiness it cannot guarantee.** `[systems/trust] [trust-breaking]`
   - Evidence: prior failures in-thread, local-runtime screenshots, current routing path.
   - Why it matters: "Gateway ready" is not the same as "selected execution target is reachable."
   - Operator harm: the operator sees a healthy shell while Cowork is actually targeting an unavailable local model path.
   - Smallest safe fix: block or warn on Cowork send when the selected or inferred provider is a local runtime and runtime health is unavailable.
   - Better long-term fix: add provider-scoped readiness to the surface: gateway health, runtime health, and selected-target health are distinct.

4. **The codebase knows Cowork should be distinct, but the dock ordering still undermines that intent.** `[hybrid] [structural]`
   - Evidence: `useMissionControlSurfaceState.ts`, test expects `["suggestions", "workflow", "trace"]` priority even on Cowork.
   - Why it matters: suggestion priority ahead of workflow truth is backwards for a controller surface.
   - Operator harm: recommendations can outrank reality.
   - Smallest safe fix: make workflow/trace outrank suggestions on Cowork unless no run exists.
   - Better long-term fix: redesign dock semantics around run state, not generic panel presence.

# Failure-mode review

- **Stream interruption and resume**
  - Good: `useChatOutboundExecution.ts` attempts bounded resume and preserves turn continuity.
  - Problem: notices like "Reconnecting to turn ..." explain transport churn, but not whether the run itself is healthy.
  - Fix: separate connection-status notices from run-status notices.

- **Approval wait / user-input wait**
  - Good: Cowork board now elevates waiting-for-approval and waiting-for-user-input in the main callout.
  - Problem: approval state still splits across board, trace, and separate approvals surface.
  - Fix: add one clear board banner with action target and blocking phase.

- **Orchestration refresh failure**
  - Good: `useChatDockWorkbenchController.ts` preserves last-known-good run/checkpoint state.
  - Problem: the error copy is still technical and partial: "run data," "checkpoints."
  - Fix: translate into operator meaning: "Live workflow updates paused; last known state is still shown."

- **Orchestration / delegation failure**
  - Good: durable/orchestration linkage exists and step failures are persisted.
  - Problem: failure details can surface as raw DB/runtime/provider strings in-thread and in trace.
  - Fix: add an operator-safe summary layer before rendering raw `lastError` or step error text.

- **Local runtime / provider failure**
  - Good: the trace can record effective provider/model and fallback.
  - Problem: the main surface can still look like the system chose something the operator never intended.
  - Fix: pin selection and expose effective routing in the main Cowork surface before send and during run.

- **Diagnosability gap**
  - Right now there are failure states a user cannot diagnose from UI alone:
    - why Cowork selected a provider they did not explicitly choose
    - whether the selected target is locally unavailable vs gateway-unreachable vs provider-side failure
    - whether a reconnect notice means transport churn only or actual run replay

# Panel-by-panel review

- **Session rail**
  - Useful for navigation and workspace continuity.
  - Still too visually present for Cowork given its tertiary role.
  - Keep it, but reduce contrast and interaction density further on Cowork.

- **Surface header**
  - Clear enough, but too passive.
  - Should carry execution truth: current run state, requested/effective model, and blocking reason.

- **Workflow overview board**
  - This is the right hero panel.
  - It is still trying to be board, summary, alert center, and diagnostics shelf all at once.
  - Needs stronger internal information architecture and less vertical stacking.

- **Support-thread conversation**
  - Still the easiest place to recover meaning.
  - Good as a support lane, but too narrow in some states and still too chat-like for a structured workflow mode.

- **Run trace**
  - Strong engineering artifact.
  - Too dense and too technical to sit in a default-visible operator dock.
  - Should be operator-summary first, deep trace second.

- **Suggested next moves**
  - Helpful in theory.
  - Currently overfull and structurally noisy.
  - Should be one inline recommendation, not a mini control center.

- **Learned memory**
  - Useful as supporting context.
  - Not strong enough to justify default visibility pressure on Cowork.
  - Collapse by default.

- **Session controls / session management**
  - Important but overexposed.
  - Should be treated as setup/admin controls, not always-on workflow content.

# Recommended layout changes

- Make Cowork a strict three-part hierarchy:
  1. workflow board as the hero
  2. active work log / conversation as the secondary lane
  3. diagnostics/context as collapsible support

- Keep the workflow board visible at all times; make it the only panel that summarizes:
  - run state
  - blocker
  - current phase
  - next operator action

- Keep the support thread wider than it is now when a run is active.

- Move run trace out of the main persistent dock stack into:
  - a board-level "Open trace" affordance, or
  - a separate diagnostics drawer

- Collapse by default on Cowork:
  - learned memory
  - session management
  - saved specialists / specialist lifecycle controls
  - most suggestion content

- Remove duplicated state from multiple places:
  - if the board shows blocker and current phase, the dock should not restate them in parallel language

# Recommended behavior changes

- Pin Cowork provider/model explicitly at session creation or first Cowork open.
- Show requested and effective routing in the Cowork header or session controls, not only in trace.
- Distinguish three health states in UI:
  - gateway reachable
  - selected provider configured
  - selected runtime reachable

- Normalize all failure surfacing to:
  - what failed
  - what the system already did
  - what the operator should do next

- Make suggestion behavior state-aware:
  - when a run is active, suggestions are secondary
  - when no run exists, suggestions can help bootstrap

- Treat reconnects as transport events and keep them visually separate from workflow failures.

- Promote one clear "next action" in the board instead of multiple equal-priority buttons and recommendations.

# Safe short-term fixes

- Pin `providerId` and `model` into Cowork session prefs before first send.
- Add a compact requested/effective routing strip to Cowork controls.
- Change Cowork dock ordering so workflow truth outranks suggestions.
- Collapse learned memory and session-management panels by default on Cowork.
- Reduce `Suggested next moves` to the top item plus a "More" expander.
- Rewrite orchestration refresh failure copy into operator-facing language.
- Stop rendering raw internal error strings directly in the main board unless the user expands details.
- Add a local-runtime warning when the inferred or selected provider depends on an unavailable local runtime.

# Medium-term structural fixes

- Redesign Cowork as a real operator board with explicit subviews for:
  - current state
  - plan / phases
  - recent progress
  - diagnostics

- Split operator-facing run status from engineering trace status.
- Unify provider selection, session persistence, and execution routing into a single authoritative routing layer.
- Separate specialist lifecycle management from in-flow suggestions.
- Rework the support thread into a structured activity log + operator exchange, not a generic assistant transcript.
- Add provider-scoped readiness and runtime-health telemetry to the surface shell.

# Open questions / decisions needed

- Is Cowork fundamentally **controller-first** or **conversation-first**? The current code says controller-first, but the readable experience is still conversation-first.
- Should Cowork sessions always inherit the workspace/runtime default provider at creation time, or should they remain explicitly unset until the operator chooses? Either approach is valid, but it must be visible and deterministic.
- Does the product want **specialists** to be part of the main Cowork loop, or are they an advanced configuration concept that should move out of the default surface?
- Should run trace remain a persistent sidebar artifact, or become an on-demand diagnostics surface?
- What is the minimum operator-safe vocabulary for failures? Right now engineering language still leaks through too early.
