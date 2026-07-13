# Mission Control UI/UX audit — 2026-07-12

## Outcome

Mission Control Next has a coherent, distinctive visual foundation and a sound one-Chat information architecture. The review found no case for a redesign. The right move is to keep evolving the existing Signal Noir / Citadel Light system while removing navigation dead ends, responsive gaps, misleading success states, and weak accessibility semantics.

The implementation pass addressed the release-bearing P0/P1 defects confirmed by live browser evidence and focused tests. Remaining work is captured in the evergreen backlog, separated from confirmed defects so product ideas do not masquerade as regressions.

## Scope and method

- Canonical surface: `apps/mission-control-next` only.
- Product truth: one primary Chat surface; agentic planning, approvals, and governed code capability remain inside Chat.
- Route scope: 46 visible routes (41 ship, 5 experimental), 6 hidden compatibility/direct-URL routes, and the seeded Chat pending-approval and blocked-provider states.
- Viewports and themes: desktop, laptop, 1179 px boundary, tablet/mobile; dark and light visual variants.
- Evidence: live seeded gateway data, read-only live runtime inspection, focused component tests, surface regression, visual regression, runtime truth, and manual browser checks.
- Review lenses: usability, hierarchy, visual consistency, responsive behavior, accessibility semantics, operator trust, and proof-infrastructure quality.

## Product-design review

1. **Product truth — Healthy.** Navigation and routing preserve one Chat surface. Legacy Cowork/Code inputs normalize to Chat or Ops Kanban rather than presenting competing primary modes.
2. **Information architecture — Healthy after repair.** Primary areas are understandable, release-hidden Settings destinations no longer leak into rails or command search, and Permissions distinguishes current policy contexts from retained Cowork/Code compatibility keys.
3. **Core Chat flow — Healthy after repair.** Session access now follows the shell's compact breakpoint, and generic route context no longer competes with Chat's working context.
4. **Responsive shell — Healthy after repair.** The 1024–1179 px session-drawer gap is closed, mobile retains Citadel/workspace/command access, and setup/expertise controls remain reachable at the desktop boundary.
5. **Operator feedback — Healthy after repair.** Curator requests no longer double-send replies, and canceling destructive MCP work no longer reports success.
6. **Accessibility semantics — Healthy after follow-up.** Shared selectable lists and composite settings fields expose clearer relationships and selection state. A dedicated smoke lane now checks seeded Chat, Ops, Settings, and mobile navigation with axe plus keyboard focus/name sampling and durable failure artifacts.
7. **Visual system — Healthy.** Signal Noir / Citadel Light is distinctive, legible, and aligned with the mission-control brief. The review intentionally avoided a generic dashboard restyle.
8. **Density and progressive disclosure — Good with localized pressure.** Most routes are dense but scannable. Approvals detail and mobile route context needed stronger responsive treatment; Memory and Runtime can still be simplified further.
9. **Runtime truth — Healthy.** Provider, approval, capability, memory, cost, and runtime posture remain inspectable, while experimental routes stay visibly labeled.
10. **Proof infrastructure — Healthy after repair.** Screenshot targets follow the canonical one-Chat model, failure evidence survives assertions, viewport coverage exercises the real boundary, and baseline validation detects stale extras.

## Route coverage

| Area | Visible routes reviewed | Release posture | Result |
|---|---:|---|---|
| Chat | Chat plus pending-approval and blocked-provider states | Ship | Core flow retained; responsive/context issues repaired |
| Projects | Projects | Ship | Usable; first-viewport empty-state compression remains optional polish |
| Library | Agents, Skills, Capabilities, Memory, Knowledge, Notes, Communications, Files, Artifacts, Prompt Packs, Curator, Citadel, Overview, Wards, Council, Blueprint, Vault | 16 ship, 1 experimental | No release blocker after Curator API repair |
| Ops | Activity, Sessions, Schedules, Improvement, Notifications, Approvals, Costs, Quality, Runtime, Diagnostics, Kanban | 9 ship, 2 experimental | Approvals detail responsiveness improved; runtime truth remains visible |
| Settings | General, Start Here, Providers & Models, Personalities, Access, Permissions, Trust & Policy, Budget, Runtime, Local AI, Workspaces, Add-ons, Integrations, Channels, MCP, Tools | 14 ship, 2 experimental | Hidden capability routes removed from discovery; shared form/list semantics improved |
| Hidden compatibility | Cowork workspace/tasks/board, Code, Workspace capabilities, Citadel capabilities | Hide | Direct links remain governed; not discoverable as release surfaces |

