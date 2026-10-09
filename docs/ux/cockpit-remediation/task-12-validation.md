# Task 12 source validation — 2026-10-06

Task 12 supplies provisional source/test evidence for shell continuity and native Settings. It does not certify browser, external connector, installed-host, Ubuntu, or global Classic parity. FR-02 remains open/partial and is carried to Task 15 port 5. Original finding fields and earlier-task acceptance remain authoritative; this document adds evidence without closing them.

## Source batches

- Shell: `apps/mission-control-next/src/cockpit/app/{IncomingScopeReview,ScopeSwitcher,CockpitShell,MobileTabBar,CockpitAccessGate,CommandPalette,CommandPaletteResults}.tsx`, `use-cockpit-scope.ts`, `cockpit-back-guard.ts`, `use-cockpit-scroll.ts`, `cockpit-compatibility.ts`, `cockpit/ui/Sheet.tsx`, and `cockpit/data/use-citadel-name.ts`. Incoming scope is visibly reviewed through authorized directories; accepted choices update existing scope parameters and preserve unrelated query/hash/history state. Phone names reuse the existing directory query, with IDs under shared technical disclosure. Back consumes the top sheet; route/caller/scope scroll positions remain app-session state. Misconfigured access exposes its Gateway message and retry. Runtime-control navigation remains explicit Classic fallback, not Health.
- Caller continuity: `packages/mission-control-shared/src/api/access-scope.ts`, `features/native-routes/library/{session-drafts,transient-input-owner}.ts`, and `cockpit/areas/work/{TaskDetailsEditor,WorkScheduleEditor,UnattributedDraftRecovery}.tsx`. Existing caller-scoped keys now update mounted editors on verified-caller handoff; late saves remain bound to their submitting caller. Unattributed public input requires explicit recovery and keeps original bytes. Credentials have no unattributed recovery.
- Providers: `cockpit/areas/settings/{ModelsSettings,AppearanceSettings}.tsx`, `features/native-routes/settings/credential-input-owner.ts`, `sections/use-provider-credentials.ts`, and `sections/provider-mutation-state.ts`. Guided/Expert is a presentation preference. Expert collapse classifies caller-prefixed dirty keys correctly. Credentials live in a dedicated volatile owner; generic change continuation stores an opaque local submission receipt, never credential bytes. Provider checks retain existing catalog, no-change, revision, diagnostics and secure-plan behavior.
- Integration custody: `apps/gateway/src/services/integration-public-input.ts`, `routes/integrations-control-routes.ts`, and native `IntegrationFormFields.tsx`, `IntegrationConnectionEditor.tsx`, `IntegrationConnectionsSettings.tsx`, `sections/use-integration-settings-state.ts`. Ordinary configuration POST/PATCH rejects plaintext credential-shaped fields and requires schema-supported environment-variable references. Native generic JSON is inspection-only; channel/provider creation goes through its dedicated owner. This does not add generic connector keychain custody. Legacy saved credentials remain owner-projected/masked.
- Channels: `apps/gateway/src/routes/integrations-channel-setup-routes.ts`, `services/channel-setup-service.ts`, shared `api/{client,integrations}.ts`, native `ChannelsSettings.tsx`, `ChannelDraftEditor.tsx`, `ChannelLifecycleControls.tsx`, and shared channel input/mutation hooks. Guided typed input uses the existing secure-fields owner. Revision-reviewed saved-draft deletion removes temporary custody; cleanup failure is marked committed. Disable/remove use the existing connection owner. Exact canonical readback is required before success; failed readback retains uncertainty. Caller/access/history changes invalidate a lifecycle review.
- MCP: `McpServerCreate.tsx` presents advertised templates before manual fields and guards replacement of dirty input. `McpServersSettings.tsx` names its connection controls explicitly. Existing transport/auth/network/policy checks and reviewed lifecycle owners remain unchanged; template membership proves neither connectivity nor permission.
- Local AI/release: `SettingsArea.tsx`, `LocalAiSettings.tsx`, `settings-index.ts`, and `cockpit-compatibility.ts` compose existing llama.cpp setup, readiness, and expert managed configuration in Models → Local AI. Advisory approvals are disclosed as having no execution. Hidden direct links do not mount hidden owners. NPU remains experimental. Budget remains a cost preference. `permission-helpers.ts` uses approved Low/Medium/High/Critical labels; `gateway-access.css` uses the existing type token.

