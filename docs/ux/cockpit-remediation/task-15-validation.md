# Task 15 validation

## Port 1 — source and owner validation, 2026-10-06

Status: implemented pending independent disposable API/browser acceptance. Tasks 1–14 retain their existing evidence and accepted bounded scopes. This entry does not certify all Classic parity or authorize its retirement.

### Supported-action inventory checked against rendered owners

The inventory's imported API symbol lists were checked against actual composition, including `ApprovalsRoutePage`, `useApprovalQueue`, `ProjectsRoutePage` and its helpers, `CodeSourceChooser`, `LibraryAgentsSection`, and the imported catalog composition. API-only functions were not assumed to be rendered actions.

| Area | Supported operator behavior and owner |
| --- | --- |
| Approvals | Pending/history/recovery views; complete retained cursor traversal; exact selected/deep-linked record; approve/reject with risk/expiry/confirmation; installation-wide pending rejection; readable target, consequences, shell command explanation, optional summary errors; replay events, pending action and effects; canonical lifecycle/run/timeline, paused-checkpoint resume; live Chat/run links; trace diagnostics and secondary full request/runtime diagnostics. Existing Gateway approval, lifecycle and durable owners remain authoritative. No export button was exposed by the inspected Approvals composition. |
| Specialist decisions | Code source artifact inspection with current hash-bound run/source and permission/output intent, candidate consequence; native-worker exact device/request, executable, command, environment, working directory, process/memory/CPU/time/output/input/diagnostic limits, staging/transfer scope; reject remains available when approval evidence cannot be verified. Recorded decisions remain distinct from original execution status. |
| Projects | Existing Task14 create/edit/pin/archive/restore, assignment/fan-out and governed selection remain. Native source import covers Local folder and GitHub source/reference/name review with owner receipt/failure, project home/readiness/recent work, all seven intake actions (Ask, Plan, Implement, Review, Research, Summarize, Release proof) opening one Chat, cross-project recents, scoped artifact directory/exact artifact links, Citadels/Mason/Start here and memory continuation. |
| Agents | Installation profile listing/search/create/edit (role, name, title, summary, specialties, aliases, default tools) and archive/restore preserve shared profile owner. Built-in editability and lifecycle gates follow actual source. Hard-delete/preset API symbols were not exposed actions. Workspace imported definitions retain catalog inspection, source/provenance/parser state and existing native import/lifecycle actions. Related skills/capabilities/memory/prompt-pack navigation is native. Catalog state is not session activation. |

### Implementation and governance

- History uses the existing **server-scoped** approval cursor API, including server status filters. It never filters the global latest 100 into a claim of complete scoped history. Recovery labels describe linked records in loaded pages; only cursor exhaustion declares the end of retained history. Pagination failure preserves loaded evidence with a stale label. Exact Inspect selection uses Inbox navigation with approval/workspace query parameters and retains unrelated query/hash state.
- Specialist approvals re-read the canonical request and specialist owner evidence before dispatch. Code matches original scope, approval/run IDs, source hash, wrapper/input/capability bindings and non-truncated artifact preview; verified-at timestamps alone do not invalidate immutable evidence. Missing/changed/unreadable evidence disables approval. Existing server deny-wins, expiry, policy, immutable execution checks and deliberate confirmation remain authoritative. Code outcome reads its original canonical run separately; it does not infer completion from an approval receipt.
- Audit/recovery uses replay and runtime lifecycle to identify the original canonical durable run. Resume requires a fresh unchanged paused checkpoint and current caller/Gateway/scope, with deliberate confirmation and an uncertain-response lock. Follow-on effects and original work remain distinct from the decision.
- Bulk rejection explicitly describes installation-wide authority, requires `reject all`, preserves uncertain-response state, and allows a fresh deliberate review after a confirmed receipt. There is no bulk approval path.
- Project imports and intake retain current access/revision checks, original scope, draft review and actual owner outcomes. Project artifact reads forward project/workspace scope and validate returned binding; direct artifact links can inspect records outside the bounded directory window. Overview counts explicitly describe returned records.
- Catalog import drafts live in the existing transient draft owner. Profile/catalog/Inspect transitions use dirty navigation. Fresh-entry lifecycle preflight, dispatch and post-await presentation are caller/Gateway/workspace guarded. Foreign/missing definitions receive useful failure state.
- Six Cockpit areas, one Chat, typography/themes, hidden/experimental policy and release metadata are unchanged. Classic continuations remain pending root proof and later ports; native worker runtime composition stays with port 6. MCP elicitation specialist behavior remains its prior bounded continuation.

### Executed evidence

- Focused native owner suite: 35 files, 277 tests considered; final broader run had 276 passes and one asynchronous ProjectHome test assertion. That assertion was corrected to await the actual owner error; affected final recheck passed 74 tests across 5 files. Earlier catalog test failure was an intentionally repeated access-change mock, corrected to a single transition; old bounded-history assertions were updated for the real server cursor owner. These initial failures remain recorded here.
- Gateway owners: **151 tests passed in 6 files**: approvals route, approval lifecycle, canonical outcomes, project service, agency catalog service, native-worker approval wait. Project service tests mock child-process execution: no real Git initialization/staging/commit/clone was performed. Agency parser tests use owned temporary local directories.
- Guarded Mission Control typecheck passed; guarded production build passed before the final small command/trace/dirty-transition additions, with a final build recorded in the port report. Source ESLint passed on owned paths. Classes, copy, legacy imports, tokens, typography, breakpoints, buttons, scroll contracts, icons and contrast checks passed.
- Existing refetch guard remains red at `WorkBoard.tsx:136`; that file is unchanged by this port. No budget, guard or baseline was weakened. Task16 performance/build acceptance remains separate.
- Immutable snapshot preservation, original ledger/inventory structural equality after removing only the additive port property, owned-path hashes and final output/lock checks are recorded in the isolated task's `task-15-port-1-report.md` and `task-15-port-1-preservation.json`.

### Evidence boundaries

Root disposable API/browser acceptance, full keyboard traversal, fresh narrow-width visuals, actual durable original-run settlement, damaged Code artifact refusal, and actual safe catalog lifecycle proof remain pending this source release. Native-worker display/source checks are not live worker execution proof. Local/GitHub import UI and mocked owner checks are not real clone/repository certification. No real user profile, credentials, custody, user repository or OS state was changed. Ubuntu, installed Windows, full PostgreSQL, release/Stable retention and all later port/release gates remain unresolved where previously unresolved.

## Port 1 fix 1 — six reviewed defects, 2026-10-06

Status: source repairs complete pending root affected disposable API/browser acceptance. The original independent review and root red manifests remain unchanged. This section corrects the earlier incomplete action inventory: Classic also exposes a conditional Return to llama.cpp setup action for change_plan_effect targets llama_cpp_setup and llama_cpp_configuration.