## Confirmed issues and implementation disposition

| Priority | Finding | Disposition |
|---|---|---|
| P0 | Curator status requests could double-send a Fastify reply and crash the seeded verification gateway | Fixed; focused gateway tests pass |
| P1 | Chat session drawer could not open from 1024–1179 px | Fixed by aligning controller and shell breakpoints |
| P1 | Release-hidden Settings routes appeared in navigation and command search | Fixed while preserving direct-URL compatibility |
| P1 | Start Here and Guided/Expert access disappeared at the 1440 px boundary | Fixed by aligning CSS and compact-topbar behavior |
| P1 | Mobile removed Citadel/workspace switching and command access without an equivalent | Fixed through compact-shell access paths |
| P1 | Generic route Context obscured Chat Working Context | Fixed by giving Chat a single context owner |
| P1 | Canceling MCP delete could display a false success notice | Fixed with explicit cancellation result handling |
| P1 | Composite settings controls and selectable lists had weak/invalid semantics | Fixed in shared primitives and focused consumers |
| P1 | Desktop approvals detail collapsed into character-by-character wrapping with inspector open | Fixed with responsive detail constraints |
| P1 | Permissions presented legacy Cowork/Code policy keys as peer current surfaces | Fixed in the UI without changing or broadening serialized permission values |
| P1 | Screenshot capture still targeted retired Cowork/Code surfaces | Fixed by mapping those proof stories to seeded canonical Chat states |
| P1 | Browser assertions could fail before evidence was captured | Fixed so diagnostic artifacts are written first |
| P1 | Baseline coverage ignored stale extra screenshots | Fixed with exact-set validation |
| P1 | Removing Chat's generic inspector also removed its only trust-report export | Fixed by moving Copy trust report into Chat Working Context |
| P1 | The mobile threaded Context control exceeded the verification viewport by 13 px | Fixed with a viewport-bound mobile control bar and browser proof |
| P1 | Public screenshot capture could delete the tracked gallery before a later capture failure | Fixed with validated staging and transactional publication |

## Visual findings

What works:

- The teal/cool-neon palette feels technical without becoming muddy.
- Status language and chips communicate risk, release posture, and approvals well.
- Page headers, rails, and content cards create a consistent operator rhythm.
- Both themes retain readable contrast and a recognizable product identity.
- Experimental surfaces are visibly differentiated from release-ready paths.

Further improvements worth testing:

- Reduce the empty Chat canvas on first use by moving the first useful action closer to the conversation entry point.
- Compress the Projects empty state so creation is visible in the first viewport.
- Turn Runtime shell commands into a secondary disclosure behind operator-readable actions.
- Group Memory lifecycle controls into fewer visual levels.
- Extend the new Settings draft guard pattern from Providers, MCP, and Workspaces to the remaining draft-bearing editors.

These are product suggestions, not release-blocking defects.

## Evidence

- Surface regression artifact: `artifacts/verification/2026-07-12T21-52-35-420Z-surface-regression-542763da`
- Initial visual-regression artifact: `artifacts/verification/2026-07-12T21-56-32-738Z-visual-regression-f987e353`
- Final surface regression (68/68): `artifacts/verification/2026-07-12T23-10-35-720Z-surface-regression-1ad104cb`
- Runtime truth: `artifacts/verification/2026-07-12T22-45-38-481Z-runtime-truth-ca33bc4d`
- Visual rebaseline (384/384): `artifacts/verification/2026-07-12T22-46-10-445Z-visual-rebaseline-b680c04b`
- Read-only visual regression (384/384): `artifacts/verification/2026-07-12T22-57-09-727Z-visual-regression-de631a55`
- Fast release gate: `artifacts/verification/2026-07-12T23-13-03-435Z-fast-cd271871`
- Representative captures:
  - `screenshots/surface-regression-chat.png`
  - `screenshots/surface-regression-projects.png`
  - `screenshots/surface-regression-library-memory.png`
  - `screenshots/surface-regression-ops-approvals.png`
  - `screenshots/surface-regression-ops-runtime.png`
  - `screenshots/surface-regression-settings-onboarding.png`
  - `screenshots/surface-regression-mobile-chat-shell.png`