## Reproduction and executed results

Run from the assigned remediation worktree. No dependencies were installed. Test files below are relative to their `--root`.

Frontend command: `node_modules/.bin/vitest.cmd run --root apps/mission-control-next <files>`; final group **27 files / 289 tests passed**:

```text
src/features/native-routes/library/session-drafts.test.tsx
src/features/native-routes/settings/credential-input-owner.test.tsx
src/features/native-routes/settings/channel-setup/ChannelSetupWizard.test.tsx
src/cockpit/areas/settings/ProviderConnectionSettings.test.tsx
src/cockpit/app/use-cockpit-scope.test.tsx
src/cockpit/app/cockpit-compatibility.test.ts
src/cockpit/areas/chat/ChatArea.owner-navigation.test.tsx
src/cockpit/areas/settings/ModelsSettings.test.tsx
src/cockpit/areas/settings/McpRegistration.test.tsx
src/cockpit/areas/settings/McpServerCreate.test.tsx
src/cockpit/areas/settings/settings-index.test.ts
src/cockpit/app/cockpit-back-guard.test.ts
src/cockpit/app/CockpitNavigationProvider.test.tsx
src/cockpit/app/CockpitShell.test.tsx
src/cockpit/app/CockpitAccessGate.test.tsx
src/cockpit/app/CommandPalette.test.tsx
src/cockpit/app/use-cockpit-scroll.test.tsx
src/cockpit/app/inspector.test.tsx
src/cockpit/areas/settings/SettingsArea.test.tsx
src/cockpit/areas/settings/ChannelLifecycleControls.test.tsx
src/cockpit/areas/settings/IntegrationConnectionsSettings.test.tsx
src/cockpit/areas/settings/IntegrationManagementSettings.test.tsx
src/cockpit/areas/settings/LocalAiSettings.test.tsx
src/cockpit/areas/settings/ManagedRuntimeSettings.test.tsx
src/cockpit/areas/settings/DeviceAccessSettings.test.tsx
src/cockpit/areas/work/TaskDetailsEditor.test.tsx
src/cockpit/areas/work/WorkScheduleEditor.test.tsx
```

Additional provider group, same command: **5 files / 50 tests passed**:

```text
src/features/native-routes/settings/sections/use-provider-mutations.test.tsx
src/features/native-routes/settings/sections/ProviderPresentation.test.tsx
src/cockpit/areas/settings/ProviderManagementSettings.test.tsx
src/cockpit/areas/settings/ProviderCatalogSettings.test.tsx
src/cockpit/areas/settings/ProviderChangeStatus.test.tsx
```

Gateway command: `node_modules/.bin/vitest.cmd run --root apps/gateway <files>`; **6 files / 44 tests passed**:

```text
src/services/channel-setup-service.contract.test.ts
src/services/integration-public-input.test.ts
src/routes/integrations.connection-revisions.test.ts
src/services/channel-secret-custody-service.test.ts
src/services/channel-setup-public-projection.test.ts
src/routes/integrations.channel-setup.test.ts
```

Shared command: `node_modules/.bin/vitest.cmd run --root packages/mission-control-shared src/api/access-scope.test.ts src/api/inbox-local-read-store.test.ts`; **2 files / 6 tests passed**.

Guarded commands passed:

```text
node scripts/run-with-worktree-output-lock.mjs --label=task-12-final-frontend-typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck
node scripts/run-with-worktree-output-lock.mjs --label=task-12-final-gateway-typecheck -- pnpm --filter @goatcitadel/gateway typecheck
git diff --check
```

