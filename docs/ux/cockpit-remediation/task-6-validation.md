# Task 6 validation: shared language and accessible control foundation

Date: 2026-10-05. Source checkout: isolated cockpit-remediation worktree at baseline30958cdbcfe2a8dc3234929fbee6bdf4b2248b15 plus accepted Tasks1–5. Primary checkout/user profiles/runtime data untouched. No commits, staging, dependencies or subagents.

## Changes and ownership

- Formatting-only batch: none. Existing modified files were read and patched incrementally; no broad reformatting.
- Shared primitives: Cockpit ui/TechnicalDetails consumes existing UI preferences; Field associates labels/help/errors; Callout combines icon/text/error semantics; AreaHeader supplies semantic heading/actions; RiskBadge reuses StatusBadge with shield identity. All have real native consumers. Dialog forwards its existing Radix autofocus contract for shortcut-help focus return.
- Surface adoption: SystemDiagnostics uses AreaHeader, error Callout and secondary raw event metadata while readable messages stay visible. Appearance theme/density selects use Field. Signed receipt raw JSON and Citadel conflict-review version use TechnicalDetails; scope/expiry/rules/signature/outcome remain outside. Chat/Inbox/Library risk consumers use RiskBadge. Narrow conversation/message/version/access-rule labels preserve canonical fields, protocol risk values, typed confirmations and user/provider/host values.
- Responsive/control owner: packages/mission-control-shared/src/hooks/responsive-breakpoints.ts shares exact phone/above-phone/tablet/below-desktop range predicates with Cockpit owners and shared PageTabs/StatusStrip; CSS phone/below-desktop ranges match640/1024. Existing useMediaQuery owns subscription cleanup. accessible-controls.css scopes44px coarse native controls, existing-token boundaries/focus/selected states, forced colors and animation-free reduced motion; existing fonts/themes retained.
- Shortcut owner: cockpit/app/use-area-shortcuts.ts and routes.ts implement g+c/i/w/l/s/t outside inputs/IME/modifiers,1500ms expiry, focus/pointer/blur/visibility/scope/unmount cleanup. Ctrl/CmdK remains. Named ? help uses existing Dialog, traps focus/Escape and restores connected actual opener. Sidebar hints and Kbd agree.

All source paths above are relative to apps/mission-control-next/src except the explicitly named shared package. No persisted feature review/decision owner was extracted or reset. TechnicalDetails is only for secondary information: callers must keep targets, scope, expiry, consequences, model/context, uncertainty, conflict and relevant provenance outside it.

## Automated evidence (task implementer)

Commands below ran from the worktree root. Each reported result is the actual lane result, not an aggregate shell exit inferred from a later command.

1. Red risk vocabulary: node_modules/.bin/vitest.cmd run --root packages/mission-control-shared src/content/status-vocabulary.test.ts —1 failed/2 passed, existing Safe versus expected Low. Green command below proves all four labels and unchanged unknown-risk fallback.
2. Red shortcuts: node_modules/.bin/vitest.cmd run --root apps/mission-control-next src/cockpit/app/use-area-shortcuts.test.tsx —missing new owner import. Green3 tests prove navigation/input/IME/modifier/expiry/focus/scope/dialog/unmount behavior.
3. Red disclosure: same app runner with src/cockpit/ui/TechnicalDetails.test.tsx —missing new owner import. Green regression proves secondary visibility and mounted review/decision evidence preservation. SystemDiagnostics.test.tsx also toggles real consumer metadata while preserving messages/recovery.
4. Red controlled help focus return: same app runner with src/cockpit/app/ShortcutHelp.test.tsx —body received focus instead of real Help button. Green ShortcutHelp/Dialog2 files2 tests prove accessible naming/focus entry/Escape/actual opener return.

Final focused command (12 files77 tests passed):

~~~powershell
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/app/use-area-shortcuts.test.tsx src/cockpit/app/ShortcutHelp.test.tsx src/cockpit/ui/TechnicalDetails.test.tsx src/cockpit/ui/Field.test.tsx src/cockpit/app/CockpitShell.test.tsx src/cockpit/app/routes.test.ts src/cockpit/areas/work/RunSignedReceipt.test.tsx src/cockpit/areas/system/SystemDiagnostics.test.tsx src/cockpit/areas/inbox/InboxApprovalDetail.test.tsx src/cockpit/areas/library/CapabilityPolicyInspector.test.tsx src/cockpit/areas/chat/ChatComposerControls.test.tsx src/cockpit/app/use-health-digest.test.tsx
~~~