- R1: recovery preflight errors that provably sent no mutation remain retryable after an explicit healthy refresh and a new deliberate review. Successful or uncertain submissions are handled separately.
- R2: a new session-local presentation-only operation owner binds replay suppression to Gateway installation, server-authored caller, workspace/approval/original run for resume, or the installation-wide bulk operation. Checking locks release only before dispatch; submitted/uncertain locks survive view remount, history collapse and away/back access changes. Reads and revision changes cannot settle an unknown submission. Authoritative success can allow a new deliberately reviewed operation (resume requires a new checkpoint revision). Late receipts update only their captured operation; there are no stored payloads, secrets, approval authority or browser persistence. LinkedApproval retains the same details during background reads and passes checking gates down to recovery and decisions.
- R3: Approval action evidence and Reviewed code source are named focusable regions. The existing Cockpit focus styling remains. No scrolling/keyboard/accessibility assertion was weakened.
- R4: the exact supported setup targets expose a scope-aware native link named Return to llama.cpp setup to /settings/models?shell=cockpit#local-ai, through the existing dirty-navigation owner. Other approvals have no setup return.
- R5: ProjectHome and ProjectFanout use distinct home/fanout sibling key prefixes. Regression coverage composes both actual children through repeated project revisions and current access changes, asserting one overview and one fan-out region.
- R6: settlement and audit share a canonical follow-on reader. It distinguishes approval.wait bookkeeping from original work using workflow identity and lifecycle association. Exact Chat turns additionally use the existing structural/cryptographic durable Chat payload reader and workspace/session/turn binding. A wait-only lifecycle explicitly reports no original durable execution. Completed waits are displayed separately from waiting/failed original runs and separate Code outcomes. Foreign wait/approval/workspace bindings are rejected; fresh reads stay access-bound.

Executed validation: expanded native suite31 files/270 tests passed; final affected13 tests across3 files passed after adding foreign wait binding coverage. Guarded typecheck passed. Initial fixture corrections (non-exported hash helper, missing policyRunIdDerivation, and old settlement mocks that omitted lifecycle reads) are recorded here; they were fixed rather than suppressing assertions. No Gateway owner/runtime mutation was introduced. Final guarded build/lint/design/diff and immutable537-path preservation are recorded in task-15-port-1-fix-1-report.md and task-15-port-1-fix-1-preservation.json. Existing WorkBoard.tsx:136 refetch guard stays red; no baseline or budget changed.

Pending: independent fresh root browser/API evidence for all six triggers, including actual durable original work and interrupted responses, keyboard/enlarged-text scrolling and no-original history. Earlier passing root slices and previous acceptance evidence remain attributed to their own runs. No live-worker, real Git import, Ubuntu, installed Windows, full PostgreSQL, Stable-cycle, later-port or global parity claim is added.

## Port 1 fix 2 — four exercised defects, 2026-10-06

Status: bounded source repairs complete, pending fresh root affected disposable API/browser acceptance and independent review. Prior root red manifests and actual unchanged-target refusal, narrow artifact/tab overflow, and invisible queued-toast keyboard evidence remain attributed to their original runs.

- R7: specialist comparison and React review identity share the same stable evidence key. Only replayed read-audit events, approval_observability effects and source verifiedAt are excluded; the complete current approval, scope/linkage/expiry, all other events and execution effects, pending action, durable mapping, full native-worker review, full Code record and exact source/hash/artifact remain compared. Audit/history data itself is untouched. Background observations preserve open typed confirmation and in-flight preflight; caller changes still fence dispatch. A changed specialist refusal survives the parent refresh and receives focus. Submitted/uncertain locks remain unchanged.
- R8: Cockpit-only generated-artifact grids use bounded zero-minimum columns and body/source/metadata widths. Shared source and Mermaid-failure previews gain named focusable regions (Artifact source: <title>; Diagram source) without changing bytes, hashes, global Chat formatting, HTML sandboxing or Mermaid hardening.
- R9: Library section anchors retain intrinsic widths inside the native horizontal strip. Direct and history destination changes reveal the selected section without taking keyboard focus; full accessible names and native navigation remain.
- R10: existing Sonner owner expands visible notifications across pointer modes. Queued overflow cards use visibility:hidden in Cockpit, so opacity-only hidden controls no longer remain in keyboard/accessibility navigation; notification promotion/dismissal and scoped action owners remain intact. No dependency modification.

Executed: final expanded native suite43 files/363 tests PASS; shared artifact viewer9 tests PASS. Guarded app typecheck and final production build PASS (Vite28.83s); owned ESLint and diff checks PASS. Classes/copy/legacy/tokens/typography/breakpoints/buttons/scroll/icons/contrast PASS. Unchanged WorkBoard.tsx:136 remains the inherited refetch-guard failure; no guard or baseline weakened.

Initial test failures retained: InboxApprovalDetail mock passed a click event to its now-message-aware onInvalidated callback; the fixture was corrected to call it without the event and gained focused persisted-refusal assertions. The broader inherited realtime-notification test mock omitted getGatewayAccessRevision used by the unchanged query-key owner, causing13 early failures and cleanup cancellation. A minimal test-only importOriginal fallback preserves all existing assertions; its final16 tests and the complete expanded suite pass. Product notification and query-key behavior was not changed. No test suppression or endpoint/authority substitution.

Immutable540-path preservation,16 owned source/test/document paths, frozen hashes and final output/lock state are recorded in task-15-port-1-fix-2-report.md and task-15-port-1-fix-2-preservation.json in the isolated task folder. All233 finding originals/148 inventory originals and prior validation prefix remain unchanged except the additive fix2 annotations.

Pending: root fresh actual complete public/native matrix and independent review, including real unchanged Code approval/terminal outcome, damaged source refusal, nested artifact bounds/keyboard access, full tab label bounds, more-than-three notifications and actual keyboard/touch targets. Unit DOM checks do not establish browser geometry, hit-testing or rendered CSS visibility. No live-worker, real Git import, Ubuntu, installed Windows, full PostgreSQL, Stable-cycle, later-port or global parity claim is added.


## Port 1 fix3 — bounded review layout and live notification repair

R11: SpecialistApprovalReview, ApprovalReviewSummary and RiskApprovalAction now bound intrinsic grid/source widths and wrap full scope, target, policy and supporting metadata with the installed named wrap-anywhere utility. Reviewed code source and Approval action evidence retain their exact names, tab access, scrolling and full bytes; native launch review retains readable limits and target paths. No global Dialog/CSS, font reduction, truncation or horizontal clipping mask.

R12: live notification waiters now survive repeated query cancellation/replacement. A scoped query-cache owner success settles the retained attempts; cached/manual writes never become notification authority. Owner errors retire attempts with no added retry/polling. Same-tick reads remain shared (GL-63), workspace changes do not reconnect the stream (GL-64), and current installation/access revision/caller generation/workspace generation plus visible-session/preferences are rechecked before delivery and action. Same-render caller away-and-back changes retire old callbacks. Exact/unique/current/expiry owner selection remains unchanged.

R13: approval notifications use the server source approvalId in /inbox?approvalId=<encoded ID>&workspaceId=<encoded scope>, without a duplicate item selector. Non-approval items retain existing generic destinations and legacy route owners remain unchanged.