Frontend typecheck built existing shared/threaded dependencies through their normal scripts. `pnpm --filter @goatcitadel/mission-control-next perf:check` passes cockpit classes/copy then stops on pre-existing refetch findings in `ChatBlockers.tsx:109` and `WorkBoard.tsx:136`, carried to Tasks 13/16. Individually executed `node scripts/check-mission-control-next-{legacy-usage,token-drift,typography,breakpoints,buttons,scroll-contracts,icon-sizing,contrast,budgets}.mjs` all passed. The budgets script inspects existing bundle output; this is not a fresh production bundle certification. No guard/budget was weakened.

Red-to-green: corrected runtime fallback's missing visit marker; changed channel retained-input assertions to its dedicated custody owner; replaced a generic raw-secret test fixture with a supported environment reference and added plaintext rejection tests; corrected hidden-route assertions to the required release gate. Two shell assertions were reconciled with accepted Tasks 8/10 (decision count and native Knowledge). Phone-name tests now expect the shared authorized-directory read. The new deletion test was corrected to the actual secure-owner argument shape; Happy DOM queued hashchange is settled before review clicks. Product regressions and fixture changes are distinguished in the ignored task report.

## Browser handoff contract

- Incoming link: region `Linked scope review`, button `Review linked scope`; dialog `Change operating scope`; fields `Scope Citadel`, `Scope Workspace`; action `Switch scope`. Query parameters request a view, never authorize scope.
- Phone: `Current operating scope` shows directory names or explicit unavailable text. The More tab shows `Settings`/`System` and `aria-current=page` there. Its accessible name remains `More areas and settings`. `Operating scope identifiers` appears inside More only when shared technical detail is enabled. Back closes the top sheet before navigation; Escape/close restore the opener.
- Access: `Gateway setup needs attention`, authoritative Gateway message, `Try again`, `Open classic view`.
- Provider presentation: `Settings presentation` Guided/Expert. Existing provider plan/revision/add-key owners remain the action contract.
- Channels: `Delete saved draft`, `Review disable channel` / `Review enable channel`, `Remove channel connection`; dialog `Review channel lifecycle change`; `Apply reviewed channel change` / `Keep current channel state`.
- New route: `DELETE /api/v1/channels/drafts/:draftId`, body `{expectedRevision:number}`, receipt `{draftId,deleted}`. Existing secure route remains `POST /api/v1/channels/drafts/:draftId/secure-fields`, body `{expectedRevision,values:Record<allowedField,string>}`. Public reads return masked configured/custody state, never credential values.
- MCP: `Register MCP server`, `Use an advertised template`, `Use <label> template`, existing registration review controls. Saved-row `Connections, tools and transport` opens the existing reviewed owner.
- Legacy `/settings/onboarding?view=llamacpp` resolves to `/settings/models?view=llamacpp#local-ai`; explicit Classic input remains Classic. `Advisory approval requests (no execution)` is separate from actual llama.cpp setup.

## Open gates

FR-02 remains OPEN/partial. `use-settings-change.tsx` can reconcile a known plan receipt with matching plan/target/revision and canonical settings. Provider mutation state, channel mutation state, integration connection mutation, MCP mutation owners, managed-runtime/llama setup state and gateway-auth state retain missing-receipt uncertainty. Canonical current configuration alone cannot attribute a lost write, establish secret-value identity, prove process/side-effect settlement, or safely repeat external effects. Task 15 port 5 owns exact receipt/correlation reconciliation and lost-response acceptance. Refresh inspection does not unlock these actions; misleading advice in provider/channel uncertainty was corrected.

Root must supply actual desktop/mobile/keyboard/browser history, same/cross-Citadel bookmarks, token/basic caller continuity, connector HTTP/schema rejection and unavailable-custody proof. Root's disposable runtime deliberately disables the secret store and preserves host keychain. The positive custody tests above execute the actual custody service with an injected in-memory store; they do not prove Windows keychain or Ubuntu secret-service behavior. A disposable-profile platform test remains required for actual keychain storage/promotion/deletion. External channel delivery, external MCP authentication/tool calls, model downloads/serving, installed desktop, Ubuntu and named security/auth/runtime/async release lanes were not executed by this source owner. No runtime was started, user credential read, dependency installed, Git staging/commit/publication, or installed-profile modification performed.