This77-test pass preceded the additional opener-return assertion; the final ShortcutHelp/Dialog command subsequently passed2 files2 tests after the focus fix. Affected glossary consumers were tested with ChatInspector/ChatTextComposer/ChatTranscript/ThreadList/ChannelsSettings/CitadelCouncilSettings/CockpitBoardEditor/WindowedRecordList paths:7 existing files62 tests. Old copy assertions initially failed (3 then2); after aligning message wording, remaining6 files55 tests and final ChatInspector7 tests passed. Missing test paths are not counted as tests.

~~~powershell
& './node_modules/.bin/vitest.cmd' run --root packages/mission-control-shared src/content/status-vocabulary.test.ts src/hooks/useMediaQuery.test.tsx src/hooks/responsive-breakpoints.test.tsx
& './node_modules/.bin/vitest.cmd' run --root packages/mission-control-shared src/components/component-tail.test.tsx src/components/status-session-drawer.test.tsx src/components/status-and-ui-tail.test.tsx
node scripts/run-with-worktree-output-lock.mjs --label=task-6-final-typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck
pnpm --filter @goatcitadel/mission-control-next perf:check
git diff --check
~~~

Shared hook/vocabulary3 files11 tests passed; shared responsive consumers3 files19 tests passed. Output-locked typecheck/dependency builds passed. perf:check passed source copy/classes/refetch/legacy/token/typography/breakpoint/button/scroll/icon/contrast guards; its budget portion read pre-existing built output at that time and is not fresh Task6 transfer/performance proof. Final typecheck and source/design guards were rerun after the help-focus API change and passed. Existing ordinary text token pairs passed4.5:1 in both themes; measured rendered control boundaries remain separate browser evidence. Diff check passed.

## Root browser evidence and gates

Root-owned disposable browser helpers and JSON/PNG evidence are in ignored .superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof. These are local Chromium/browser evidence, not Ubuntu/CI/installed-host/provider certification. Initial loading-only accessibility snapshots are excluded from loaded-surface acceptance; final loaded snapshots wait for actual Message or Continue to safety, then350ms. The initial exact Continue wait failed as a harness-only30-second timeout; the actual label was corrected with no product change.

Confirmed root behavior evidence on final source: task-6-shortcuts-fixed.json checks all six area sequences, ignored typing/old Ctrl2, expiry/focus cleanup, actual Inspect opener restore, palette and preserved unsent draft, with0page errors. task-6-technical-fixed.json checks actual Appearance false→true→false, readable event message retained, collapsed disclosure, expanded valid metadata JSON and0page errors. task-6-composer-639-fractional-fixed.json records real639.2CSSpx at forced device scale1.25: phone Options matches width<640, Review44px/unclipped/no body overflow. The separate799.2 capture is valid wider-screen evidence, not fractional639 acceptance.

~~~powershell
node .superpowers/sdd/2026-10-05-cockpit-remediation/task-6-shortcuts.mjs task-6-shortcuts-fixed
node .superpowers/sdd/2026-10-05-cockpit-remediation/task-6-technical.mjs task-6-technical-fixed
node .superpowers/sdd/2026-10-05-cockpit-remediation/composer-geometry.mjs task-6-composer-639-fractional-fixed 639 844 light visible 1.25
node .superpowers/sdd/2026-10-05-cockpit-remediation/composer-geometry.mjs task-6-composer-640-fixed 640 844 light visible
~~~

Loaded accessibility command arguments are the fixture Chat URL (sessionId from browser-fixture.json), label, width, height, theme, mode and fixed expectation. Commands used these exact labels/modes:

| Route | Label | Viewport | Theme / mode | Result |
|---|---|---|---|---|
| Fixture Chat | task-6-chat-coarse-loaded-fixed |1440×900|dark / coarse|exit0|
| Fixture Chat | task-6-chat-phone-light-loaded-fixed |390×844|light / standard|exit0|
| Fixture Chat | task-6-chat-desktop-light-loaded-fixed |1440×900|light / standard|exit0|
| Fixture Chat | task-6-chat-phone-dark-loaded-fixed |390×844|dark / standard|exit0|
| Fixture Chat | task-6-chat-phone-forced-loaded-fixed |390×844|light / forced|exit0|
| Fixture Chat | task-6-chat-reduced-loaded-fixed |1440×900|dark / reduced|exit0|
| /settings/onboarding?shell=cockpit | task-6-onboarding-enlarged200-loaded-fixed |390×844|light / enlarged200|exit0|