Executed: five focused files/79 tests PASS; final affected regression38 files/382 tests PASS, including actual QueryObserver/cache cancellation of four distinct live targets, exactly-once final projection delivery, manual-cache withholding, caller/scope retirement, permission-failure withholding, missing/ambiguous/expired/foreign owner records, source-byte/keyboard and retained approval/recovery/presence/toast behavior. Initial regression red reproduced lost burst, caller action leakage and old destination; saved separately. One new summary fixture expected an unlabelled command while the shared owner adds Commands:; corrected exact expected label without changing source. Guarded typecheck and production build PASS (Vite28.27s). Owned ESLint, diff, classes/copy/legacy/tokens/typography/breakpoints/buttons/scroll/icons/contrast PASS.

Unwaived checks: unchanged WorkBoard.tsx136 refetch guard remains red. Completed-build budgets guard reports Expected native route stylesheet asset was not produced. Unchanged guard line91 requires NativeRoutePages-*.css; immutable fix2 output hashes already contain NativeRoutePages-DsuCeGu2.js and no matching CSS. This preexisting output-shape gap carries to Task16; no guard/config/styles changes. The initial budget invocation during this agent's build reported missing index.html; the separate completed-build run establishes the stable failure above.

Exact13 source/test/document paths, immutable545-path outside-owned preservation,233/148 original structures/prior validation prefix, owned/output hashes and no-lock release are recorded in task-15-port-1-fix-3-report.md and task-15-port-1-fix-3-preservation.json in the isolated task folder. Root fresh native/authenticated live event acceptance and independent review remain pending. Unit DOM is not enlarged browser geometry proof. No real Git import, live provider/worker, Ubuntu, installed Windows, full PostgreSQL, Stable-cycle, later-port or global parity claim.

## Port 1 final accepted slice — 2026-10-06

Status: **accepted for the bounded native Windows behaviors below**. The earlier pending sections and failed manifests remain historical evidence. This closes the scoped acceptance of the listed Port 1 repairs; it does not certify every inventory capability, later ports, full parity, Classic retirement or a release.

The root acceptance collector, `task-15-port-1-accepted-evidence.json`, passed at 2026-10-06T22:38:51Z with **68 accepted behavior groups / 148 loaded audits**. This comprises **fresh Fix4 Code: 10 groups / 14 audits**, plus **retained unchanged-owner evidence: 58 groups / 134 audits**. It is not a fresh execution of the full 146-audit matrix. Root completed its actual run with exit 0, exact factory cleanup and no output lock. Root inspected the safe desktop-dark and phone-light enlarged End screenshots. These runtime results are distinct from source/DOM tests and independent source review.

### Accepted evidence and provenance

All paths in this table are relative to `.superpowers/sdd/2026-10-05-cockpit-remediation/`. The collector records each exact path and retained boundary; failed or diagnostic manifests are excluded.

| Accepted behavior | Groups / audits | Provenance | Exact evidence manifest |
| --- | --- | --- | --- |
| Approval history and replay | 8 / 12 | Retained Fix2 | `browser-proof/task-15-port-1-fix-2-root-history/history-evidence.json` |
| Projects, intake and artifacts | 8 / 24 | Retained Fix2 | `browser-proof/task-15-port-1-fix-2-root-projects/projects-evidence.json` |
| Catalog parser/provenance/lifecycle | 7 / 24 | Retained Fix2 | `browser-proof/task-15-port-1-fix-2-root-catalog/catalog-evidence.json` |
| Exact approval lookup and scope handoff | 7 / 12 | Retained Fix2 | `browser-proof/task-15-port-1-fix-2-root-scope/scope-evidence.json` |
| Agents profiles and committed-owner navigation | 7 / 10 | Retained Fix2 | `browser-proof/task-15-port-1-fix-2-root-agents/agents-evidence.json` |
| Conditional llama.cpp setup return | 5 / 8 | Retained Fix2 | `browser-proof/task-15-port-1-fix-2-root-setup/setup-evidence.json` |
| Original durable recovery and settlement | 8 / 18 | Retained Fix3 | `browser-proof/task-15-port-1-fix-3-root-durable/durable-evidence.json` |
| Deliberate bulk rejection and uncertainty | 8 / 20 | Retained corrected Fix3 | `browser-proof/task-15-port-1-fix-3-corrected-root-bulk/bulk-evidence.json` |
| Authenticated live notification bursts | 0 / 4 | Retained corrected Fix3 | `browser-proof/task-15-port-1-fix-3-corrected-root-notifications/notification-acceptance-evidence.json` |
| Governed Code source, keys and original outcome | 10 / 14 | **Fresh Fix4** | `browser-proof/task-15-port-1-fix-4-root-code/code-evidence.json` |
| Enlarged phone artifact and Library labels | 0 / 2 | Retained exact artifact run | `browser-proof/task-15-port-1-artifact-enlarged-root-1/artifact-enlarged-evidence.json` |

The retained boundary is narrow: Fix4 changed direct-focus Home/End handling only in the two evidence scrollers. Decision/access/recovery/record owners, notification delivery and links, and Projects/Agents/catalog/setup API owners remained unchanged. The independent source review and preservation checks establish that boundary; retained audits are attributed to their own runs.

### Separate operator outcomes

- **Code:** all four desktop/phone and dark/light original runs recorded `terminalStatus=completed`, `actualResultVerified=true` and exactly one decision write each. Cancel caused no decision. Changed immutable source was refused by the Gateway; unavailable/damaged evidence withheld approval, and damaged-source inspection recorded zero decisions. Complete source, scope, target, consequences and technical identity remained available. The decision receipt is separate from the original canonical execution/result.
- **Durable Chat:** actual desktop-dark and phone-light recovery resumed the original canonical run, persisted the decision and completed exactly one original tool plus assistant settlement. Stale checkpoint review and Cancel sent no mutation; a provably unsent preflight failure allowed a fresh deliberate review. Separate interrupted-submission cases remained locked across owner refetch and navigation remount. A completed `approval.wait` record is bookkeeping, not evidence that original work completed.
- **Bulk and notifications:** typed installation-wide rejection affected the owned requests across workspaces once; Cancel made zero mutations, a known completed receipt allowed a newly reviewed batch, bulk approval stayed unavailable, and uncertain submissions stayed locked through history remount. Four authenticated live-stream variant audits each observed a four-request burst through the canonical owner, real Sonner queue/promotion and visible keyboard controls. The action opened the exact server-authored `approvalId`/workspace native Inbox destination with zero notification-driven decisions. Three visible cards plus a hidden queued fourth are intentional; all four need not be simultaneously visible.
- **History and scope:** 120 canonical nonexecuting decisions were read through server-scoped cursor pages with complete unique retained history, oldest exact selection and zero inspection decisions. Reload/Back/Forward preserved the exact record, unrelated query and hash. Missing/foreign records withheld controls until an explicit authorized visible scope handoff; Cancel made no decision. Replay audit events and observability effects do not become original execution or approval authority.
- **Projects and fan-out:** native home/readiness, all seven intake actions into one Chat, scoped source-turn artifact binding/inspection/download and foreign-artifact withholding passed. Intake did not send messages. Prior Task14 assignment/fan-out and Fix1 unique sibling-owner source proof remain separately retained; these Port1 audits do not prove child execution, child cancellation or model-authored project completion. Source import proof covers review, Cancel and one missing-folder failure without creating a project; positive real repository import/clone remains held.
- **Catalog, Agents and setup:** owned local Markdown parser import and canonical provenance/lifecycle succeeded once; stale and unsupported activation were withheld. Catalog state never implied Chat activation or tool authority. Agents creation/edit/archive/restore, built-in/missing/stale gates and dirty committed-owner selection passed without a new tool grant. Both supported setup targets returned natively with scope and Back state intact, while unrelated records had no return action; no configuration or model change occurred.

