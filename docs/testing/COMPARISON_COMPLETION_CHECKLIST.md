# Comparison improvement completion checklist

Scope fixed: September 15, 2026.

## Authority and finish line

The operator-approved [September 9 seven-step plan](COMPARISON_APPROVED_PLAN_2026-09-09.md)
is this task's finish line. The Master Completion Program remains the broader
product backlog; completing all M0-M10 rows is not required here. This correction
was relayed from the operator's scope-review task `01a0a2c3-f98a-7753-a28f-269ae10ee1fc`.
The original plan's acceptance, compatibility, security and rollout requirements
remain in force. Telegram is first, not a silent cancellation of Discord/Slack.

Existing work and receipts are preserved. Nothing is reverted, deleted, staged
or published to narrow scope. No disk attachment/formatting, installation,
deployment, live spending or external messaging is authorized by this checklist.
Commit/push remain deferred until the scoped plan is complete.

New implementation may enter this checklist only for a concrete defect or
necessary dependency of one of the seven steps. Record the affected step,
failure evidence and why the change is required. Do not fill external waiting
time with unrelated master-program work. Do not calculate completion by counting
milestones equally, and do not re-count already completed source work.

## Fixed remaining checklist

The [evidence ledger](COMPARISON_IMPLEMENTATION_STATUS.md#local-source-and-proof)
records the existing local receipts. Their scope is retained; earlier controlled
proof is not promoted to current live or final-candidate acceptance.

| ID | Remaining implementation | Local verification remaining | External/final-candidate acceptance |
| --- | --- | --- | --- |
| 1 / C0 | The three original extractions exist. Architecture regressions are resolved through focused existing-owner consolidation and explicitly reviewed new-owner allowances, including the operator-approved 4/4/1 cross-plan exceptions on September 16. Original baseline limits remain unchanged. | Architecture metrics pass at `2026-09-16T21-19-43-965Z-architecture-metrics-38c57093`. Include existing owner tests, async boundary, memory ownership and architecture metrics in final-candidate validation. | Preserve exact tested source identity with the final candidate. |
| 2 / C1 | No new feature gap is currently identified. Fix only failures of the original onboarding journey. | Consolidated fresh/returning profile, pending-plan refresh/restart, setup marker versus first completed Chat turn, Advanced controls and actionable failure recovery. | Real OAuth, API-key and local-provider first responses; expired-auth recovery; fresh-install first useful response without an extra paid probe. |
| 3 / C2 | Capture/review/activation/reuse source exists. Fix only original-workflow defects. | Source authorization, redaction, inactive candidate, failed evaluation, changed-hash approval invalidation, activation and exact-version reuse, revocation and rollback. Preserve the three-session automatic-learning threshold and no memory write on capture. | A real successful workflow captured, explicitly reviewed/activated, then successfully reused in another session, with live-model quality evidence. |
| 4 / C3 | Governed pack coordination and actual Browser QA execution exist. No additional packs are required to close this step. | Consolidated Browser QA install/already-installed/missing-config/denial/stale-version/restart/partial-failure/owned-compensation cases; stage-only API remains non-executing. | Fresh workspace: review, required child approvals, browser QA from Chat and inspectable artifact. Pin the reviewed Playwright MCP bytes. |
| 5 / C4 | Shared channel source and local parity evidence exist. Fix defects revealed by the approved channel journeys. Signal remains outbound-only. | Authenticated ingress, scope isolation, approval actor/revision binding, attachment limits, delayed actions, expiry, deduplication and reconnect coverage on the final candidate. | Telegram first, then Discord and Slack: request → progress → approval → resume → result/artifact → scheduled delivery, including restart during approval and retry without duplicate external effects. |
| 6 / C5 | Finish native helper endpoint custody, installed listener/service composition, mounted-journal executor admission, required quiescence/accounting/quota enforcement and retained credential recovery. Wire only what is needed for packaged Node and explicitly supported PowerShell tasks with Gateway inference. | End-to-end local protected execution/admission/input/output/retention proof; current identity/lease/budget/approval fences, resource-limit refusal, denied paths/network, termination/cancellation, artifact tampering and settlement recovery. Preserve container records and one active native assignment. | Two physical Windows 11 x64 machines: real task, Gateway inference, native execution, approval, artifact return and worker-death recovery. Packaged install, service restart, credential revocation, resource-limit failure and uninstall proof, with separately authorized installation/disk actions. |
| 7 / C6 | Harness and three-product controlled adapters exist. Assemble the exact final GoatCitadel candidate and resolve only concrete adapter/comparability defects. | Preserve native receipts, equivalent permission/model/tool settings, budget enforcement, independent rubrics, unsupported cases and unavailable metrics. Retain machine-readable and human-readable reports. | Five shared tasks × three trials × three pinned products = 45 trials: cited research, tested code repair, document/artifact, capture/reuse and scheduled delivery. Measure useful-output time, duration, tokens/cost, interventions, corrections and recovery. Approval/restart and remote-execution capability differences are separate rows. |

### Consolidated closure gates

- [ ] Original in-scope owner and subsystem checks pass on the final candidate:
  self-configuration/usability for the onboarding path, runtime truth, durable
  recovery, channel runtime/parity, remote workers, Windows provisioner and desktop.
  A named lane containing independent expanded backlog is not permission to
  implement that backlog; report its unrelated row separately.
- [ ] Consolidated browser, accessibility and visual proof after the included UI
  changes settle; preserve public readiness labels and operator opt-in.
- [ ] Original storage changes retain SQLite/PostgreSQL upgrade and immutable
  record/hash compatibility evidence. Do not reinterpret older records.
- [ ] Final-candidate provenance and the original exact-revision certification
  are complete. A dirty working-build receipt is not clean-pinned release proof.
  Preserve the current no-commit/push instruction while preparing the candidate;
  do not invent a SHA or perform an early commit to bypass that instruction.
- [ ] Required live/physical acceptance and the comparative report are complete,
  or any reduction is explicitly approved by the operator. Missing external
  inputs alone never constitute completion.

## Concrete scoped defect register

- **C5-BROWSER-CONTRACT-01 (September 17):** browser acceptance reproduced a
  production build failure because the shared installation-capacity challenge
  imported `node:crypto`. The codec now uses the existing isomorphic hash helper,
  typed arrays and DataView while preserving its domain separator and 144-byte
  protocol. Five contract tests cover independent Node parity, absent Buffer,
  tampering and replay; 55 Gateway session/reservation tests and 296 worker
  tests pass (15 worker skips). The production UI rebuild passed on retry
  (`2026-09-17T11-10-46-326Z-usability-core-f06bb86e`). This closes the build
  defect; that run then exposed a separate stale verification cleanup caller.

- **C1-FIXTURE-ISOLATION-01 (September 17):** the local browser foundation
  copied operator configuration and private workspaces, so its disposable
  directory alone did not establish fresh-install isolation. The foundation
  now uses example configuration, empty schedules, fresh metadata and its
  loopback provider while retaining shipped skills. Forty fixture/usability
  tests pass, and the real Gateway configuration loader accepts the result
  (`.tmp/comparison-usability-config-load-20260917.log`). The isolated browser
  foundation passes all eight steps, including return to the idle Send control,
  at `2026-09-17T11-17-23-749Z-usability-core-4f220bc1`. This is exploratory
  stub-provider proof; real-provider onboarding and final-candidate acceptance
  remain pending. Other lanes' fixture preparation is unchanged.

- **C1-INTERRUPT-01 (September 16):** a delayed Enter Chat completion could
  navigate after GuidedModelSetup unmounted or changed workspace. Two focused
  regression tests reproduced it. Generation-bound action handling now ignores
  stale completion, refresh, plan receipts and errors while preserving submitted
  Gateway operations. All 48 guided-setup/app-shell tests and UI typecheck pass;
  see `.tmp/onboarding-late-entry-final.log`. Controlled DOM proof does not close
  the real provider/browser onboarding acceptance requirements.

- **C5-FILE-RETURN-01 (September 15):** native generated files need an export
  path separate from model-answer verification and diagnostic-output downloads.
  `CellDirectoryInventoryPins::ReadFileContent` now reads an exact pinned file
  identity and accounting record without reopening a path. It bounds one read to
  1 MiB, checks fresh authority between 64 KiB chunks, retains the original
  deadline/cancellation, and discards bytes on changed membership or revocation.
  The reader now proves ancestry beneath an independently supplied retained
  directory, rejecting sibling/private files even when present in the same flat
  inventory. Normal and AddressSanitizer each pass 1,828 checks (75 file-reader
  checks), plus ARM64 compilation (`.tmp/comparison-native-file-scope-20260915-b.log`).
  A tested selection contract derives scope, work identity and byte counts from
  the decoded result; it is not ancestry or publication authority. The storage
  owner now re-derives the exact selection from retained execution/provisioning
  records under current approval, credential, mesh, assignment and lease fences.
  This is an internal delivery check, not a durable export/publication grant.
  The native journal runner now stages explicitly selected files while the
  quiescent job and pinned handles remain alive, and releases bounded bytes only
  after final verified capture. Failures discard provisional bytes. This is an
  opt-in trusted-owner API, not an installed transport or disclosure grant.
  The native dispatch/session now forwards an explicitly supplied staging policy
  to that runner, snapshots it before peer callbacks, and discards staged bytes
  on session failure. Normal/ASAN session, helper-forwarding and request-transfer
  checks pass (`.tmp/native-session-staging-20260915-a.log` and
  `.tmp/native-stage-dispatch-20260915-a.log`). The installed controller still
  needs its governed selection policy and file-transfer negotiation.
  A trusted path selector can now resolve explicit relative output paths beneath
  the recorded work directory using pinned names and identities, then stage the
  exact bytes with their selected labels. Scope escapes, streams, device names,
  missing files, duplicate identities and changed authority refuse. Normal/ASAN
  capacity checks pass 1,915 assertions each (87 selection checks); the full
  normal/ASAN native lane passes 6,218 checks each. ARM64 compilation also passes
  (`.tmp/native-file-path-selection-20260915-a.log` and
  `.tmp/native-path-staging-runtime-20260915-b.log`). This does not activate an
  installed disclosure policy or add labels to the GCRFA001 integrity record.
  Explicit collection paths and byte ceilings now bind to the approved runtime
  request (`GCRUN002`), appear in the ephemeral launch review and cannot be
  overridden by native callers. Gateway, UI and SQLite/PostgreSQL admission
  checks pass; this closes request binding, not installed transfer/disclosure.
  A bounded native/shared identity-handoff codec now associates the approved
  path order with exact retained file identities and byte limits. Normal/ASAN
  native checks and shared contract tests pass; installed negotiation and
  disclosure wiring remain open.
  Native controller/client sessions now exchange complete file batches only
  with explicit per-file delivery ownership, after terminal retention; partial
  batches are withheld. Normal/ASAN batch and full-session checks pass. The
  installed helper/parent and Gateway disclosure/artifact wiring remain open.
  A distinct file-control challenge now traverses controller/helper/parent with
  exact retained metadata and a separate file owner; normal/ASAN and worker
  tests prove grants, retention races and revocation without delivery fallback.
  Helper-to-parent content forwarding and Node dispatch now pass local normal/
  ASAN and worker checks. The driver requires clean helper exit before invoking
  its file consumer; missing or failed batches cannot complete. Explicit Gateway
  artifact-disclosure review now binds the request, file-plan digest, assignment,
  execution workspace and path jail; collection approval alone cannot grant it.
  Protected storage and Gateway validation reject scope substitution/revocation,
  and the approval UI shows the additional destination and permission. Immutable
  metadata receipts now retain a complete validated batch under the same scope,
  including file identities and content hashes, with atomic rollback and exact
  replay. Receipts contain no raw content and do not claim CAS availability.
  A Gateway owner now installs verified CAS bytes before retaining the receipt
  and recovers complete batches through receipt, size/hash and current-authority
  checks. Local real-file tests cover interruption, corruption and buffer cleanup.
  Native manifests and receipt-derived verifier profiles now feed the canonical
  upload/part/manifest repositories. Verification commits atomically and replay
  rechecks saved files without executing the job. Protected metadata reconciliation
  now resolves retained results against receipt-backed CAS settlement. The worker
  requires that evidence after fresh execution or restart, under its current lease,
  and never replays a retained job to recover files. Installed startup now wraps
  per-file local permission with a fresh signed Gateway disclosure check under
  the current lease; the Gateway also checks artifact capability and byte limits.
  Missing local authority or a complete-batch consumer prevents dispatch. Bounded
  native transfer declarations/pages now persist under current disclosure authority
  on SQLite and PostgreSQL. A Gateway receiver reconstructs exact records before
  receipt/CAS settlement; verified cleanup removes raw pages and retains metadata.
  Signed declaration/page RPCs and installed consumer wiring now connect this
  receiver to the worker. The worker snapshots the complete batch, obtains fresh
  disclosure metadata, uploads 32 KiB pages under each current lease and requires
  matching final settlement. Installed local custody rejects changed/unapproved
  files, duplicates and replay before transfer. Local proof: 31 contract, 117
  Gateway and 119 worker tests pass (`.tmp/native-file-wire-*`). Full combined
  native-to-Node/physical acceptance remains open. Operator file discovery and
  downloads now appear in Chat worker details and Ops. Only receipt-matched,
  verified manifests expose bytes; the Gateway and client recheck content hashes
  and sizes. Historical downloads do not grant worker execution authority.
  Local route/CAS/client/UI, SQLite/PostgreSQL and desktop/mobile component
  browser proof is retained under `.tmp/native-file-operator-*` and
  `output/playwright/native-file-browser-KvD65u/`.
  The Gateway-native request producer still has no production `requestReview`
  caller; that trusted execution-owner connection remains required before the
  full native workflow can be called complete.
  The native file encoder and shared decoder now bind exact content bytes and
  SHA256 to the request, canonical result, work/file identities and accounting.
  This integrity record requires protected native-origin custody; it is not a
  signature or independent proof that arbitrary submitted bytes came from a file.
  An opt-in native file-transfer owner now exchanges that record in bounded
  chunks over an already authenticated exclusive pipe, with current-authority
  checks and a complete-receipt ACK. It creates no listener or durable receipt.
  Gateway composition now includes a native-file validation owner backed by
  retained-result storage checks; cancellation or changed authority withholds
  content. This gate remains separate from the Chat-answer artifact verifier.
  All three storage authority cases pass on both SQLite and PostgreSQL, covering
  worker, mesh and parent revocation. PostgreSQL verification uses an isolated
  Windows temporary-directory cluster with unchanged durability and test limits
  (`.tmp/native-file-content-authority-postgres-20260915-e.log`).
  Installed selection/file-byte transport wiring, operator-facing artifact delivery
  and installed acceptance remain open; local disclosure governance and Gateway
  receipt/CAS settlement have component proof only.

- **C5-OUTPUT-BINDING-01 (September 15):** native stream diagnostics are local
  report fields without a versioned request/result binding. The existing Chat
  artifact verifier accepts only canonical model text and must not be reused as
  if it verified native stdout. Add bounded output evidence tied to the admitted
  request and retained result, checking both stream counts against the canonical
  outcome. Use this in the installed owner before adding Gateway ingestion;
  missing capture on retained-result recovery is unavailable, never empty output.
  A shared v1 evidence contract now bounds each text stream to 32 KiB, freezes
  normalized records, and verifies request/result identities and both byte
  counts against independent retained facts. The installed owner emits this
  evidence only with both captured streams; recovered results without capture
  do not invent output. Eighteen contract tests and 71 worker tests pass
  (`.tmp/comparison-native-output-contract-20260915-a.log` and
  `.tmp/comparison-native-output-worker-20260915-a.log`). Typecheck and lint pass.
  The storage owner now retains immutable redacted output only after independent
  binary-result retention, under current approval/credential/mesh/assignment
  authority. Exact retries converge; conflicting evidence and unredacted known
  secrets are rejected. SQLite v246 and PostgreSQL v191 add an evidence table
  without changing prior migrations or interpreting native output as model text.
  Three SQLite and three PostgreSQL protected-retention cases pass, including
  worker/mesh/parent revocation rollback, exact replay and immutable rows
  (`.tmp/comparison-native-output-storage-20260915-a.log` and
  `.tmp/comparison-remediation-parent-reservation-postgres-tests-20260915-native-output-b.log`).
  Storage typecheck, targeted lint and migration-parity checks pass; the temporary
  PostgreSQL cluster stopped cleanly.
  The signed settlement route and installed worker now submit captured native
  output to this storage owner. Receipt validation binds the exact evidence hash,
  request, result, assignment and current lease without echoing stream text.
  Current lease-token and known-secret rejection occur before delivery/dispatch.
  All 109 Gateway, 24 worker and 28 contract checks pass
  (`.tmp/comparison-native-output-transport-gateway-20260915-b.log`,
  `.tmp/comparison-native-output-transport-worker-20260915-a.log`, and
  `.tmp/comparison-native-output-transport-contracts-20260915-a.log`).
  Typecheck and targeted lint pass. Retained output now enters canonical Chat
  through a v2 context, with bounded untrusted data messages and unchanged v1
  replay. Metadata-only sequences already started retain their original identity
  if output arrives late. Thirteen contract, 14 Gateway sequence and 19 controlled
  parent-read checks pass; real SQLite/PostgreSQL prove retained native output
  reaches the canonical workload (`.tmp/comparison-native-output-chat-sqlite-20260915-a.log`
  and `.tmp/comparison-remediation-parent-reservation-postgres-tests-20260915-native-output-chat-a.log`).
  Operator-authorized native output evidence downloads are now discoverable from
  Chat and Ops, with bounded generation-scoped discovery, exact request/result
  validation, deterministic JSON/digests and immutable historical reads after
  revocation. Twenty-four contract, 30 Gateway, eight shared-client, 15 UI and 19
  parent-read checks pass. Real SQLite/PostgreSQL cover output discovery, exact
  downloads and post-revocation historical access. These documents are diagnostic
  evidence, not arbitrary native-generated file transfer. The end-to-end SQLite
  acceptance now also checks v2 native output through governed inference, the
  verified Chat-answer artifact, settlement, durable completion and database
  reopen, preserving the exact diagnostic download bytes
  (`.tmp/comparison-native-output-artifact-acceptance-20260915-a.log`). Focused
  browser proof passes for Chat/Ops downloads, exact content hashes, retry after
  failure, desktop and narrow layouts
  (`artifacts/verification/2026-09-15T20-13-12-713Z-remote-workers-f9f3180a/`). Native file artifact
  return, consolidated browser proof and installed/physical acceptance remain open.

- **C5-INSTALLED-OWNER-01 (September 15):** `main.ts` never supplies
  `nativeRuntime` to the worker process, so an approved native continuation
  remains at `native_runtime_owner` even with protected startup credentials.
  Connect the installed startup to its existing native continuation adapter
  with unattended EOF input and bounded, redacted local output diagnostics.
  Preserve canonical request authorization, helper custody and resource fences;
  local diagnostics do not replace canonical artifact/transcript acceptance.
  The protected entrypoint now supplies this owner; PEM startup does not. The
  policy captures up to 32 KiB per output stream, redacts joined frames, omits
  truncated partial lines, retains full byte counts/hashes and closes its
  per-run lifetime on every outcome. All 276 focused entrypoint, policy,
  startup, continuation, helper and volume-protocol tests pass
  (`.tmp/comparison-installed-native-policy-20260915-c.log`). This proves local
  source composition and controlled transport behavior, not installed execution
  or canonical output-artifact ingestion.

- **C5-INPUT-AUTH-01 (September 15):** installed runtime startup wraps execution,
  delivery and retention with fresh canonical Gateway authorization, but passes
  input authorization through unchanged. C5 requires current lease/approval
  fences at native input boundaries too. Add a regression for revocation between
  frames and foreign request/history, then bind input authorization to the same
  held lease and exact admitted request. This does not authorize native launch
  or disk operations during validation.
  All three new cases reproduced before the fix
  (`.tmp/comparison-native-input-authority-20260915-before.log`). The startup
  wrapper now checks exact request/history and fresh execution authorization
  after the input policy, under the held current lease. All 144 focused startup,
  stream, continuation and parent-session tests pass
  (`.tmp/comparison-native-input-authority-20260915-after.log`); worker typecheck
  and targeted lint pass. This closes the local composition defect; installed
  listener and physical-machine acceptance are still open.

- **C3-PACK-FIXTURE-01 (September 15):** the original failed-connection
  compensation acceptance test returns `manual_required`; 32 other pack checks
  pass (`.tmp/comparison-scoped-browser-pack-20260915-a.log`). Its MCP host
  fixture still returns void from `writeMcpServers`, while the current owner
  requires committed records as its acknowledgement. Updating that fixture
  contract is needed to exercise the real compensation path. No production
  ownership or revision guard should be relaxed.
  The fixture now returns committed records. All 33 focused pack checks pass
  (`.tmp/comparison-scoped-browser-pack-20260915-b.log`), including compensation
  and preservation of later MCP edits. Targeted lint and docs checks pass.
  This closes the fixture defect, not fresh-workspace browser/live acceptance.

- **C0-ARCH-01 (open, September 15):** the original architecture gate now fails
  against the unchanged baseline. GatewayService grew from 13,132 to 13,813 lines,
  public methods from 309 to 317, internal public methods from 57 to 60,
  route-composition members from 187 to 192, and typed host callbacks from 1,104
  to 1,133. The retained comparison also reports dependency-member-access growth.
  Evidence: `artifacts/verification/2026-09-15T18-19-21-828Z-architecture-metrics-088938a4/diagnostics/architecture-metrics-compare.json`.
  This is a direct failure of original step 1's unchanged-threshold requirement.
  Attribute and repair only those increases; preserve all functionality and
  concurrent work. Do not raise baselines or absorb unrelated large-service debt.
  Attribution found that the unchanged comparator assigns zero to every new
  service, including the provider-readiness and workflow-capture owners required
  by the original plan. On September 15 the operator was asked whether to keep
  existing-file limits and review new narrow owners separately, or enforce the
  literal zero-growth rule. On September 16 the operator authorized explicit
  allowances for new plan-owned services while preserving existing-owner limits.
  The comparator now reads a separate, baseline-pinned allowance record and
  retains the original threshold file unchanged. Each allowance requires a
  named plan step, rationale, evidence and fixed caps; baseline-era owners,
  including zero-count owners, cannot receive allowances. Reviewed entries cover
  approved remote actions, provider readiness, first-task detection, workflow
  skill capture, the four Browser QA pack owners, channel delivery parts and
  channel connection review and six native provisioning/capacity/result exchange
  owners, native artifact storage/settlement and file reconciliation. Other new owners
  still require review, and existing-owner regressions still require fixes.
- **C1-FIRST-TASK-01 (local fix, September 15):** after 1,000 completed traces
  that do not qualify as real successful responses, onboarding never inspected
  later valid work. The retained reproduction fails before the fix
  (`.tmp/comparison-onboarding-page-regression-20260915-before.log`). Detection now
  traverses bounded pages using `(startedAt, turnId)` while preserving all
  successful-response checks. Existing two-argument repository callers retain
  their limit and oldest-first behavior. No probe, credential or setup-marker
  write was added. Ten focused detector tests and all 24 onboarding route/
  detector tests pass; SQLite proves tied timestamps do not skip or repeat rows.
  Evidence: `.tmp/comparison-onboarding-page-regression-20260915-after.log`,
  `.tmp/comparison-onboarding-pages-gateway-20260915-a.log`, and
  `.tmp/comparison-onboarding-page-storage-20260915-a.log`.
  Typecheck, targeted lint and docs/ownership checks pass. PostgreSQL proves
  tied-timestamp paging and exact exhaustion
  (`.tmp/comparison-remediation-parent-reservation-postgres-tests-20260915-onboarding-pages-a.log`);
  its temporary database shut down cleanly. The five guided-model UI tests also
  pass (`.tmp/comparison-onboarding-guided-model-20260915-a.log`). This closes the
  local paging defect, not live-provider or fresh-installed acceptance.
- Fresh scoped verification: 15 provider-readiness/onboarding tests pass
  (`.tmp/comparison-scoped-onboarding-tests-20260915-a.log`); docs/ownership checks
  pass (`.tmp/comparison-scoped-docs-20260915-a.log`). These are local checks, not
  real-provider or fresh-installed acceptance.

## Deferred follow-up backlog

These items retain their existing code, tests and evidence, but are not blockers
for this task unless a specific in-scope defect proves a dependency:

- General M5 self-repair/configuration expansion: generic repair coordinator
  production registration, policy/phase-claim/approval creation wiring, budgets
  mirror activation, POSIX repair handles, arbitrary configuration/dependency/
  service repairs, OAuth repair custody and broad reconciliation expansion.
  The recent parent adapter, resume/release transactions and approval verifier
  are preserved with their evidence in
  [the repair owner document](../GOVERNED_SELF_CONFIGURATION_AND_REPAIR.md).
  The original step 2 uses existing guided setup and Change Plans; it does not
  require this generic repair coordinator. No exact original-plan dependency
  has been found, so further repair work is deferred now.
- Mobile companion completion and associated broader M8 work.
- Additional packs, general autonomous capability growth, broad skill/agent
  promotion and unrelated M6 governance expansion beyond explicit capture and
  the Browser QA pack.
- Additional worker platforms/backends, ARM64 execution acceptance, destination
  tool expansion and delegation/council breadth not needed by the original
  Windows x64 Node/PowerShell acceptance task. Required native isolation,
  resource limits, credential custody and recovery are **not** deferred.
- Remaining unrelated M0-M10 architecture, UI, operations and release-program
  expansion. Existing safety fixes and concurrent UI work are preserved; this
  task does not add further blanket sweeps.

No new Codex tasks or automations are created by this backlog.

- **C5-NATIVE-GRANTS-01 (open, September 16):** fresh native admission now enters
  `ToolPolicyEngine.admitNativeRuntime`: current policy inspection, exact native
  approval/admission, canonical grant debit and a limit-counting decision share
  one storage transaction. Review and delivery inspection remain non-consuming.
  The Gateway producer no longer directly commits storage admission. Immutable
  request/approval/decision/grant reservations now commit with admission; later
  authorization reads them under current native authority and excludes only that
  exact counted call. SQLite and PostgreSQL native Chat fixtures cover retained
  reads, immutability, revocation and cancellation. Shared-engine tests cover
  consumed-grant reuse without another count and new deny enforcement. Combined
  engine/native-repository tests now pass on SQLite and remote PostgreSQL storage,
  including accounting-failure rollback and a subsequent successful admission.
  Installed-worker acceptance remains outstanding.
  Concurrent external-runtime invocations now share atomic evaluation/accounting;
  the reproduced SQLite race is fixed, and independent PostgreSQL connections
  verify session/global call limits, shared write limits and rollback release.
  The native-policy owner now has a reviewed allowance of one dependency access
  and zero host callbacks; these receipts do not close the entire native path.

- **C5-NATIVE-WARDS-01 (source fixed, September 16):** native policy accepted
  `allowed: true` without enforcing attached Ward effects. Four focused cases
  reproduced acceptance of dry-run, local-route, redact and deny restrictions.
  Native dispatch now refuses effects it cannot enforce; allow/no-effect and
  require-approval retain the exact native review path. All 100 policy and
  request-producer tests pass, plus Gateway typecheck. This is refusal behavior,
  not a native dry-run executor, route substitution or artifact-redaction claim.
  C5-NATIVE-GRANTS-01 and installed acceptance remain open.

- **C5-RUNTIME-WRITER-01 (source fixed, September 16):** installed runtime
  dispatch previously bypassed the local external-writer exclusion used by
  capacity measurement. It now reserves before parent endpoint setup and holds
  through helper join, artifact delivery and parent endpoint closure. Only a
  validated result with zero-process and drained-output flags releases a launched
  writer; uncertain cleanup remains sticky. This is in-process coordination,
  not cross-process/restart custody or installed-machine acceptance.

- **C5-INSTALL-RECOVERY-RACE-01 (source fixed, September 16):** recovery ignored
  an installation outcome newly retained during local custody lookup and could
  fail on an unnecessary local read. It now returns the freshly verified
  canonical success or failure record under the stable lease without opening
  another local driver or repeating retention. Two regression cases failed
  before the fix; 35 recovery/client tests and worker typecheck pass afterward.
  The subsequent startup reconciliation connection below uses this recovery;
  neither change authorizes installation.

- **C5-INSTALL-STARTUP-01 (source wired, September 16):** the installed native
  continuation now selects retained installation input through protected current
  assignment authority and reconciles existing local/canonical outcomes before
  execution. It carries the renewed lease into snapshot and runtime admission,
  retains terminal installation evidence for diagnostics, and refuses execution
  after failed/uncertain recovery. No retained request leaves existing native
  admission intact; absence is not installation or readiness proof. Recovery
  never copies or retries installation. Local composition/client tests pass;
  physical restart acceptance and installed capacity/install callbacks remain open.

- **C5-STABLE-LIFETIME-01 (source fixed, September 16):** held-lease checks
  accepted nonfinite or over-limit remaining lifetimes even though renewal
  rejected them. Six cases reproduced the inconsistency before and after the
  asynchronous control read. Both checks now use renewal's existing finite
  100-to-900000-ms bounds and fence further authority on failure. All 96 focused
  recovery, capacity, cleanup and runtime-startup tests pass, plus typecheck/lint.

- **C5-CAPACITY-ROOT-POLICY-01 (source added, September 16):** the collector's
  controller-only root ACL requirement cannot directly represent worker-writable
  installed state. An explicit trusted-host verifier can now validate each pinned
  area identity and its exact installer-owned security policy throughout capture.
  Existing controller-only admission remains strict. Missing/revoked policy and
  reentrant closure refuse capture; no workload or wire data selects this owner.
  The controller now supplies a fixed policy factory that repeats current SCM
  identity, checks the real pinned directory identity, restricts the mutable area
  to its original cells parent, and checks other areas against the exact worker
  state ACL. The installed controller now pins the fixed record and thirteen roots,
  repeats their identities/ACLs in every service verification, and restricts exported
  roots and policy checks to that binding. Normal/ASAN custody tests pass 660 base
  and 720 paired checks; successful SYSTEM-service admission remains unverified.
  Cross-process writer coordination and measurement integration remain open.

- **C5-CAPACITY-CUSTODY-01 (record implemented, September 16):** the installer
  can encode thirteen pinned, distinct, same-volume NTFS directory identities in
  the separate GCCAPS01 custody record. Native decoding rejects malformed input
  and clears partial output. Cross-language checks cover PowerShell 5.1/7 output
  consumed by normal/ASAN native binaries and compared with real fixture roots.
  The native reader now verifies a regular single-link record, all thirteen held
  directory handles and the independently admitted cells parent, clearing output
  for any substitution. Paired normal/ASAN checks cover both PowerShell encoders.
  Fresh-install source now publishes a protected record and receipt digest, uses
  separate state/report roots, and validates enrollment custody. Both exact legacy
  and new layouts pass local cross-language tests; mixed layouts are refused.
  Physical publication and installed controller record admission are unverified;
  existing assignment and capacity-layout formats are unchanged.

- **C5-ENROLLMENT-WRITER-01 (source/local proof, September 16):** fresh
  installations include a protected empty guard held for reading by both services
  and exclusively by enrollment before state changes. Existing-file sharing closes
  the enrollment/service-start race without rewriting the guard. Two-process local
  fixtures check both exclusion directions and release in PowerShell 5.1/7. This
  does not coordinate runtime writers or establish successful installed acceptance.

- **C5-HOST-WRITER-RESTART-01 (source/local proof, September 16):** fresh-layout
  host launches flush a fixed protected process marker before child creation.
  Only an observed empty original job permits completion; missing, corrupt or
  uncertain markers refuse subsequent launch. This prevents a new host lifetime
  from silently forgetting old writer uncertainty. Controller peer admission now
  also checks the running host's marker and the helper's service-logon/time binding.
  Current quiescence and installed
  crash/recovery acceptance remain separate requirements.

- **C5-INSTALLATION-WRITER-COVERAGE-01 (source/local proof, September 16):**
  installation histories now have a complete-set check separate from runtime
  cleanup. Every retained request must match a sealed local installation outcome;
  omissions, substitutions, interrupted intents and changes during inspection
  refuse coverage. Joined failed copies do not become successful installations.
  The controller's verified cleanup receive now requires independently supplied
  installation expectations and checks both namespaces before acknowledging the
  runtime history, with one transfer deadline. Empty installation expectations
  still require an empty local installation namespace. The worker handoff selects
  the retained installation under the same held lease, requires identical journal
  history, and supplies immutable request bytes and bindings to the independent
  receiver-binding port. That port now also receives bounded GCCADM01 admission
  bytes, with a matching native decoder for zero or one installation request.
  The worker measurement composition now reads that admission under its existing
  lease and local writer pause. The helper forwards a connection-bound admission
  frame, then transfers the separately hashed cleanup data only after full native
  history replay and canonical authority. The controller checks both historical
  namespaces before acknowledging. Protocol tests cover the ordered handoff;
  installed-service acceptance remains pending.
  This historical check still requires current writer exclusion and pool-wide
  composition before controller measurement can be enabled.

- **C5-CLEANUP-SESSION-01 (source/local proof, September 16):** capacity, backing
  capacity and inventory sessions require cleanup admission, an exact ready
  binding and successful data transfer before an observation can be accepted.
  The controller requires a retained measurement hold before cleanup verification
  and keeps checking it through scan and receipt. Missing, duplicate or mismatched
  cleanup phases refuse publication. Production now supplies the native writer
  hold but still omits observation owners, so this transport does not enable
  installed scanning.

- **C5-WRITER-GATE-01 (source/local proof, September 16):** native-host worker
  startup takes a shared byte-range lock on the protected, precreated empty
  `state-writers.guard` before state writes. Registered local work drains before
  a measurement releases that lock; queued mutations remain blocked until it is
  reacquired, including after cancellation. Failed pause/resume poisons the
  current writer owner. The controller holds an exclusive lock through cleanup,
  observation and receipt and rechecks peer custody. Ordinary TLS workers without
  native-host control retain their existing startup path. The previous-host
  marker and complete historical cleanup remain separate requirements; kernel
  lock release on process exit is not proof that old workloads were cleaned up.
  Complete-pool observation composition and installed acceptance remain pending.

## Operator inputs pending

### September 17 worker integration update

The protected installation RPC and installed worker startup are now implemented.
Startup selects the canonical approved request, relays controller-signed capacity
proofs, completes terminal verification and joined shutdown, then retains and
reads back the outcome. Uncertainty enters read-only recovery without recopying.
The native signing owner remains alive through the terminal handshake. This
supersedes earlier source-wiring blockers in this checklist; C5 physical acceptance
remains open. Local proof includes 158 Gateway tests, 327 worker tests, 17 contract
tests, three SQLite revocation cases and native normal/AddressSanitizer fixtures.
The x64 candidate passed package inventory and execution-probe verification.
See [GOATBOX instructions](GOATBOX_WORKER_INSTALL.md) for the pinned candidate,
preflight/install commands and required protected enrollment inputs. No service or
disk operation has been performed on GOATBOX or the development PC.

### Remaining operator inputs

1. The operator will remote into GOATBOX and run the supplied commands. Their
   September 17 read-only output reports Windows 11 Pro x64 build 26200,
   i9-12900H, 31.8 GB RAM, PowerShell 5.1 and 496.5 GB free on C:. Ethernet is
   `192.168.0.199`; Tailscale is `100.64.0.1`. This establishes host inventory,
   not installed-worker readiness. Exact installation/service and virtual-disk
   targets plus explicit authorization are needed before those actions; no
   passwords in chat.
2. Dedicated Telegram bot/chat destination and authorization for the test
   messages/scheduled delivery. Later Discord server/channel and Slack workspace/
   channel destinations remain required unless explicitly deferred. Credentials
   go through their existing secure setup UI.
3. Effective provider/model/reasoning choice and combined provider-request and
   dollar caps for live acceptance and comparison. Primary calls, retries and
   child calls share the cap. OAuth/API-key/local-provider setup availability is
   also needed for onboarding acceptance. No cap is inferred from previous
   unrelated campaigns.

These inputs were requested on September 15. Continue independent local scoped
work while awaiting them; do not request the same information again unchanged.

The operator selected **controller-signed attestations** on September 17. Continue
with a controller-specific signing/enrollment path and independent Gateway
verification of the native state. The current Gateway session owner requires
independent native endpoint/window verification and rejects ordinary worker RPC
registration. Protected worker identity alone is not proof of the controller's
current writer lock. This decision unblocks that implementation; it does not
authorize installation, service changes or virtual-disk operations on either host.