~~~powershell
node .superpowers/sdd/2026-10-05-cockpit-remediation/browser-accessibility.mjs $fixtureChatUrl task-6-chat-coarse-loaded-fixed 1440 900 dark coarse fixed
~~~

Root supplied and visually inspected the final loaded matrix on Windows headless Chromium against the task-owned Vite testbench (no new production build): desktop1440x900 dark coarse/light standard; phone390x844 light/dark standard and light forced colors; desktop dark reduced motion; phone light onboarding enlarged200. All seven commands exited0 with0serious/critical Axe findings,0page errors and no body overflow. task-6-chat-coarse-loaded-fixed.json contains46 actual native buttons/selects; every measured width and height is at least44px. The screenshot includes the real composer/approval/titles. All task-6-*-loaded-fixed.json/PNG files supersede the corresponding loading-only captures for loaded acceptance. task-6-composer-640-fixed.json separately proves at640DPR1 Options false, Review26px (fine pointer) unclipped/no overflow. Enlarged text is root font resizing, not actual browser zoom. Whole Chat session-control200% layout remains Task13 acceptance. Full approvals/access/parity/whole-surface disclosure/control/menu/inspector/error-field adoption stays with Tasks7–15; keyboard virtual-list scroll is Task16/17 rendered acceptance. No full-suite/performance-budget retest, Ubuntu baseline, CI, installed Windows host, external provider/auth or live durable settlement is claimed here.

## Every Task 6 finding rechecked

All68 Task6 rows, including every Medium/Low row, keep original imported fields/IDs/evidence and earlier task additions.233 total IDs/imported fields/earlier evidence were machine-compared against task-6-before.json and preserved. Only three core current implementation statuses (GL-32, GL-41, NV-07) advanced to pending independent verification; none became verified. Per-row task_6_recheck records exact source paths/notes/dependencies and this document. Shared foundations do not close full-parity findings.

