# Mission Control Next Conversation Workspace Redesign

- **Date:** 2026-07-04
- **Status:** Approved design direction; pending implementation plan
- **Surface:** `apps/mission-control-next`
- **Author:** design session with Product Design + brainstorming workflow

> This spec captures the agreed UX direction before more Open Design or implementation work. It intentionally does not prescribe backend/API changes.

## 1. Goal

Mission Control Next should stop feeling like a dense admin console with chat attached. The next redesign should make `Work` feel like a personal AI conversation workspace: warm, direct, and centered on the existing chat display layer, while keeping GoatCitadel's runtime truth, approvals, artifacts, and proof available on demand.

The user should not have to choose `Chat`, `Cowork`, or `Code` as separate destinations up front. They should start from one conversation surface, type naturally, and see planning/build controls appear only when the task calls for them.

## 2. Locked Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Product direction | Conversation Workspace |
| D2 | Top-level boundary | Citadel first |
| D3 | Shell navigation | Integrated Citadel top nav |
| D4 | Work surface | One `Work` area, not separate top-level Chat/Cowork/Code surfaces |
| D5 | Primary layout | Existing chat display layer remains central |
| D6 | Default side context | `Working Context` rail, not proof/status by default |
| D7 | Mode controls | Adaptive composer controls instead of an upfront mode picker |
| D8 | Work record | On-demand drawer preview plus links to full detail pages |
| D9 | Personality | Always-visible personality chip with modular presence asset |
| D10 | Tone | Normal product words; no forced citadel-themed labels beyond the real `Citadel` domain object |

## 3. Design Principles

- Keep conversation light by default.
- Keep operational truth accessible, not omnipresent.
- Preserve the existing chat display layer and all current thread behaviors.
- Make the AI feel personal through visible personality, not decorative theme language.
- Use ordinary product labels: `Work`, `Projects`, `Library`, `Ops`, `Settings`, `Context`, `Work Record`.
- Prefer adding detail on demand over making the default screen dense.
- Preserve route contracts and runtime truth signals during implementation.

## 4. Shell Model

The app hierarchy is:

```text
Citadel -> Work / Projects / Library / Ops / Settings -> project/session/context
```

The top navigation should be a single integrated bar:

- Left: active Citadel switcher.
- Center: route tabs for `Work`, `Projects`, `Library`, `Ops`, and `Settings`.
- Right: compact command/search, status, theme/account/overflow actions.

This replaces the old left-rail-first feel without hiding the Citadel boundary. Citadel switching must use current runtime truth (`activeCitadelId`, citadel list, and existing preference state) rather than mock data.

## 5. Work Surface

`Work` is the primary conversation workspace.

Default desktop composition:

- Center: existing chat display layer.
- Left or collapsible side: sessions, active project/workspace, recent threads, and lightweight navigation within Work.
- Right: `Working Context` rail.
- Drawer: on-demand `Work Record` preview.
- Composer: adaptive controls, attachments, model/personality affordances, and task suggestions.

The center chat layer remains the anchor. Structured blocks, citations, tool/runtime annotations, approval panels, generated artifacts, uploads, model picker behavior, and queued/streaming states must remain functionally intact even if visual presentation changes.

## 6. Adaptive Controls

The old `Chat / Cowork / Code` distinction should become an adaptive behavior inside `Work`.

- The user starts by typing.
- The composer can suggest task posture and controls such as plan, build, review, attach context, connect project, or approve.
- Locked or governed Code/Cowork behavior must remain governed. The redesign changes presentation, not runtime policy.
- `/personality` and other command-style affordances should keep working.

The UI should avoid presenting Chat/Cowork/Code as top-level products. If those words must appear for transparency, they should be secondary runtime posture labels, not the main navigation model.

## 7. Working Context Rail

The default rail answers: "What is this conversation grounded in?"

It should prioritize:

- current Citadel and workspace/project context
- selected files or attachments
- relevant memory/context sources
- active model/provider summary
- available tools/capabilities at a high level
- lightweight assumptions or task framing

It should not default to audit logs, raw runtime tables, or heavy proof panels. Those belong in drawers or full pages.

## 8. Work Record Drawer

The Work Record is on demand.

The drawer should provide a preview of:

- recent artifacts
- generated files
- citations and references
- approvals and decisions
- notable tool/runtime events
- proof/export status when relevant

The drawer should include links to full detail pages. Prefer existing destinations first:

