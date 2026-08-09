# Mission Control UI/UX backlog

Evergreen backlog for `apps/mission-control-next`. Confirmed defects should include reproduction evidence and a proof lane. Product ideas stay labeled as hypotheses until validated.

Program placement: evidence-backed implementation is consolidated in tranche
`M7` of [MASTER_COMPLETION_PROGRAM.md](../MASTER_COMPLETION_PROGRAM.md) so shared
UI primitives, populated stories, accessibility, surface, and visual proof run
together. Explore rows remain hypotheses until promoted by evidence.

## Completed in the 2026-07-12 audit

| ID | Outcome | Proof expectation |
|---|---|---|
| MCUX-001 | Align compact-shell and Chat session-drawer breakpoints | Focused threaded-surface test plus browser check at 1179 px |
| MCUX-002 | Remove release-hidden routes from navigation and command discovery | Route/app tests; direct URLs remain compatible |
| MCUX-003 | Keep Start Here and Guided/Expert reachable across the 1440 px boundary | Shell tests and browser check |
| MCUX-004 | Preserve Citadel, workspace, and command access on mobile | Shell tests and mobile surface capture |
| MCUX-005 | Give Chat a single visible context owner | Shell/Chat tests and surface capture |
| MCUX-006 | Stop MCP cancellation from producing a success notice | Focused MCP settings test |
| MCUX-007 | Improve shared composite-field and selectable-list semantics | Focused primitive/consumer tests |
| MCUX-008 | Repair narrow approvals detail layout | Desktop-narrow browser capture |
| MCUX-009 | Repair canonical screenshot targets and seeded Chat stories | Screenshot target-resolution tests |
| MCUX-010 | Capture diagnostics before browser assertions fail | Lane tests plus failure artifact inspection |
| MCUX-011 | Enforce exact visual-baseline coverage | Baseline guard tests and 384-scenario lane |
| MCUX-012 | Fix Curator reply double-send crash | Gateway Curator tests and surface regression |
| MCUX-013 | Present current permission contexts separately from legacy Cowork/Code compatibility keys | Focused Settings tests; API/storage values remain unchanged |
| MCUX-014 | Keep trust-report export in canonical Chat after removing the generic inspector | Working Context test and surface capture |
| MCUX-015 | Keep the mobile Sessions/Context control bar inside the viewport | CSS guard and mobile browser proof |
| MCUX-016 | Publish the public screenshot gallery only after every staged artifact validates | Publisher tests and successful live capture |
| MCUX-101 | Add a representative accessibility smoke lane with durable failure evidence | Four seeded Chat/Ops/Settings/mobile scenarios; serious/critical axe and keyboard-focus failures block the lane |
| MCUX-102 | Replace ineffective Tailwind-like icon sizing with explicit Lucide sizes | Guard scans all Mission Control Next TSX and reports zero ineffective numeric sizing utilities |
| MCUX-104 | Replace production `window.confirm` flows with the shared governed confirmation modal | No production `window.confirm` calls remain; focused Settings tests cover confirm/cancel paths |
| MCUX-105 | Remove the eager, unused WebAwesome stylesheet and dependency | Initial CSS is 89,704 bytes, both themes clear contrast checks, and the budget rejects WebAwesome CSS |
| MCUX-107 | Make the mobile navigation drawer behave as a modal keyboard surface | Focus enters and stays in the drawer, Escape/scrim close it, and focus returns to the opener |

## Completed in the 2026-08-08 master-program tranche

| ID | Outcome | Proof expectation |
|---|---|---|
| MCUX-103 | Extend dirty-state ownership to Integrations, Channels, Permissions, Runtime, and Add-ons | Selection regressions cover cancel/confirm preservation; all five sections register with the shared route guard; focused Settings tests and Mission Control typecheck pass |
| MCUX-108 | Retire the unconsumed shared split-layout/React Reflex seam | No production consumer or `react-reflex` dependency remains; shared and Mission Control package builds pass |

## Next — evidence-backed

| ID | Priority | Work | Acceptance signal |
|---|---|---|---|
| MCUX-106 | P2 | Add populated Projects and approval-detail stories to visual proof | Baselines exercise real master/detail content, not only empty shells |

## Explore — product hypotheses

| ID | Hypothesis | Validation |
|---|---|---|
| MCUX-201 | Moving the empty-Chat starter action closer to the composer will reduce first-action hesitation | Five-task first-use test; compare time to first useful prompt |
| MCUX-202 | Compressing the Projects empty state will make creation discoverable without scrolling | Mobile and laptop first-viewport test |
| MCUX-203 | Hiding raw Runtime shell commands behind an “Advanced diagnostics” disclosure will help beginners without reducing expert control | Beginner/expert comprehension test |
| MCUX-204 | Grouping Memory lifecycle controls into fewer visual levels will improve scanning | Card-sort plus task completion for inspect/edit/forget/history |
| MCUX-205 | Renaming passive status chips or restyling them as non-controls will reduce false affordance | Click-expectation test across Chat and Ops |
| MCUX-206 | A clearer distinction between “Work” context and the Chat product surface will reduce mode confusion | Terminology study; preserve runtime contracts until evidence supports a change |

## Rules for new entries

- Include route, viewport, state, and evidence for defects.
- Keep one owner and one acceptance signal per item.
- Do not label a suggestion as a bug without a reproducible mismatch.
- Do not reintroduce separate Cowork or Code primary surfaces.
- Keep public copy aligned with the current contract and runtime truth.