## Task 12 fix 1 — independent review corrections (2026-10-06)

T12-R1: `McpServerCreate` now uses `use-mcp-template-replacement` for template replacement. Dirty input opens **Replace MCP registration draft?**. **Keep current draft**, **Close dialog** and Escape preserve every field. Only **Replace draft with template** copies the complete advertised transport, URL, command/arguments, authentication references, enabled state and policy; it performs no registration request. Generic registration close still uses the shared draft-leave owner. The replacement review is invalidated by caller/access, Gateway, workspace, input-version/value and advertised-template changes. Confirmation also checks the live query owner and current access identity. Access invalidation closes the registration review without repeatedly opening an unsaved-leave decision; the caller-bound input remains retained.

T12-R2: the public integration validator now distinguishes schema URL fields from text `*Env` references. `automation.webhooks.baseUrl` (**Webhook Base URL**) and `automation.activepieces.webhookUrl` (**Webhook URL**) accept public HTTP(S) endpoint configuration; their public response redaction is unchanged. True ENV fields still require the supported uppercase environment-variable-name format. URL help now explains public endpoints and unchanged masks, rather than instructing users to enter an ENV name.

`POST /api/v1/integrations/connections` accepts supported public values and ENV references, returning 201. `PATCH /api/v1/integrations/connections/:connectionId` validates against that route's current canonical connection, accepts exact unchanged public masked values, and delegates restoration to the existing projection owner and revision compare-and-swap service. A mask cannot create a credential or move a secret between fields/connections. New raw credentials, credential-bearing URL replacements, invented/case-changed/encoded masks and modified masked URLs are rejected before persistence. Nested unchanged masked leaves remain supported; arrays containing masks must retain their exact saved public projection. No generic credential custody or new connector execution capability was introduced. Unsupported credential-bearing URL creation/replacement remains unavailable through this form; existing supported connector owners/references remain authoritative.

Focused proof (test API injection uses real Fastify routes, mutation services, SQLite repository and projection owners; no listening runtime):

- RED: MCP replacement suite had 6 failed new branches / 1 prior pass; Gateway connection-revision suite had 3 failed new cases / 16 prior passes. The failures reproduced missing dedicated replacement review and URL/masked-field rejection. Initial harness corrections used the existing `Close dialog` icon name and existing POST 201 response.
- GREEN: frontend 6 files / 40 tests; Gateway 5 files / 74 tests. Full field preservation is checked after Keep, Close and Escape, full OAuth/transport/policy copying after explicit Replace, zero registration writes, and stale draft/caller/access/Gateway/workspace/template invalidation. Gateway proof covers both public URL catalogs' create/edit/canonical readback, two separately owned masked webhook roundtrips, raw URL and invented mask rejection with unchanged canonical value/revision, ENV validation, existing stale-review/intervening-write/auth/idempotency tests and projection/service regressions.
- The pre-existing control-route projection test still expected generic plaintext credential creation. Its request now uses an ENV reference; service-owned synthetic response secrets still exercise redaction. This reconciles the assertion with the accepted custody boundary, without relaxing that boundary.
- Guarded frontend typecheck (including shared/threaded dependency builds) and guarded Gateway typecheck passed. Full `perf:check` retains only the recorded ChatBlockers:109 and WorkBoard:136 refetch failures; all remaining individual design checks passed, including typography and contrast. Bundle budgets inspect existing output; no fresh bundle claim. `git diff --check` passed.

Exact commands and logs are in `.superpowers/sdd/2026-10-05-cockpit-remediation/task-12-fix-1-report.md`; additive preservation evidence is `task-12-fix-1-preservation.json`. No original ledger/parity metadata or prior evidence is replaced. Root's already accepted custody seven checks and provider four cases / twelve audits remain separate evidence. Root owns subsequent actual affected browser/API proof and scoped independent re-review. FR-02 stays OPEN/partial for Task 15 port 5; this correction does not settle missing receipts or certify full parity, positive OS custody, installed hosting, external effects or remaining named release gates.