- artifacts, generated files, citations, memory, and reusable evidence -> `Library`
- runtime health, queues, diagnostics, cost/latency, and operational logs -> `Ops`

Do not invent a fake all-knowing log screen. The drawer is a preview and launcher into real existing detail surfaces.

## 9. Personality Presence

Personalities are part of the core experience. The personal AI should feel personal.

In `Work`, show an always-visible personality chip near the composer or thread header. It should include:

- personality name
- concise tone/posture label
- whether it is the Citadel default or a thread override
- a small modular presence asset

Presence asset variants:

- animated portrait
- abstract animated identity mark
- static fallback

Implementation should treat this as a modular slot. The Work UI should not care which asset type a personality uses. Animations must respect reduced-motion preferences and have static fallbacks.

Current implementation note: Mission Control already has a Settings > Personalities surface with a global Chat default and experimental status. This redesign should preserve that truth. Citadel-level default personality is the desired product model, but it should be implemented only when backed by real runtime support or clearly phased without false claims.

Thread override model:

- `/personality` remains the fast path.
- The chip opens a quick switcher.
- A thread override should be visually clear without feeling like a warning.

## 10. Native Routes

Projects, Library, Ops, and Settings should share the new integrated Citadel top nav and calmer page frame.

They should not become landing pages. They remain functional operator routes:

- `Projects`: organization and project/workspace management.
- `Library`: artifacts, files, memory, skills, capabilities, and evidence.
- `Ops`: runtime health, queues, diagnostics, cost, proof, and operational status.
- `Settings`: providers, models, personalities, integrations, access, and controls.

The new shell should make these areas feel coherent with Work without dragging their density into the default conversation.

## 11. Mobile Behavior

Mobile should preserve the same hierarchy:

- top: Citadel + route context
- center: conversation
- bottom or sheet: composer and adaptive controls
- drawer/sheet: Working Context
- drawer/sheet: Work Record preview

The mobile default should favor conversation and composer. Context and record detail should be one gesture away, not permanently occupying the viewport.

## 12. Accessibility And Motion

- Personality animation must pause or fall back when `prefers-reduced-motion` is active.
- All animated presence assets need accessible names or hidden decorative semantics depending on their function.
- Status and approval states must remain text-visible, not color-only.
- Keyboard access must cover top nav, Citadel switcher, personality chip, context rail, Work Record drawer, and composer controls.

## 13. Explicit Non-Goals

- No backend API changes in this design spec.
- No Gateway, storage, or contract changes without a later implementation plan.
- No Open Design source overwrite of the repo.
- No raw JSON as a primary operator UI.
- No fake runtime status, fake logs, fake model/tool usage, or fake proof.
- No xAI/X/Grok-associated motifs, claims, or integrations.
- No removal of the existing chat display layer.

## 14. Implementation Implications

This design likely requires splitting the current Mission Control shell into clearer frontend pieces:

- integrated top navigation
- Citadel switcher area
- Work route frame
- conversation stage
- Working Context rail
- Work Record drawer
- personality chip/presence slot
- compact status/actions
- mobile sheets/drawers

Existing exported helpers used by tests should remain exported or be replaced with equivalent tested helpers.

## 15. Validation Plan

Design implementation should be validated with:

- focused Mission Control Next shell/thread/native-route tests
- route-model tests for preserved URL behavior
- tests for personality chip rendering, reduced-motion fallback, and thread override labels
- tests that Work Record drawer links to real Library/Ops destinations
- typecheck
- perf check
- visual/browser proof on desktop and mobile for Work, Projects, Library, Ops, Settings, context rail, Work Record drawer, personality chip, command palette, modal, and mobile drawer states
- visual regression rebaseline/regression only after screenshots are reviewed

## 16. First-Pass Implementation Stance

- **Citadel-level personality default:** preserve the current global personality default until a real Citadel-scoped runtime contract exists. The UI may frame Citadel personality as the desired model in copy only if it is clearly marked as not yet configured per Citadel.
- **Personality assets:** build the Work UI around a typed presence slot that can render an animated portrait, abstract animation, or static fallback from supplied asset URLs/metadata. Do not invent an asset storage backend in the UI redesign.
- **Work Record detail:** use context-specific links to existing Library and Ops destinations. Do not create a fake "full record" page unless a later plan maps it to real stored data.
- **Adaptive composer controls:** first pass should be presentation and existing-state driven. Use current route/session/runtime signals before introducing any new classifier or API.