The initial visual lane intentionally ran before implementation. Its drift was useful audit evidence: the stale Projects/Memory/Kanban/Chat-state baselines reflected earlier product truth or seeded state rather than a rendering crash. Final proof is recorded in the implementation handoff rather than overwriting that evidence.

The regenerated public gallery under `docs/screenshots/mission-control-next` now uses canonical Chat for conversation, agentic work, and code-capability stories. Target-specific session titles fail closed if the wrong seeded story loads, and the agentic/code captures contain their intended exchanges rather than retired standalone modes.

## Non-blocking follow-up implementation

- Added `verify:accessibility:smoke`, covering seeded Chat Working Context, Ops Approvals, Settings Permissions, and mobile Chat navigation. Serious/critical axe violations and keyboard focus/name failures retain screenshots, diagnostics, console logs, and a failure-only trace.
- Used the new lane's first red run to repair unnamed topbar selectors, nested Chat turn interaction, an undersized live-activity target, an unnamed project action, and the unnamed Chat composer. The final four-scenario run passed with zero axe violations and eight named, visibly focused targets sampled per scenario.
- Replaced ineffective `h-*`/`w-*` Lucide classes with explicit sizes and added the icon sizing check to `perf:check`.
- Removed the unused eager WebAwesome stylesheet, package dependency, and manual chunk rule. Initial CSS fell from 183,944 to 89,704 bytes; the budget is now 100 KiB and rejects a WebAwesome stylesheet artifact.
- Added route and in-page discard protection for Providers, MCP, and Workspaces. Successful saves update baselines, background refreshes do not overwrite dirty drafts, and every production `window.confirm` flow now uses the shared confirmation modal.
- Made the mobile rail a modal drawer with focus entry, Tab/Shift+Tab containment, Escape and scrim dismissal, inert closed state, scroll lock, and focus return.

## Final validation

- Mission Control Next: 734/734 full-suite tests passed after the follow-up integration.
- Verification scripts: 185/185 passed.
- Gateway Curator: 10/10 passed.
- Threaded surface controller: 40/40 passed.
- Mission Control Next production build, typecheck, UI performance/icon/contrast budgets, and focused shared Chat tests: passed.
- Accessibility smoke: 4/4 seeded scenarios passed with zero axe violations; artifact `artifacts/verification/2026-07-12T23-49-18-207Z-accessibility-smoke-9bf12d37`.
- Final surface regression: 68/68 passed; artifact `artifacts/verification/2026-07-12T23-53-13-719Z-surface-regression-f36866ce`.
- Visual rebaseline: the full capture passed 382/384 before two transient browser/runtime failures; the filtered four-scenario retry passed and completed those baselines at `artifacts/verification/2026-07-13T00-10-56-254Z-visual-rebaseline-7f4fbc30`.
- Final read-only visual regression: 384/384 passed; artifact `artifacts/verification/2026-07-13T00-11-58-990Z-visual-regression-a7c60e9d`.
- Final fast release gate: passed after concurrent workspace work finished and shared/app build metadata was refreshed; artifact `artifacts/verification/2026-07-13T01-04-29-857Z-fast-92290b9c`.
- Visual baseline set: 384 expected, 384 present, 0 missing, 0 unexpected; 32 retired Cowork/Code baselines removed.

## Decisions

- Keep the current visual identity; do not redesign Mission Control into a generic analytics dashboard.
- Keep one primary Chat surface.
- Optimize the default path for a curious first-time operator, while keeping trust/runtime detail one disclosure away.
- Treat visible release status as navigation policy, not decorative metadata.
- Require failure artifacts and exact baseline coverage from browser proof lanes.
- Track suggestions in the evergreen backlog and only promote them after evidence or product validation.