Current caller, installation, workspace, expiry, revision, immutable evidence and uncertain-action remount gates remain authoritative. Neither a timestamp/status change nor a successful read can promote an unresolved attempt to success. Candidate callability and follow-on effects remain separate from approval, execution and catalog acceptance.

### Fresh native keyboard and enlarged review proof

R14 is now accepted within the measured native Code review. At 1440x900 and 390x844, in both dark and light themes and normal/200% root text, all **16 named-region cases** retained focus and a visible intersection after real Home, PageDown and End. Every key sampled the evidence region and enclosing dialog over **30 animation frames with a stable six-frame tail**. Home reached exactly 0; PageDown moved positively; End reached exactly `scrollHeight - clientHeight`. Full source remained available. The required visible intersection was at least 44px; actual settled measurements follow (each row passed in both themes).

| Viewport / root text | Action: Home / PageDown / End | Source: Home / PageDown / End | Visible action / source |
| --- | --- | --- | --- |
| Desktop 1440x900 / normal | 0 / 98 / 98 | 0 / 280 / 1154 | 288px / 320px |
| Phone 390x844 / normal | 0 / 204 / 204 | 0 / 280 / 2612 | 288px / 320px |
| Desktop 1440x900 / 200% | 0 / 196 / 196 | 0 / 560 / 2308 | 576px / 640px |
| Phone 390x844 / 200% | 0 / 504 / 1248 | 0 / 560 / 8140 | 576px / 620px |

The source repair handles unmodified Home/End only when the noneditable region itself is the focused event target. Page/arrow keys, Tab/ShiftTab, Escape, composition, modifiers and nested controls retain native behavior. No global Dialog change, smaller font, source truncation, overflow mask or approval-gate change was used. Prior trusted-key diagnostics remain diagnostic evidence: they proved naturally Tab-visible focus became hidden after Home. The earlier immediate-PageDown failure was separately identified as sampling native animation too early.

Independent Fix4 spec/quality review is **APPROVED, 0 Critical / 0 Important / 0 Minor**, retaining the scoped R1-R13 reviews. `task-15-port-1-fix-4-report.md` records 100 passing focused owner/caller tests, guarded typecheck/build and owned lint/design/diff checks. Source tests, diagnostic frames, browser audits and reviewer inspection remain separate evidence classes; their counts are not combined.

### Historical failures and remaining boundaries

Original Port1/Fix1 failed workflows, Fix2 enlarged Code clipping and missed authenticated notifications, invisible queued-toast focus, Fix3 global-label sampling and impossible all-four-visible toast waits, corrected Fix3 immediate-scroll timing, and both R14 hidden-focus diagnostics remain unchanged historical records. Root fixture/canonical-linkage and queue/key timing corrections are not product successes. The collector also initially treated two already accepted Agents check values as booleans; it was corrected to validate their exact-write/committed-selection metadata, without relaxing a behavior gate or promoting a failed manifest.

- Port2 retains Library Knowledge, external sources and remaining lifecycle actions; port3 retains Mail/browser/Journey/Curator/Improvement; port4 retains advanced Work/template/designer; port5 retains diagnostics/access and unresolved **FR-02 HIGH**; port6 retains authority/control; port7 retains prompt/workers/daemon.
- Positive project Git import remains held by the explicit no-stage/commit constraint. Native review/Cancel/failure and the Classic continuation remain. Neither the complete import inventory capability nor real clone/repository execution is marked verified.
- **Task16 remains unwaived:** `WorkBoard.tsx:136` refetch guard and missing `NativeRoutePages-*.css` output-shape budget assertion. Build success and this acceptance do not override either failure; no guard or build configuration was changed.
- Full parity, Classic retirement and release certification remain false. Explicit saved Classic and `?shell=classic` rollback remain through the required supported Stable release cycle. Installed/live hosts, live providers/workers, Ubuntu baselines, full PostgreSQL and a real supported Stable-cycle passage remain unverified.

This closure adds evidence only to the three assigned documents. All 233 original findings and 148 inventory rows keep their original fields, statuses, criteria, ordering, prior evidence and prior annotations; all preceding validation bytes remain an exact prefix. Product source/tests/output remain frozen. The final docs closure report records exact changed paths, hashes, preservation, coverage and diff checks, and full source/output/docs release.


## Task15 port2 source handoff — Knowledge, external sources and remaining Library lifecycle (2026-10-06)

This is source/owner-test evidence pending independent review and root's actual public-API/native browser acceptance. No full capability acceptance, Classic retirement or release certification is added. The original 233 findings, 148 inventory rows, previous annotations and earlier validation bytes remain preserved.

Native source now composes verified external-source registration/path bridge, sealed scan/catalog selection/plan/apply/exact replay, import provenance, read-only Chat attachment selection and the existing frozen routed-context send owner. Knowledge retains original approved-result readback without tool re-execution, adds current-caller/draft/preflight fences and hides retained excerpts until current source access is checked. Recovered snapshot events distinguish requests from created Knowledge documents; Knowledge documents remain distinct from lifecycle memory items.

Completed Chat turns now expose the actual Save as skill prepare/revise/send/reviewed-content hash-stage flow. Candidate versions retain immutable Instructions, Provenance and Validation evidence, guarded plan/approval/promotion/revocation/rollback owners, and local uncertainty across remount/new revisions. First promotion is eligible for a non-revoked selected version even while the inactive aggregate is not callable. Long artifact content has named focusable regions using the accepted evidence-scroll owner.

Remaining native Memory controls include TTL, namespace/lifecycle enumeration, atomic selected pin/unpin/forget approval, quality/evidence/feedback/recall, trace proposals, entities/relations/decision retrospective and maintenance policy/rebase/recommendation/run/provenance. The batch approval preview captures server-derived readable exact targets, scope and redacted requested changes; its native refresh re-reads original effect/history. Notes, reminders, files and resource previews preserve prior behavior with shared caller/uncertain-operation guards.

Engineering now offers creation from actual completed Code Mode sources with current canonical verification and nonempty complete changed-file evidence; the public proposal route derives source/files/evidence/project through the existing owner and still hashes actual allowed-root files. Client run IDs or text are insufficient. Inactive proposals, lifecycle requests, decisions and settled effects are separate. Replacement/consolidation approvals bind target provenance and same-workspace ownership; changed targets fail before persistence. Existing automatic verified-source capture remains supported. No Git mutation, fabricated verification source or fixture creation endpoint was used.