| Finding | Recheck status / later owner | Source observation / remaining boundary |
|---|---|---|
| GL-04 | Partial; Tasks 16 | WindowedRecordList scrolls virtual rows before focus; unwindowed preventScroll remains a rendered focus/scroll acceptance gate. |
| GL-05 | Partial; Tasks 12, 13 | Shared forced-color focus/current/selected/control borders added; menu/inspector/status and all feature states still need loaded visual acceptance. |
| GL-11 | Partial; Tasks 12 | Shared cmdk/highlight outline overrides stripped menu focus; full palette/menu keyboard and control contrast remain feature acceptance. |
| GL-12 | Partial; Tasks 7, 12, 13 | Shared inset underline/font weight and forced-color outline distinguish selection; all consuming surfaces remain acceptance gates. |
| GL-14 | Partial; Tasks 7, 8, 9, 10, 11, 12, 13, 14, 15 | Shared foundations do not certify approval/questions/recovery/settings parity or remove Classic fallback. |
| ST-02 | Partial; Tasks 7, 12 | Technical version disclosure adopted on Citadel conflict review; complete Permissions section progression remains with safety/settings owners. |
| ST-03 | Partial; Tasks 7, 9, 10, 11, 12, 13 | TechnicalDetails now consumes the preference; Diagnostics, receipt and Citadel version consumers preserve decision evidence. Remaining consumers adopt incrementally. |
| GL-13 | Partial; Tasks 17 | Existing AreaErrorBoundary remains preserved; focused shell tests prove recovery for Chat/Library render errors and query/route retry. |
| NV-01 | Partial; Tasks 11, 12 | Existing health digest labels and WorkRunningIndicator accessible state remain; deferred note punctuation corrected without altering health authority. |
| ST-01 | Partial; Tasks 7 | Current permission-profile radio selection was not changed; exact safety owner regression remains required. |
| GL-03 | Partial; Tasks 7, 8, 9, 10, 11, 12, 13 | Shared recordView consumers and earlier retained-detail fixes remain; no generic disclosure mount resets feature review state. Full mutation/refetch owner matrix remains. |
| GL-16 | Partial; Tasks 12, 13 | Scoped shared native/coarse controls enforce44px; checkbox/radio target is associated label. Full loaded controls/compact/enlarged coverage remains rendered gate, AA24px separately. |
| GL-17 | Partial; Tasks 7, 8, 9, 10, 11, 12, 13, 14, 15 | Secondary event metadata/receipt JSON/access versions now disclose consistently; target/context/conflict/provenance stay visible. Remaining feature identifiers require owner adoption. |
| GL-19 | Partial; Tasks 9, 10, 11, 12 | Diagnostics uses shared AreaHeader; section-tab route semantics and other area headers remain owner work. |
| GL-21 | Partial; Tasks 7, 10, 13 | RiskBadge uses shield symbols and shared Low/Medium/High/Critical labels separately from lifecycle icons; critical approval and other feature parity remain. |
| GL-23 | Partial; Tasks 7, 8, 9, 10, 11, 12, 13, 15 | No mechanical rewriting of runtime owner identity. Link and responsibility descriptions remain individual feature-owner work. |
| GL-24 | Partial; Tasks 7, 9, 12 | Decision receipt/runtime follow-on attribution unchanged; Task7 shared decision bar owns settlement and truthful operator attribution. |
| GL-25 | Partial; Tasks 7, 9, 10, 11, 12 | Existing describeApiError and earlier typed boundary errors preserved; consistency-owner messages remain domain-specific recovery work. |
| GL-26 | Partial; Tasks 8, 9, 10, 11, 12, 13, 14, 15 | Existing EmptyState retained; authorized first actions and feature-specific empty copy remain owner work. |
| GL-27 | Partial; Tasks 10, 12, 13 | No provider/user/host identifiers changed. Provider/acronym display naming needs real owner catalog metadata. |
| GL-29 | Partial; Tasks 7, 8, 9, 10, 12 | Shared Button retained; governed action naming/confirmation remains domain-owned pending Task7 decision-bar semantics. |
| GL-30 | Partial; Tasks 7, 12 | Native control outlines/borders use readable existing text-muted/accent tokens; contrast source guard passed. Measured rendered boundaries remain root gate. |
| GL-31 | Partial; Tasks 7, 9, 12 | No generic change to commit policy or variants; destructive/commit versus Cancel decisions stay in feature reviews. |
| GL-32 | Implemented; rendered acceptance gate | Scoped reduced-motion sets animation/transition none and automatic scrolling, retaining textual runtime status. |
| GL-33 | Partial; Tasks 12, 13, 16 | Unlayered scoped focus-visible outline overrides stripped rings; clipped/scrolled feature containers require rendered owning-surface proof. |
| GL-34 | Partial; Tasks 11, 12 | Existing theme/font palette retained; no speculative panel restyling. Rendered hierarchy remains area acceptance. |
| GL-35 | Partial; Tasks 17 | Existing ordinary text token contrast passes both-theme guard; loaded screenshots/accessibility remain required before certification. |
| GL-36 | Partial; Tasks 7, 12, 13 | Field/Callout/AreaHeader use existing readable token scale; scoped control height supports enlarged text. Full safety/session-control enlarged layout remains feature acceptance. |
| GL-37 | Partial; Tasks 9, 10, 11, 12 | Diagnostics shared heading pattern has semantic h1; other feature headings require their owner adoption. |
| GL-38 | Partial; Tasks 7, 8, 9, 10, 11, 12, 13 | Callout exists with icon/text and real diagnostics failure consumer. All historical alert lines are not certified converted. |
| GL-39 | Partial; Tasks 7, 12, 13 | Existing Radix Dialog and Vaul Sheet reused; help adds focus return through legitimate Dialog API. Full dialog/scrim parity remains owner work. |
| GL-40 | Partial; Tasks 12 | Color-scheme/browser chrome is not changed by shared controls; keep theme-native-control acceptance with shell appearance. |
| GL-41 | Implemented; rendered acceptance gate | Shared range registry adopted in Cockpit responsive owners and shared PageTabs/StatusStrip; CSS phone/below-desktop now use inverse ranges with no fractional gap. |
| GL-42 | Partial; Tasks 7, 9, 10, 11, 12, 13 | Existing primitives reused and common controls scoped; all raw/native consumer conversion remains incremental owner work. |
| GL-43 | Partial; Tasks 12, 13, 15 | Shared/native/classic boundary preserved. No blanket extraction or source retirement from foundation changes. |
| GL-44 | Shared disabled foundation implemented; broader surface adoption Task12 | Fix1 completes native IconButton and Radix MenuItem disabled colors/cursor/opacity, suppresses enabled hover/highlight and covers forced-color native/data/aria disabled states. Gallery actual consumers validate semantics. |
| GL-45 | Partial; Tasks 12, 13 | Sidebar sequence hints agree with help/Kbd labels; broader keyboard-accessible Tooltip adoption remains owner work. |
| GL-55 | Partial; Tasks 9, 11, 12 | Task/run versus Activity distinctions remain owner semantics; no route or protocol identity renamed. |
| NV-02 | Partial; Tasks 12 | Existing theme application retained; first-paint/browser chrome/system-choice matrix remains shell acceptance. |
| NV-05 | Partial; Tasks 12, 13 | Existing navigation owner preserved; focus/announcement/skip-link full route matrix is not certified by shortcut helper. |
| NV-07 | Implemented; rendered acceptance gate | g+c/i/w/l/s/t hook ignores inputs/IME/modifiers and expires/cancels on focus/scope/unmount; ? named help restores connected opener; palette shortcut preserved. |
| NV-08 | Partial; Tasks 12 | Existing top-right Sonner toaster remains; toast keyboard expiry/placement/tone needs owner completion. |
| NV-15 | Partial; Tasks 12, 13 | Inspector retains source ownership; sheet boundary shares registry, but tablet focus/scrim and return remain owner work. |
| NV-16 | Partial; Tasks 12 | Existing native owner links retain modified-click handling; area nav buttons not mechanically converted. |
| ST-14 | Partial; Tasks 12 | Branded/user-supplied Citadel values preserved; reviewed access version is secondary but full branded-language explanation remains Settings work. |
| ST-15 | Partial; Tasks 7, 12 | Shared control focus/border guard applies without changing provider plan custody/commit semantics; unlayered plan-button variants remain feature acceptance. |
| ST-16 | Partial; Tasks 11, 12 | Diagnostics shared header/callout real adoption reduces drift; Settings/System full nesting hierarchy remains feature acceptance. |
| ST-17 | Partial; Tasks 7, 12 | Hook modify/intercept protocol and policy unchanged; consequence explanations and review stay with safety owner. |
| ST-22 | Partial; Tasks 7, 12 | Field links help/errors to real control IDs; Appearance theme/density consumers adopted. All feature validation associations still require adoption. |
| SY-04 | Partial; Tasks 11 | Current Quality renders selected real panel but manual tab buttons still lack full arrow-key semantics; untouched feature gap stays open. |
| SY-10 | Partial; Tasks 11 | Diagnostics log failure adopts Callout error semantics; Quality still has calm EmptyState error path and needs domain fix. |
| GL-22 | Partial; Tasks 7, 8, 9, 10, 11, 12, 13, 15 | Shared Diagnostics header leads with task, decision-relevant export limitation retained. Other feature narration remains owner work. |
| GL-28 | Partial; Tasks 12, 13 | Field labels associate with actual Appearance selects and shortcut help is named; all feature accessible names remain acceptance work. |
| WK-11 | Partial; Tasks 9, 13 | No durable dead_lettered or delegation protocol changed; user-visible stopped/recovery/helper terms remain Work/Chat owner adoption. |
| GL-56 | Partial; Tasks 9, 10, 11, 12 | Shared responsive consumers use exact phone boundary; scroll cues/selected-tab reveal remain individual tab-list work. |
| GL-57 | Partial; Tasks 8, 9, 10, 11, 12 | Useful manual retry/refresh retained. No suppression of freshness signals or blanket refresh removal. |
| GL-58 | Partial; Tasks 7, 8, 9, 10, 11, 12, 13 | Narrow message/conversation/version/access-rule glossary adoption and deferred note punctuation correction; protocol/user/host values preserved. |
| GL-59 | Partial; Tasks 8, 12, 13 | Notice/release/runtime naming remains domain-specific; no ambiguous blanket Updates replacement. |
| GL-60 | Partial; Tasks 11, 12 | Existing status tokens/text preserved; RiskBadge now uses distinct risk identity. Whole health/rail/phone status matrix remains acceptance. |
| GL-61 | Partial; Tasks 12, 15 | Every added primitive has real consumer; no deletion of existing primitives or presumed dead Classic CSS without consumer/visual audit. |
| GL-65 | Partial; Tasks 9, 12, 13 | Existing product title owner preserved; selected conversation/run titles still need owner-provided names. |
| NV-21 | Partial; Tasks 12, 13 | Sheet close receives coarse sizing foundation; sticky header/description/drag dismissal still require Sheet/feature completion. |
| NV-22 | Partial; Tasks 12, 13 | Existing inspector resize width persistence/handle remains unchanged; shared boundary does not establish complete resize/focus acceptance. |
| ST-28 | Partial; Tasks 7, 12 | Shared diagnostics header action spacing and height foundation adopted; every adjacent-action group still requires owner review. |
| ST-30 | Partial; Tasks 12 | Existing radius-sm/md/lg tokens unchanged; bare rounded default remains a feature/token-owner follow-up, not mechanically replaced. |
| ST-31 | Partial; Tasks 12 | Diagnostics shared chrome is real consumer; Channels undefined token/heading and all Settings sections remain Settings completion. |
| N-09 | Partial; Tasks 7, 9, 10, 11, 12, 13 | Actual preference now controls secondary diagnostics/receipt/version disclosure; decision information is independent and reviews remain mounted. |
| N-13 | Partial; Tasks 11, 12, 13 | Narrow ordinary message/version/access labels adopted; BLD host values/protocol names preserved. Remaining daemon/fallback naming needs owner context. |