## Task 12 fix 2 — normalized URLs and document-entry sheet Back (2026-10-06)

T12-R3: the URL field exemption now parses once, rejects ASCII control/space/backslash spellings and parsed username/password, and checks both submitted and canonical serialized URLs against the existing public secret projection. Normalization cannot conceal sensitive query/path components. Exact saved public masks still go through the existing same-connection preservation owner; supported clean public URLs and true ENV references remain covered by the prior positive route tests. Rejected POSTs create no record; rejected PATCHes leave canonical values and revisions unchanged, with no synthetic credential in mutation/read responses and no realtime publication. No new credential custody was added.

T12-R4: the existing cockpit Back owner now gives each open sheet a temporary same-document history entry with the exact URL/query/hash and preserved underlying history state. Back closes the top sheet before the dirty-route owner is consulted. Close/Escape retire the overlay entry; ordinary Back then reaches the preceding route and Forward returns to the selected route. Inactive sheet entries are skipped rather than exposed as extra route stops. Reloaded orphan entries are retired before another sheet opens. Deferred traversals and StrictMode cleanup/remount are coordinated before pushing another sheet. Already-reviewed navigation first retires the sheets and then commits from the underlying page, preserving push/replace semantics. The navigation provider and canonical Chat URL publisher retain and recheck their existing scope capability after this asynchronous cleanup; no parallel selection/dirty/auth owner is introduced. The shared Sheet's existing focus restoration and accessible labels are unchanged.

Focused RED/GREEN:

- Gateway RED: four new route cases failed across two catalogs × POST/PATCH. GREEN: three files / **51 tests**, including **28** normalized credential URL attempts (seven variants × two catalogs × two mutation methods), ordinary URL create/edit, unchanged masks, ENV semantics and existing projection/revision/auth checks.
- History RED: the isolated immutable-baseline replay failed all three initial-document/reloaded-document/SPA entry cases for the missing same-document sheet entry. The replay restored the two current source files byte-for-byte in `finally`, verified before GREEN. An earlier broader RED run also cascaded after failed test cleanup; that diagnostic is preserved separately and is not counted as twelve distinct product defects.
- Frontend GREEN: six files / **62 tests**, including the real unmocked Vaul Sheet and real navigation provider. Back/Close/Escape preserve route/state and trigger focus, ordinary route Back/Forward remain usable, top ordering/retired lower entries/StrictMode/deferred capability cancellation/replacement/reload-orphan recovery pass. Happy DOM models history entries and event ordering; actual full-document browser unload/reload remains root's required acceptance boundary.
- One stale MobileTabBar test expected the old all-items Inbox badge. Its assertions now match accepted Task 8 outstanding-decision counts; no Inbox production behavior changed.
- Guarded frontend typecheck with shared/threaded builds and guarded Gateway typecheck pass. Full perf retains only the previously accepted ChatBlockers:109 and WorkBoard:136 carries; remaining individual design checks pass without changed budgets. `git diff --check` and additive preservation checks pass.

Full commands, files and logs: `.superpowers/sdd/2026-10-05-cockpit-remediation/task-12-fix-2-report.md`; preservation: `task-12-fix-2-preservation.json`. All prior 430/433 baseline paths and the original 233 finding / 148 inventory evidence remain preserved. Root retains scope ten checks / eighteen audits and provider four cases / twelve audits, plus its separately reported ordinary integration/custody proof. Full metadata remains unaccepted until root reruns the actual phone Back gate; prepared scripts and partial metadata are not acceptance. No listening runtime, browser stack, external endpoint, real credential/profile, OS custody, installed payload, Git publication or dependency change was used by this source owner. FR-02 remains OPEN/partial for Task 15 port 5; all previously named platform/external/release limits remain.

## Task 12 fix 3 — skipped sheet base and dirty-route authority (2026-10-06)