Executed validation (separate evidence classes):

- Native focused owner/UI tests: 9 files, 78 passed (Knowledge/exact import replay, source registration, Memory secondary/TTL, accepted notes/reminders/uploads, candidate lifecycle and workflow capture).
- Shared external-source API and approval evidence tests: 2 files, 28 passed. Threaded external attachment owner: 19 passed, including lost-response/remount/new-incarnation locking and exact frozen selection.
- Gateway Engineering canonical-source/target and route tests: 18 passed; MemoryLifecycleService: 32 passed. Route tests use mocked verified-source contracts, not real Code Mode execution.
- Guarded Mission Control and Gateway types, guarded production Mission Control build, owned-path ESLint (0 warnings), git diff --check, Gateway async boundary (16 guard tests; 1129 production files) passed.
- Cockpit classes/copy, legacy usage, tokens, typography, breakpoints, buttons, scroll contracts, icon sizes and contrast checks passed.

Unwaived checks: WorkBoard.tsx:136 refetch guard and expected NativeRoutePages stylesheet output shape remain Task16 carries. General verify:design:quality reports 7/8 passing and unchanged Testbench raw-color budget132>92; no color or guard edits are included. Earlier incomplete mocks and a React query-settlement timing failure were corrected, and the final focused suite passed. These results do not establish browser accessibility, responsive visuals, provider admission, public lifecycle effects, full PostgreSQL, Ubuntu, installed/live hosts or a supported Stable-cycle passage. Root owns those subsequent evidence lanes. Positive project Git import remains held; every Classic continuation and rollback remains.

Exact source ownership, frozen SHA-256 values, output hashes and immutable550-path preservation are recorded in the port2 handoff artifacts under .superpowers/sdd/2026-10-05-cockpit-remediation. No runtime was started by this source owner.


## Port 2 final accepted slice — 2026-10-06

Status: **accepted for the bounded native Windows behaviors below.**
- The earlier port2 source-handoff section and every failed, partial or diagnostic manifest remain historical evidence.
- This closes the scoped acceptance of port2: Knowledge, external sources and the remaining Library lifecycle.
- It does not certify every inventory capability, ports 3–7, Tasks 16–17, full parity, Classic retirement or a release.

### Collector result

The root acceptance collector, `task-15-port-2-accepted-evidence.json`, passed at 2026-10-07T05:43:22Z.
- **68 behavior groups / 250 loaded audits, all fresh** from one complete 8-helper run, `task-15-port-2-fix-11-claude-3`.
- No retained evidence.
- The collector verified **94 merged frozen product hashes** (port2 baseline through Fix11) and all 8 exact cleanup records: zero cleanup errors, providers closed, runtime roots removed, every process stopped.

Root also checked:
- no output lock and no remaining task process;
- every audit passed: zero blocking axe findings, zero browser errors, zero coarse-target failures, overflow ≤1px;
- all 34 geometry rows fit;
- the actual screenshots for each repaired surface (listed under "Separate outcomes").

Runtime results are distinct from source/DOM tests and from independent source review.

### Accepted evidence

All paths in this table are relative to `.superpowers/sdd/2026-10-05-cockpit-remediation/`.

| Accepted behavior | Groups / audits | Provenance | Exact evidence manifest |
| --- | --- | --- | --- |
| External source registration, sealed scan/paging, plan/apply, provenance | 4 / 28 | Fresh | `browser-proof/task-15-port-2-fix-11-claude-3-external/external-evidence.json` |
| Workflow capture and governed candidate lifecycle | 20 / 80 | Fresh | `browser-proof/task-15-port-2-fix-11-claude-3-workflow/workflow-evidence.json` |
| External attachment, ordinary Chat, governed copy and retrieval | 4 / 20 | Fresh | `browser-proof/task-15-port-2-fix-11-claude-3-external-context/external-context-evidence.json` |
| Interrupted Knowledge write recovery | 2 / 4 | Fresh | `browser-proof/task-15-port-2-fix-11-claude-3-knowledge-interrupted/knowledge-interrupted-evidence.json` |
| Memory batch actions and canonical effects | 16 / 48 | Fresh | `browser-proof/task-15-port-2-fix-11-claude-3-memory-batch/memory-batch-evidence.json` |
| Memory diagnostics, maintenance and recommendations | 14 / 48 | Fresh | `browser-proof/task-15-port-2-fix-11-claude-3-memory-diagnostics/memory-diagnostics-evidence.json` |
| Engineering learnings | 4 / 6 | Fresh | `browser-proof/task-15-port-2-fix-11-claude-3-engineering/engineering-evidence.json` |
| Import response-loss recovery | 4 / 16 | Fresh | `browser-proof/task-15-port-2-fix-11-claude-3-import-recovery/import-recovery-evidence.json` |

### Product repairs accepted in this slice

Each repair below has an independent source review in `task-15-port-2-fix-N-review.md`. Root dispositions and addendum corrections are in `task-15-port-2-fix-5-6-root-disposition.md`.

| Fix | Repair |
| --- | --- |
| Fix5 (P2-11, P2-12) | Captured candidates resolve lifecycle scope from the selected immutable version with no Code run; the phone External sources region is bounded; same-version rollback settles through verification. |
| Fix6 (P2-13) | Governed retrieval releases an approved external-source Knowledge copy only to its own workspace and conversation, after re-deriving the copy's identity, binding, link and item hash from the approval; trust stays `untrusted_external`. This gives Task10 R8's "withheld when current source read authority cannot be established" a defined, verified authority for governed copies only. Revocation or detach does not retract an existing governed copy, and session incarnation is not rechecked at read (Fix6 review M-2). |
| Fix7 (P2-14, P2-15) | Capability lifecycle approvals carry the selected version's workspace linkage (server-derived), so the native Inbox and approval bar can read them. The Knowledge workspace track and its controls are bounded so a long conversation title cannot widen sibling sections. |
| Fix8 (P2-17, P2-18) | The Knowledge review dialog content is bounded. Candidate continuation compares a token-auth requester under the same public redaction plus origin-workspace linkage; the Gateway does not itself compare requester to plan origin (Fix8 review M-3). |
| Fix9 (P2-19) | The workspace-scoped public capability catalog read projects that workspace's approved candidate instructions. The unscoped Mission Control Library catalog is unchanged (Fix9 review M-6). |
| Fix10 (P2-20) | The skill-capture disclosure state survives recreation of a virtualized transcript row. |
| Fix11 (P2-21, P2-22) | Candidate artifact and evidence scroll regions are named, focusable and focus-ringed. On phone, the read-only sources strip shows a one-line truthful status, with the exact notices one tap away (rendered once). |

### Separate outcomes

**External sources.**
- Covered: registration of the exact verified root, a 52-item sealed scan read through the real opaque cursor, selection that survives paging, plan Cancel(0) then Confirm(1), apply Confirm(1) with exact settlement, import provenance, and canonical lookup.
- Committed and noncommitted response-loss cases replay the exact sealed binding through the owner. Ordinary lookup never resets uncertainty.