## Independent review fix1

Addressed the Important primitive disabled-state finding in task-6-review.md; it is not deferred to Task12. IconButton native disabled behavior retains browser action prevention and gains enabled-only hover plus muted/opacity/not-allowed treatment. MenuItem keeps Radix disabled semantics and shared stylesheet handles data-disabled and aria-disabled, suppressing highlight/background/outline; forced colors uses GrayText/opacity1 with matching selector specificity. Gallery adds real disabled icon/menu examples without runtime actions. Broader feature-state adoption remains later-owner work.

Minor touched-owner corrections: ChatInspector tab display is Message while internal turn key remains; Sidebar Search tooltip says Ctrl / Cmd K consistently with existing Kbd/help.

~~~powershell
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/ui/Button.test.tsx src/cockpit/areas/chat/ChatInspector.test.tsx
pnpm --filter @goatcitadel/mission-control-next perf:check
git diff --check
~~~

Focused2 files10 tests passed. Style-only corrections use root rendered/computed-state proof rather than brittle classname assertions. Prior Task6 behavior proof applies to its earlier frozen source; fix1 disabled interactions and minor touched labels have their own root proof gate. No new production build/transfer/full-suite/platform certification follows from perf:check.

Root fix1 proof on final frozen source, Windows headless Chromium against the task-owned Vite testbench:

