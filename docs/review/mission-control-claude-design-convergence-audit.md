# Mission Control Claude Design Convergence Audit

Date: 2026-05-04
Source zip: `C:\Users\spurn\Desktop\Chrome Downloads\GoatCitadel MC Update.zip`

## Source Inventory

Primary references:

- `mc/variation-d.html`: authoritative unified session shell, mixed rail, posture filters, thread header, inline blocks, composer, context aside, status strip.
- `mc/styles.css`: shared dark visual system, typography, card/button/input density, color tokens.
- `mc/app.js`: interaction state examples for shell, menus, session posture, projects, and page content.
- `mc/threads.js`: thread/session seed examples for mixed Chat/Cowork/Code rail behavior.
- `screenshots/var-d.png`, `screenshots/var-d2.png`, `screenshots/var-d3.png`: compact unified-shell screenshot references.

Secondary references:

- `mc/variation-b.html`, `mc/variation-c.html`, `mc/compare.html`: alternate shell and comparison context only.
- `mc/screenshots/*`: numbered state examples for audit, cleanup, quality, and thread rail screens.
- `uploads/screencapture-localhost-5173-library-prompt-packs-2026-05-03-20_26_04.png`: old Mission Control screenshot used as a negative reference for over-large dashboard chrome.

## Reference Checklist

- Shell: 36-48px top bar, left rail around 220-260px, bottom status around 22-28px, no decorative chrome.
- Typography: 10-13px operational labels/body controls, 16-17px session titles, mono only for status/tool/cost details.
- Rail: compact search/filter pills, mixed Chat/Cowork/Code session list, small posture glyph, thin posture color rail, one-line title bias.
- Thread header: flat page heading, small chips, compact model controls, context aside hidden until requested.
- Composer: narrow centered editor, one primary action, tiny `+` utility menu, advanced controls hidden behind menu/context.
- Inline prompts: approval/question blocks sit in-thread and block composer until resolved or dismissed.
- Projects: project container view groups Chat/Cowork/Code sessions without becoming a large dashboard.
- Native pages: Library/Ops/Settings should inherit compact shell density instead of old large cards.
- Mobile: rail collapses before content crushes; composer remains usable.

## Page-by-Page Matrix

| Area | Current match | Main gaps found | Patch applied |
| --- | --- | --- | --- |
| Chat unified session | High | Top/session scale was too large; `+` menu looked like a settings panel; fresh composer exposed confusing actions. | Global scale reduced, rail and composer tightened, `+` menu compacted, Chat primary action stays `Send`. |
| Cowork unified session | Medium-high | Needs same compact shell while preserving richer workflow controls. | Shared threaded surface styles now drive Cowork density; advanced actions stay contextual. |
| Code unified session | Medium-high | Needs Code posture controls without recreating a full workbench dashboard at rest. | Shared threaded surface and composer scale now applies to Code. |
| Projects | Medium | Used native card/list sizing and settings-list classes, which looked heavier than the zip’s project grouping. | Native route card/list scale reduced; project counts and grouped thread sections made compact. |
| Library | Medium | Prompt packs/memory/files routes still inherited old large page/card/header proportions. | Native and legacy bridge headers/cards/stat styles compacted. |
| Ops | Medium | Approvals/runtime pages had large pills, alerts, metrics, and list rows. | Approval rows, runtime metrics, notices, and actions tightened. |
| Settings | Medium | Forms, toggles, wizard steps, selectable rows, OAuth cards, and notices were too large. | Settings inputs, toggles, metric cards, wizard, selectable rows, and notices compressed. |
| Cowork tasks/board | Medium | Lane cards were larger than the Claude Design console density. | Task/board lanes and lane items tightened. |
| Inline prompts | High | Behavior existed; visual needed to stay aligned with compact in-thread blocking. | Existing blocking behavior preserved; shared compact buttons/chips apply. |
| Mobile/narrow | Medium | Must avoid rail/composer crush after density changes. | Existing collapse rules preserved; needs visual regression review after final baseline update. |

## Remaining Follow-Up

- Update visual baselines once the unified redesign is accepted.
- Continue extracting large native route sections out of `NativeRoutePages.tsx`; current CSS convergence avoids blocking the UI iteration.
- Add a dedicated visual fixture for `+` menu open state and inline approval open state so future regressions catch oversized popovers.

## Validation Notes

- `pnpm verify:surface:regression` passed after mobile top-bar and task-board overflow fixes.
- `pnpm verify:visual:regression` still fails because every baseline is from the old Mission Control visual system; this is expected for this redesign branch and should be resolved by approving/rebaselining the new compact shell.