**Workflow and candidates.**
- Covered: capture prepare, send and reviewed-hash stage from a completed turn on desktop and phone. Inactive staging is not activation or behavioral validation.
- Each variant ran:
  - artifact review, confirmation and one danger approval through the native approval bar;
  - continuation;
  - first promotion, with the runtime skill callable in the origin workspace;
  - same-version rollback as an honest no-op;
  - revocation, with callable withdrawn.
- Historical multi-version rollback is a separate owner-test boundary.

**Attachment, context and Knowledge.**
- Next-turn selection is disabled and its reason is stated. Ordinary original Chat completed without the source payload.
- The governed copy shows an exact reviewed target, scope and consequences, then Cancel(0), Approve(1), and one original materialization.
- Governed retrieval returns the exact copied chunk. Its snippet equals the exact prefix of the SHA-bound original normalized artifact. It carries `untrusted_external` provenance and is shown in a bounded dialog.
- Attachment/provider context, the materialized copy, the retrieval excerpt and the original governed tool result remain distinct. No configuration unlocks new-turn routed context.

**Memory.** Knowledge documents, lifecycle memory items and learned records remain distinct. Queued maintenance is not completed maintenance; recommendations are accepted separately.

**Images inspected by root:**
- external-context phone-dark ordinary result, showing the compact strip with the reply rendered;
- external-context desktop-light retrieval dialog, fully wrapped;
- workflow phone-light artifact review;
- workflow phone-dark capture guidance;
- external phone-light applied provenance.

### Root QA corrections (ignored helpers; never product successes)

These corrections fixed fixture assumptions, races and locator errors, and added failure-only evidence capture. None of them relaxes a behavior gate.
- Display audit slug normalization.
- Transcript-scoped and record-scoped locators.
- Exact-original snippet proof, recomputed with the product adapter and SHA-bound.
- Dialog geometry measured while the dialog is open, then the region measured after close.
- Waiting for the refreshed recommendation row.
- Phone notice expand/assert/collapse.
- Skipping the page-header Refresh behind the phone capability Sheet. The next action still asserts the canonical `expectedRevision`.
- Root errors that were themselves corrected: one Fix9 locator rooted at the dialog, and one prettier churn on a test file. That file was restored to its HEAD bytes plus the added lines only.

### Historical failures and remaining boundaries

**Failed runs retained.** All earlier failed, partial and diagnostic runs remain immutable historical records with their stated causes: Codex root-1 through Fix5, Claude Code `fix-6-claude-1` through `fix-11-claude-2`, and `claude-diagnostic-1` through `-14`.

**Intermittents (watched, not waived, not root-caused):**
- the Engineering `code_mode.run` decision dialog failed in 2 of 8 Claude Code full runs;
- External sources paging/region loss failed in 2 of 8 Claude Code full runs.

Both pass in isolation and passed in the accepted run. Failure-only evidence capture now records URL, dialogs, regions and a screenshot on recurrence. A remount from access-identity or gateway-gate changes under load is an unproven working hypothesis.

**Pre-existing defect carried.** P2-16: `change-plan-approval-reconciliation.integration.test.ts` fails at capture setup against the Fix4 author-chain requirement. It is a fixture repair, carried and not waived.

**Minor carries to Task17** (per-fix review files):
- I-1 vacuous `assertNotCallable` repoint;
- Fix6 M-1–M-5;
- Fix7 M-2/M-3/M-5/M-6;
- Fix8 M-1/M-2/M-5/M-6;
- Fix9 M-1–M-5, including curated-workspace candidate display, catalog-metrics workspace and workspaceId bounds;
- Fix10 M-1–M-3/M-5;
- Fix11 M-1–M-6, including the disclosure marker, breakpoint constant, shared Home/End handler, focus-ring clipping and an in-viewport reply assertion;
- P2-23: phone capability Sheet hides Library Refresh.

**Still unwaived or unverified:**
- `check:buttons` is red on pre-existing files.
- **Task16 remains unwaived:** the `WorkBoard.tsx:136` refetch guard, the NativeRoutePages CSS output shape and the Testbench raw-color budget.
- Positive project Git import and verified Engineering creation from a named workbench/Git source remain held. Their Classic continuations remain.
- Not established: Ubuntu baselines, full PostgreSQL, installed/live hosts, live providers/workers and a real supported Stable-cycle passage.
- Full parity, Classic retirement and release certification remain false.
- Explicit saved Classic and `?shell=classic` rollback remain.

### Closure scope

This closure adds evidence only to the three assigned documents.
- All 233 original findings and 148 inventory rows keep their original fields, statuses, criteria, ordering, prior evidence and prior annotations.
- The ledger gains only a top-level `task_15_port_2_accepted_slice`; no finding criterion is claimed.
- The inventory gains the same summary plus row annotations for `chat/root`, `library/knowledge`, `library/memory` and `library/capabilities`.
- All preceding validation bytes remain an exact prefix.

## Port 3 final accepted slice

**Accepted run.** `task-15-port-3-root-claude-1` is one fresh, complete 5-helper Windows native run against the merged frozen port3 source.
- 117 behavior checks and 136 loaded audits, covering both themes at desktop and phone.
- The collector `task-15-port-3-accepted-evidence.mjs` verified 46 merged frozen product hashes and all 5 cleanup records. Each record showed the Gateway and UI stopped, providers closed and the runtime root removed.
- No evidence is retained from earlier runs.

**Capabilities**

| Capability | Native destination | Checks / audits |
| --- | --- | --- |
| Mail | `/library/communications` | 29 / 36 |
| Browser sessions | `/system/browser-sessions` | 32 / 44 |
| Curator | `/library/curator` | 20 / 24 |
| Journey | `/library/journey` | 20 / 16 |
| Improvement | `/system/improvement` (experimental) | 16 / 16 |

- **Mail.**
  - Workspace-scoped drafts.
  - Exact-content review with Cancel 0 / Confirm 1.
  - One canonical high-risk approval per draft.
  - Lost-response lock with exact replay.
  - Inbox evidence is shown only when payload, preview and linkage agree.
  - Approving records operator intent only. Delivery is never confirmed.
- **Browser sessions.**
  - Idempotent session and grant create (request ID plus fingerprint; a mismatch returns 409).
  - Reviewed grants with a 1-hour default TTL and a 7-day cap.
  - Transactional rotate and conditional revoke/close, each with exact replay.
  - Foreign-scope refusal.
  - A grant never opens, binds or controls a browser.
- **Curator.**
  - Sort, dry-run report, skill detail and archived list.
  - Reviewed archive with exact replay, and an idempotent already-archived response.
  - Honest re-enable copy.
- **Journey.**
  - Read-only, with URL filters, NFKC session normalization and cursor paging.
  - Deep-linked event inspector.
  - Incomplete-producer and not-release-bearing boundaries stated.
- **Improvement.**
  - Inspection only.
  - Copyable Chat request; skill revisions are routed to Code Mode proposals.
  - Gateway-wide reports show their own evidence, with a replay link.
  - Reads the retained replay record.

