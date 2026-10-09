# Cockpit remediation and verified Classic retirement

Authorized by the user on October 5, 2026. Validated source baseline: `30958cdbcfe2a8dc3234929fbee6bdf4b2248b15`.

## Goal and global constraints

Complete Cockpit across Chat, Inbox, Work, Library, System and Settings. Repair daily operator workflows first. Projects live inside Chat. Preserve every current Classic capability and retire Classic only after verified parity.

- The user's dirty primary checkout is preserved; implementation belongs in the managed `cockpit-remediation` worktree.
- Current implementation and the authorized plan override older Claude design/burn-down documents.
- Gateway APIs, shared contracts/clients, durable execution, approvals, deny-wins policy, credential custody and workspace/actor scopes remain authoritative.
- Chat remains the single conversation surface; do not restore separate Cowork or Code products.
- Retain current fonts/themes and hidden/experimental release policy. Unknown, unavailable, stale or partial evidence never becomes zero or healthy.
- No new dependency without demonstrated need. Keep format-only, presentation, persistence, list performance and build changes distinct.
- Do not stage, commit, push, publish, merge or mutate user/runtime data without explicit authorization for that operation. Implementation authorization does not authorize publication.
- Existing explicit Classic preference and `?shell=classic` remain through one supported Stable release cycle after all parity gates pass. Deletion belongs to the following release; no simulated release passage.
- Browser-local anonymous Inbox acknowledgement is presentation metadata only, labeled as browser-local. Never store approval authority or secrets there.

## Task 1: coverage and parity inventory

Import the 219 historical rows and N01-N14 into one machine-readable remediation ledger, retaining IDs, source status, severity, evidence and overlap links. Assign every entry an owning implementation task and observable acceptance criterion. Record current Classic routes AND their actions, diagnostics, governance, error behavior and deep links in a parity inventory. Do not silently drop hidden/blocked capabilities. Already fixed findings remain regressions, not duplicate implementation tasks. Preserve shipped H0/V/W1 changes.

## Task 2: legacy routing and notification presence

Create one pure compatibility resolver returning a native destination, explicit Classic fallback or missing-route result. Use existing route-model/legacy adapters. Integrate with initial loading and in-app navigation, preserving query identifiers, hash, scope, history state and transition guards. Record-specific approval links resolve to `/inbox?approvalId=…`; authorized cross-workspace lookup offers a visible guarded scope handoff. Unknown records and routes get a missing-record/not-found state. `/ops/runtime` stays an explicit Classic fallback until runtime is ported. Preserve correct Activity/Quality/Diagnostics behavior. Do not globally rewrite arbitrary `runId` parameters.

Restore the existing `useNotificationPresenceLease(workspaceId, sessionId?)` in Cockpit only when Gateway access is ready. Keep existing focus, visibility, renewal, expiry and cleanup semantics. Storage failures must not break rendering. Update Windows/Tauri notification producers to native record destinations while accepting historical links.

## Task 3: native onboarding

Render native onboarding using the existing guided setup owner, including `/settings/onboarding` and the Models Get started tab. Make guided provider setup the primary path and expert editors secondary. Preserve add-key and unchanged-plan safeguards. Explain Continue/Finish eligibility, offer safe sample exploration and put release evidence in System diagnostics.

## Task 4: composer and project reassignment

Wrap desktop composer controls so Review is visible without horizontal scrolling. Preserve phone Options behavior. Project palette reassignment must display destination/context and use existing review, stale/dirty/scope guards before persistence. Cancel makes no assignment.

## Task 5: identity, release visibility and honest status

Explain auth-none restrictions and authoritative 401/403 without retry loops. Board creation requires successful authorized access, never merely `!isError` on a skipped query. Mirror current release-scope rules in nav/search/deep links; technical detail does not promote hidden capabilities. Correct backup/integration handoffs and Health headings, distinguishing problems, incomplete evidence and verified health. Keep unavailable checks visible.

## Task 6: shared language and accessible controls

Adopt the approved Claude glossary (conversations/messages/versions/access rules/setup assistant, Low/Medium/High/Critical risk); leave protocol identifiers and user/host values intact. Add real technical-detail disclosure for secondary IDs, revisions and raw diagnostics while leaving decision-critical target/scope/consequence/context/uncertainty visible. Reuse/extract risk badges, decision bars, fields, callouts, dialogs, tooltips and area headers into legitimate shared owners.

Retain current fonts/themes. Standardize readable typography, spacing, disabled/selected/focus states, forced colors and reduced motion; 44px coarse-pointer targets, 4.5:1 ordinary text and 3:1 controls are product goals. Preserve effective breakpoints using a shared registry with inverse phone/desktop predicates, including fractional widths. Move area shortcuts to `g` + `c/i/w/l/s/t` outside inputs, preserve palette shortcut and add `?` help. Keep formatting-only changes separate.

## Task 7: approvals, access and risky settings

One Chat/Inbox decision bar shows persisted target, scope, expiry and consequences; retain server-required typed confirmation and all risk/policy gates. Decision receipt is distinct from durable resume/settlement. Refresh canonical owner state and show follow-on failure accurately. Native sign-in reuses existing token/basic/device custody and keeps drafts mounted during expiry. Configured auth mode is not proof of caller identity.

Review unsafe prompt skipping, disabled TLS, broad/indefinite grants, modifying/intercepting hooks, current-device revocation and preview updates. Newly created grants default to 1h with 1h/day/7day/until-revoked presets; old grants and server restrictions are unchanged.

## Task 8: Inbox and read status

Decision-only primary badge, updates separate, triage by risk/expiry/age, truthful partial counts, inline low-risk decisions and next-item flow. Port approval history/recovery/replay through existing owners, including code/worker approvals, without duplicating runtime authority.