The scoped fix2 review and root's actual Chromium RED confirmed that a multi-entry traversal could skip a sheet's base, change the URL to an older route and bypass the dirty-route owner while the old editor stayed visible. `cockpit-back-guard.ts` now directly consumes only the exact overlay-to-base position and full href. A skipped base closes only the intended top sheet and restores/freezes its exact base; it does not silently follow the older route. A subsequent Back closes any remaining sheet before the existing dirty-route owner decides a route change. An unrelated landing during deferred cleanup similarly cancels the stale completion and restores the intended base. Without a trustworthy restoring delta, the event reaches the existing dirty guard/notification path. The normal guard's own restoration takes precedence over retired-sheet processing, and expected restoration hash events remain suppressed until consumed.

Shared review semantics remain unchanged: **Unsaved changes** → **Cancel** keeps exact route/input; **Keep draft and close** retains input and authorizes navigation; **Discard changes** discards and authorizes navigation. No save/mutation owner is invoked by these history repairs. Ordinary Back/Close/Escape/focus, exact state/query/hash, push/replace, stacked/deferred/StrictMode, reload-orphan and stale-capability behaviors remain covered. There are no Work, CSS, Gateway, security, budget or caller-recovery changes in fix3.

- RED: `task-12-fix-3-red.log` records all three new real-owner cases failing before the correction: single sheet, nested sheets and unrelated deferred-cleanup landing.
- GREEN: **7 frontend files / 67 tests**, including real unmocked Vaul Sheet, real `CockpitNavigationProvider`, and actual shared session-draft/dirty owners. Cancel preserves the selected route/input; one authorized Keep continuation returns to the older route and Forward recovers retained input; Discard continuation and Forward recover canonical saved input. An unnumbered skipped target also reaches the existing dirty owner.
- Guarded frontend typecheck plus shared/threaded builds pass. Individual design guards pass except the same ChatBlockers:109 / WorkBoard:136 refetch carries for Tasks 13/16. Budgets use existing output and were not changed. Diff/preservation checks pass; no unrelated Gateway or full suite rerun.

Commands and limits are in `.superpowers/sdd/2026-10-05-cockpit-remediation/task-12-fix-3-report.md`; preservation is `task-12-fix-3-preservation.json`. All 436/433/430 prior baseline paths, original 233 findings, 148 inventory rows and earlier evidence remain preserved; this document is additive. Root reports Basic and Token native recovery each passing three checks/two audits after correcting pointer-emulation fixture state; no Work/CSS product repair was required. Root retains its earlier metadata, scope, normalized URL, custody, integration and provider results and owns affected actual multi-entry/browser acceptance plus scoped re-review. This local test proof does not certify actual browser document traversal, external effects, platform custody, installed hosting or global parity. FR-02 remains OPEN/partial for Task 15 port 5 with uncertainty locks intact.

## Final bounded Task12 acceptance — 2026-10-06

Root's actual `task-12-fix-3-summary.json` at 15:42:24Z passes **71 behavior checks / 72 loaded browser audits**. This combines retained API/provider acceptance with fresh affected Windows Chromium proof; it is not 71 newly executed fix3 checks. Evidence paths below are relative to `.superpowers/sdd/2026-10-05-cockpit-remediation/`. The final independent `task-12-fix-3-review.md` reports scoped spec/code-quality PASS, zero Critical/Important/Minor findings and T12-F2-R1 addressed; it does not certify global parity.