**Earlier diagnostics kept immutable.** Every failed or diagnostic run from the port3 cycles stays in the QA directory with its recorded reason, including:
- `task-15-port-3-improvement-fix-1-claude-1`: an audit-count expectation, since corrected.
- `-claude-2` and `-claude-3`: environmental. A temporary runtime config was removed during startup, and an external recursive test run starved Gateway startup.

None of them counts as accepted evidence.

**Carried to Task17, unwaived:**
- P3-02: the pre-existing access-gate test.
- P3-11: the uncertainty lock does not survive a reload.
- P3-23: the shared-hook 4xx lock.
- P3-31 to P3-39 as recorded.
- P3-40: the "Ready for a Change Plan" label checks only activation readiness.
- P3-41: the harness score scale is unlabeled.
- P3-42 and P3-43: a scope note and test-coverage nits.
- P3-44: raw ISO week bounds.
- P3-45: the realtime approval toast persists after a decision and overlaps the phone review dialog.

**Boundaries**
- Native grant creation offers no "never expires" option; Classic still does. This awaits an operator decision.
- Saved Classic and `?shell=classic` rollback remain for every port3 capability.
- Full parity, Classic retirement and release certification remain false.
- Not established: Ubuntu baselines, full PostgreSQL, installed/live hosts, live providers/workers, real mail delivery and a real Stable-cycle passage.
- Task16 budgets and ports 4–7 remain open.

### Closure scope

This closure adds evidence only to the three assigned documents.
- All 233 findings and 148 inventory rows keep their original fields, statuses, criteria, ordering, prior evidence and prior annotations.
- The ledger gains only a top-level `task_15_port_3_accepted_slice` with `findings_claimed: []`.
- The inventory gains the same summary plus row annotations for `library/communications`, `ops/browser-sessions`, `library/curator`, `library/journey` and `ops/improvement`.
- All preceding validation bytes remain an exact prefix.

## Port 4 final accepted slice

**Accepted run.** `task-15-port-4-root-claude-2` is one fresh, complete 8-helper Windows native run against the merged frozen port4 source. It recorded 108 behavior checks and 104 loaded audits across both themes at desktop and phone.
- The collector `task-15-port-4-accepted-evidence.mjs` verified 32 merged frozen product hashes, across 14 freezes.
- All 8 cleanup records were verified: Gateway and UI stopped, providers closed and runtime roots removed.
- No evidence is retained from earlier runs.
- The earlier combined run `task-15-port-4-root-claude-1` is kept immutable as a diagnostic. It surfaced:
  - one helper race, since corrected;
  - one real defect: clicks swallowed during a background refetch, fixed in cycle 10.

**Capabilities**

| Capability | Where | Checks / audits |
| --- | --- | --- |
| Saved-board lifecycle | `/system/dashboards` | 20 / 24 |
| Saved-board editor conflict recovery | `/system/dashboards` | 16 / 16 |
| Saved-board details and realtime refresh | `/system/dashboards` | 8 / 8 |
| Guided schedule timing | `/work/schedules` | 12 / 12 |
| Scheduler review queue and last-run evidence | `/work/schedules` | 12 / 8 |
| Automation Designer persistence and dual export | `/work/automation` | 12 / 12 |
| Reviewed bulk task actions | `/work` | 16 / 16 |
| Compatibility redirects | `/ops/boards`, `/ops/schedules`, `/ops/kanban` | 12 / 8 |

- **Saved-board lifecycle.**
  - Reviewed archive and restore through the governed board owner. The owner re-reads first, sends an `expectedRevision` CAS request, checks the exact receipt and confirms by owner readback.
  - A lost response locks the board as uncertain, with canonical truth shown.
  - The archived list is URL-backed and labelled.
- **Saved-board editor conflict recovery.**
  - A newer revision offers **Keep my draft on revision N** or **Discard my draft**. A board with no edits offers only **Load revision N**.
  - A retained draft reopened behind a newer board offers the same choices.
  - A fresh create identity is offered only after an identity conflict.
- **Saved-board details and realtime refresh.**
  - Identity and history are shown in plain language, with request hashes in Technical details.
  - A concurrent rename reached the open board in about 210 ms with no reload.
- **Guided schedule timing.**
  - Frequency and time presets project onto the saved expression on create and edit, keeping any explicit timezone suffix.
  - **Gateway fix:** the weekday range `1-5` now means Monday to Friday in both cron parsers (the cron service and the system schedulers). It previously meant Monday only, including for schedules created through Classic.
- **Scheduler review queue and last-run evidence.**
  - The queue is read-only. A 409 is shown as unavailable, never as empty; it is switched off in the disposable runtime.
  - The last-run evidence ID is shown only when the Gateway reports one.
  - The populated-queue and evidence-shown paths are unit-tested only.
- **Automation Designer.**
  - The advisory preview and both template export results survive in-app navigation.
  - Nothing is scheduled, imported or run.
- **Reviewed bulk task actions.**
  - Select mode, then review, then Cancel (sends nothing) or Confirm (sends one request).
  - A fresh owner read runs before dispatch.
  - Pre-commit refusals (400/404/409) leave the tasks unlocked; unknown outcomes lock them.
  - Runtime runs are never selectable.
- **Compatibility redirects.**
  - `/ops/boards` and `/ops/schedules` now open natively, keeping query and fragment. Explicit `?shell=classic` still rolls back.
  - `/ops/kanban` stays Classic.

**Explicit gaps and carries (unwaived, Task17 unless noted)**
- **P4-23:** scheduler-review attention is not surfaced in the native Inbox.
- **P4-27:** Kanban agentic run evidence has no native owner. The Gateway's observe trace reads durable runs only.
- **P4-28:** the Classic Kanban page keeps its own copy of the bulk logic.
- **P4-16 (Task16):** `verify:architecture:metrics` is red with 19 regressions against the pinned baseline. Two are from port3 Gateway edits (browser sessions and curator), and 17 predate this work. The remedy is consolidation or operator-approved allowances; the baseline is never regenerated.
- **P4-13:** operator decision on timezone copy. The Gateway defaults to UTC, but the UI says the timezone is not reported.
- **Other items:** P4-01 to P4-32 as recorded in the port4 report.

**Boundaries**
- Saved Classic and `?shell=classic` rollback remain.
- Full parity, Classic retirement and release certification remain false.
- Not established: Ubuntu baselines, full PostgreSQL, installed or live hosts, live providers or workers, and a real Stable-cycle passage.

### Closure scope

This closure adds evidence only to the three assigned documents.
- All 233 findings and 148 inventory rows keep their original fields, statuses, criteria, ordering, prior evidence and prior annotations.
- The ledger gains only a top-level `task_15_port_4_accepted_slice` with `findings_claimed: []`.
- The inventory gains the same summary plus row annotations for `ops/boards`, `ops/schedules` and `ops/kanban`. The `ops/kanban` annotation is partial: bulk actions only.
- All preceding validation bytes remain an exact prefix.

## Port 5 final accepted slice