GET Inbox adds server-authored versions to update items and read-status scope (`operator`, `browser_local`, `unavailable`). POST `/api/v1/inbox/updates/read` accepts `{workspaceId, updates:[{id,version}]}` (max 200) and returns acknowledged/skipped items. Bind actor/workspace server-side; allow only current permitted update versions. Identified operator state uses namespaced `SystemSettingsRepository.compareAndSet`, bounded to 1000 entries and pruned at 14 days, no table migration. Anonymous local metadata contains only IDs/versions scoped by installation/workspace, labeled browser-local. Changed items become unread. Mark all read never resolves a decision or task and says all shown when coverage is partial. Preserve idempotency/rate/schema/async boundaries.

## Task 9: Work

Separate tasks and runtime runs; show failures, blockers, waiting decisions and related work links. Govern schedule pause/delete, make previews and status truthful, save low-risk board edits through existing revision guards. Add search/filters, bound Done, complete bulk/archive/restore, Automation Designer/templates, and keep run evidence secondary.

## Task 10: Library

Native overview and Skills/tools naming; complete memory/notes edit, history, provenance, conflicts, governed promotion/forget/archive, file upload/download, artifact download/provenance and note reminders. Port Agents profiles CRUD/imported catalog, Knowledge with governed external sources and capability proposals/immutable versions. Preserve memory and activation policy.

## Task 11: System

Useful problem/recovery lists, honest health evidence, readable Activity/diagnostics, explicit spend units/local timestamps and dashboard live preview. Preserve existing Health/Spend/Quality/Diagnostics/Activity/Dashboards views rather than unrequested consolidation. Native Back up now calls existing Gateway API and shows progress/receipt/failure; verify disposable restore roundtrip.

## Task 12: shell and Settings completion

Dirty drafts/Back/Forward, URL selections, phone scope/current-area, sheet back behavior and scroll restoration. Palette synonyms and native destinations with real outcomes. Provider picker/guided-first detail controls, secure-input/custody for all provider/connector secrets (extend connector owner where needed), diagnostics-derived integration status, channel disable/remove/draft deletion, MCP templates. One Local AI flow, unsupported actions explicitly disabled, accurate cost preferences. Finish provider diagnostics/model selection, access continuity, runtime diagnostics and Guided/Expert presentation.

## Task 13: Chat

Rail two-line titles, timestamps and optional server `lastMessagePreview` <=160 visible user/assistant characters, no per-row browser fetch or secret/tool preview. Routine runtime evidence collapses but remains inspectable; approvals/failures/blockers expand. Improve truthful thinking/tools/citations/attachments/fallback/context, queue/steer, search excerpts/message destinations, actions/copy/versions, pin/delete/folders/tags, voice/image and delegated/external sessions. One scroll-follow mechanism, responsive rail/inspector/composer, Send/Stop focus, accessible suggestions and restrained announcements. Complete rendered `/btw` and external-source launch outcomes; explicit unavailable/fallback until ported. Preserve governed revoke/takeover/export.

## Task 14: Projects inside Chat

Implement `/chat/projects` and `/chat/projects/:projectId` alongside conversations: list/create/edit/pin/archive/detail, assignment and project fan-out grants. Preserve workspace/revision/review guards. Retained chat URL synchronization must not replace Projects URLs.

## Task 15: remaining capability ports

Port one capability at a time: Mail; browser sessions; Journey; Curator; Improvement reports; runtime authority/control, mesh activation/revocation, emergency takeover and remote-worker management; prompt-pack workbench and truthful daemon controls. Retain release restrictions and existing blocked reasons. Update each Classic link only after actions/errors/diagnostics/governance/deep links pass. Never ban all `src/app` or `src/features` imports: extract actual Classic composition/markup/CSS dependencies and preserve canonical shared owners.

## Task 16: measured performance

Eliminate duplicate boot/refetch; cache by Gateway/workspace/session/caller, invalidate on access/scope changes. Virtualize long lists with stable focus/scroll/follow. Lazy-load editors/workbenches/desktop code; audit side effects, scanning/chunks and actual initial Chat transfer. Targets: Chat <=20 startup requests under existing metric, idle <=12/2min, elsewhere turn <=10, initial Chat JS <=350KB gzip, CLS <=0.10 and correct theme first frame. Keep current startup guard until repeatable evidence supports tightening; no raised budgets or artificial request exclusions. Three matched cold runs.

## Task 17: final validation and gated retirement

Every finding/capability has evidence before closure. Both themes at 1440x900/390x844, fractional breakpoints, enlarged text/forced colors/keyboard, scope/dirty/history/expiry, auth none/token/basic/loopback/device, durable approval settlement, SQLite/PostgreSQL read-state CAS and concurrent acknowledgements. Use focused tests/output locks, then relevant auth/runtime/durable/parity/surface/accessibility/visual/backup/desktop/performance lanes, verify:fast/docs/diff checks. Scoped Ubuntu-rendered visual baselines are reviewed per change before merge. No claims of CI/installed host/provider coverage without execution. Test in disposable runtime; stop only owned processes.

Retain explicit Classic rollback until ALL capabilities pass AND one supported Stable release cycle has elapsed. Do not delete Classic early. Prepare retirement inventory/notice/guards; deletion and preference migration belong to the subsequent real release.

## Public error contract

Add `FEATURE_DISABLED` HTTP 409 with `details.flag`; clients continue accepting older `STATE_CONFLICT` with flag. Enrich canonical projections only when server identity/target evidence exists; preserve IDs/revisions/auth/freshness.

## Delivery

Bounded reviewable batches, proportionate meaningful tests and fresh review. All confirmed Medium/Low findings remain in scope. Publication is a separate explicitly authorized operation. No automatic release, installation or runtime-profile cutover.