| Batch | Checks / audits | Provenance | Evidence |
|---|---:|---|---|
| custody-api | 7 / 0 | Retained earlier acceptance | `browser-proof/task-12-fix-2-custody-api/custody-api-evidence.json` |
| integration-fields | 5 / 0 | Retained earlier acceptance | `browser-proof/task-12-fix-2-integration-fields/integration-field-evidence.json` |
| normalized-url | 16 / 0 | Retained earlier acceptance | `browser-proof/task-12-fix-2-normalized-url/normalized-url-evidence.json` |
| provider-drafts | 4 / 12 | Retained earlier acceptance | `browser-proof/task-12-frozen-provider-drafts/provider-draft-evidence.json` |
| shell-scope | 10 / 18 | Fresh fix3 | `browser-proof/task-12-fix-3-shell-scope/shell-scope-evidence.json` |
| settings-metadata | 18 / 34 | Fresh fix3 | `browser-proof/task-12-fix-3-settings-metadata/settings-metadata-evidence.json` |
| non-chat-basic | 3 / 2 | Fresh fix3 | `browser-proof/task-12-fix-3-non-chat-basic/non-chat-draft-evidence.json` |
| non-chat-token | 3 / 2 | Fresh fix3 | `browser-proof/task-12-fix-3-non-chat-token/non-chat-draft-evidence.json` |
| sheet-multi-entry | 5 / 4 | Fresh final follow-up (summary retains its separately named final batch) | `browser-proof/task-12-fix-3-final-sheet-multi-entry/sheet-multi-entry-evidence.json` |

Fresh scope proof covers four device/theme variants, reviewed same/cross-Citadel handoff, exact record/query/hash/history state, reload, verified scope names and ordinary history. Fresh metadata proof covers native channel typed setup and Cancel/confirmed canonical deletion; MCP Keep/Escape field preservation and zero POSTs, explicit template replacement and canonical disabled metadata/auth/policy; the unified LocalAI legacy-link destination; and both phones' More Back/Close/Escape, focus restoration and ordinary Back/Forward without duplicate routes. Native Basic recovery retains the same caller's non-Chat draft; Token changed-caller recovery does not expose it. Both prove expired access stops protected retries and recovery creates no task writes.

The distinct final multi-entry phone-light gate proves skipped-base traversal retains exact selected record/draft, subsequent ordinary Back opens **Unsaved changes**, **Cancel** retains exact URL/input, one **Discard changes** continuation reaches Work, and Forward reopens the canonical saved title/revision with zero task writes. Nested/deferred/StrictMode/stale-capability and Keep-on-Forward remain separately attributed local owner tests. Root inspected the safe review/Forward screenshots. An earlier helper failure queried the aria-hidden background editor through role visibility; root corrected only the ignored locator, retained all assertions and reran the complete distinct flow. That earlier artifact remains preserved. No product repair was needed for this fixture issue or the earlier coarse-pointer emulation issue.

Every one of the 72 audited loaded states has zero serious/critical Axe violations, browser errors, coarse-control violations and page overflow. This is Windows Chromium loaded-state acceptance, not global contrast, Ubuntu, installed-host, live-provider, audio, download/inference, hardware or positive OS-custody certification. Root used disposable profiles and deterministic provider fixtures; its task-owned runtimes/profiles were cleaned. Saved disabled MCP metadata does not prove connection/invocation; no external channel send was performed. Disabled host secret storage proves secure-owner failure without plaintext fallback, not successful OS-keychain custody. Public URL, saved mask and true ENV-reference semantics remain distinct from dedicated channel/provider custody.

**FR-02 remains OPEN / partial, dependent on Task15 port5.** Exact receipt/correlation plus authoritative canonical settlement and revision/scope checks are still required before missing-response attempts may unlock. Blind refresh does not unlock. Full Classic parity cannot pass with this High finding unresolved. Residual provider diagnostics/access/runtime capability ports remain Task15; explicit Classic fallback and hidden/experimental metadata remain until each capability is accepted. The aggregate accepts the bounded Task12 implementation with these dependencies; it does not close every source-only row or promote unsupported/unverified actions.

Only additive `task_12_final_acceptance` annotations were added to the assigned 22 finding rows and 28 previously annotated Task12 inventory rows. Original 233 findings, 148 inventory rows, field values/order/owners/criteria/statuses/parity flags and all earlier evidence remain intact. Palette/search/scroll/cost-preference and other source-only qualifications are explicitly retained in their annotations. Closure uses the coverage-source guard, recursive additive preservation and diff check; no product/test/config/build/runtime change or broad suite rerun.