Owner: Claude Code root continuation, 2026-10-08. Accepted manifest `.superpowers/sdd/2026-10-05-cockpit-remediation/task-15-port-5-root-claude-1-accepted.json`: 88 behavior checks and 92 loaded audits from one fresh complete 8-helper run; 111 merged frozen product hashes verified; every cleanup record verified.

| Helper | Checks / audits |
| --- | --- |
| provider-attempts | 12 / 12 |
| connection-attempts | 12 / 16 |
| auth-attempts | 12 / 12 |
| integration-attempts | 12 / 12 |
| channel-attempts | 12 / 12 |
| mcp-recovery | 12 / 12 |
| provider-parity | 8 / 8 |
| runtime-parity | 8 / 8 |

**FR-02 (lost-response recovery).** Mutation attempts carry an in-memory attempt key and Gateway installation; a lost response locks the owner until the Gateway's idempotency record of that exact attempt is read (pending/absent/expired keep the lock; completed or released unlock only after a fresh canonical readback, re-checking the installation after every await). A released create is never replayed; a committed create replays its plan key only. Native recovery evidence: provider, provider-connection, gateway-auth, integration-connection, channels, mcp. Focused tests only: managed-runtime, llama-cpp-setup, local-ai. FR-02 is not claimed closed.

**Secret-hash redaction.** Idempotency payload hashes for provider secret and Gateway auth routes are path-only going forward. Purging historical secret-derived `payload_hash` rows on existing installations is an operator decision (P5-01).

**Classic parity.** Ported to the cockpit: cross-provider model search, Codex "Use for Chat" (staging only), provider connection details, llama.cpp lifecycle with a reviewed owned-process stop, and desktop/mobile continuity checks. Already at parity: default routing, diagnostics export, daemon controls (the Gateway refuses them). Retired, not ported: NPU normalize.

**Chat glossary.** Cockpit Chat activity, run, inspector, background-task and composer copy uses messages/responses/background tasks; protocol ids, Gateway error text and technical details are unchanged.

**Carries.** P5-01 (historical hash purge, operator decision); P5-07 to P5-10 and P5-11 (pre-existing suite failures and the integration confirm no-op); C1-2/3, C1b-1/2/3, C2-1..4, C3a-1, C3b-1/2, C6-1, C7-1..6, CX-1..3, C8a-1..3, C8b-1..6, C9-1/2 as recorded in the port5 report.

**Boundaries.** Saved Classic and `?shell=classic` rollback remain. Full parity, Classic retirement and release certification remain false. Not established: Ubuntu baselines, full PostgreSQL, installed or live hosts, live providers or workers, and a real Stable-cycle passage.

### Closure scope

This closure adds evidence only to the three assigned documents. All 233 findings and 148 inventory rows keep their original fields, statuses, criteria, ordering, prior evidence and annotations. The ledger gains only a top-level `task_15_port_5_accepted_slice` with `findings_claimed: []`; the inventory gains the same summary plus row annotations for `settings/providers`, `settings/access`, `settings/runtime`, `settings/integrations`, `settings/channels`, `settings/mcp`. All preceding validation bytes remain an exact prefix.

## Port 6 final accepted slice

Owner: Claude Code root continuation, 2026-10-08. Accepted manifest `.superpowers/sdd/2026-10-05-cockpit-remediation/task-15-port-6-root-claude-1-accepted.json`: 8 behavior checks and 8 loaded audits from one fresh complete run; 19 merged frozen product hashes verified; cleanup verified.

| Helper | Checks / audits |
| --- | --- |
| runtime-views | 8 / 8 |

**Natively accepted (read-only).** Runtime authority map in System > Diagnostics; recent sessions across channels in System > Activity.

**Implemented with focused tests only.** Session control in the Chat inspector (reviewed handoff, revoke and emergency takeover, re-read and generation-bound, same-key retry, definitive 409); mesh capability publications in Library (exact-entry activation that never duplicates a live activation or a pending approval, reasoned revoke, read-only invocation outcomes). Native proof needs a live external control client and an admitted mesh node.

**Verified without change.** Governed Code stays one capability inside Chat: the cockpit lazily mounts the shared Code workbench, and Inbox keeps the code_mode.run specialist gate with the original Code outcome shown separately. No Code run, sandbox or remote execution is claimed.

**Not ported.** Remote workers remain Classic-only: implementation-hold (HX-507) and outside the visible release surface.

**Carries.** C6.1-1..3, C6.2-1..3, C6.3-1..3, C6.4-1/2, C6.5-1, C6.6-1 and P6-F1 as recorded in the port6 report.

**Boundaries.** Saved Classic and `?shell=classic` rollback remain. Full parity, Classic retirement and release certification remain false. Not established: Ubuntu baselines, full PostgreSQL, installed or live hosts, live providers, workers or mesh nodes, and a real Stable-cycle passage.

### Closure scope

This closure adds evidence only to the three assigned documents. All 233 findings and 148 inventory rows keep their original fields, statuses, criteria, ordering, prior evidence and annotations. The ledger gains only a top-level `task_15_port_6_accepted_slice` with `findings_claimed: []`; the inventory gains the same summary plus row annotations for `ops/diagnostics`, `ops/activity`, `ops/sessions`, `library/capabilities`, `ops/workers`. All preceding validation bytes remain an exact prefix.

## Port 7 final accepted slice

Owner: Claude Code root continuation, 2026-10-08. Accepted manifest `.superpowers/sdd/2026-10-05-cockpit-remediation/task-15-port-7-root-claude-3-accepted.json`: 8 behavior checks and 4 loaded audits from one fresh complete run; 10 merged frozen product hashes verified; cleanup verified.

| Helper | Checks / audits |
| --- | --- |
| prompt-packs | 8 / 4 |

**Natively accepted.** Library > Prompt packs mounts the shared prompt-pack workbench in the cockpit (lazy, workspace-scoped, pack focus, native Chat navigation). Native proof found two real accessibility defects in the shared workbench lists (the empty-filter message inside the tests list, and list semantics on the pack buttons); both are fixed for the cockpit and Classic mounts.

**Verified without change.** Daemon controls: the Gateway refuses start/stop/restart and the cockpit shows the truthful process-owner handoff.

**Not ported.** Remote workers stay hidden (HX-507 implementation-hold).

**Carries.** C7.1-1..4 as recorded in the port7 report (selected-pack state, live-provider runs not exercised, System Quality links still Classic, shell-scoped CSS).

**Boundaries.** Saved Classic and `?shell=classic` rollback remain. Full parity, Classic retirement and release certification remain false. Not established: Ubuntu baselines, full PostgreSQL, installed or live hosts, live providers or workers, and a real Stable-cycle passage.

### Closure scope

This closure adds evidence only to the three assigned documents. All 233 findings and 148 inventory rows keep their original fields, statuses, criteria, ordering, prior evidence and annotations. The ledger gains only a top-level `task_15_port_7_accepted_slice` with `findings_claimed: []`; the inventory gains the same summary plus row annotations for `library/prompt-packs`, `ops/runtime`, `ops/workers`. All preceding validation bytes remain an exact prefix.