~~~powershell
node .superpowers/sdd/2026-10-05-cockpit-remediation/task-6-disabled.mjs task-6-disabled-dark-fixed dark standard
node .superpowers/sdd/2026-10-05-cockpit-remediation/task-6-disabled.mjs task-6-disabled-light-fixed light standard
node .superpowers/sdd/2026-10-05-cockpit-remediation/task-6-disabled.mjs task-6-disabled-forced-fixed light forced
~~~

All three commands exit0 with0page errors; JSON/PNG live in ignored browser-proof/task-6-disabled-{dark,light,forced}-fixed. Actual disabled native Unavailable options remains HTMLdisabled, pointer click dispatches0actions, hover background is unchanged, cursor is not-allowed. Actual Radix Unavailable action exposes aria-disabled=true/data-disabled, stays unhighlighted/unselected, does not close the menu and is skipped by keyboard navigation. Both ordinary themes compute muted foreground/opacity0.6; forced native and Radix compute system GrayText/opacity1. This is actual rendered primitive proof, not classname-only assertions, installed-host/live-provider proof or whole-surface parity.

Fix1 snapshot preservation check: exactly eight files changed relative to task-6-fix-1-before.json (six product consumers/primitives/style owners plus ledger/validation). All233 ledger rows preserve previous fields; only GL-44 task6 fix recheck/evidence extended. Shared disabled foundation is complete; later Tasks7–15 retain broader feature adoption and platform gates.
