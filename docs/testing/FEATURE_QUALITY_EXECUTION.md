# Feature quality execution

Baseline: `997e682752d939b415ee71523794197a37d4d4d3`, 2026-10-11.
This is the working acceptance record for the approved sequence in
[the canonical completion ledger](../MASTER_COMPLETION_PROGRAM.md).

## Current acceptance checkpoint

### Origin reconciliation and Inbox fix, 2026-10-12

Publication now includes reconciliation with `origin/main` at `0d16ac715`,
retaining both upstream commits and the previously completed feature snapshot.
The Inbox follow-on notification test replaces fixed sleeps with observable
fetch/render synchronization. The owner also distinguishes changed access,
execution and approval-wait identities even when their statuses match. Its
focused settlement/recovery suite passes 17 tests; the synchronized pre-fix
identity cases failed and are retained as evidence. Only the two explicitly
assigned Inbox files are included from the primary checkout's existing edits;
other edits remain separately backed up and uncommitted.

Upstream design advisories now also recognize fresh Chat's admitted skill
receipts while retaining historical profile behavior. These annotations remain
informational and do not grant execution authority. Gateway and UI typechecks,
33 focused upstream integration tests, async-boundary and docs checks passed.
The final fresh-admission advisory suite passes 18 tests, including policy
denial, canonical-fence revocation, stream consistency and harness neutrality.
The origin reconciliation architecture receipt is
`artifacts/verification/2026-10-13T01-34-08-608Z-architecture-metrics-86aa0d42`:
Gateway 13,107/13,132 lines, 309/309 public methods, zero regressions with original
limits unchanged. Final publication validation is retained under
`output/feature-quality/origin-reconcile-*` and `inbox-publication-*`.
The final architecture receipt after both fixes also passes at
`artifacts/verification/2026-10-13T01-38-28-782Z-architecture-metrics-2ec5c573`;
`publish-final-*` retains the final wrapped Gateway typecheck and docs checks.
Live hosted/local model trials and physical two-machine acceptance remain
explicitly deferred. Publication does not enable restoration switches,
activate candidates, run missed schedules, install or deploy a release.

### Main integration checkpoint, 2026-10-12

The completed feature snapshot was committed as `edb34df37` and reconciled with
local main `8a0fb792e`. The isolated integration retains main's per-command skill
module routing, workspace design context, lazy artifact branding, release-bound
skill re-trust, and filesystem test ports. New adapters preserve the existing
policy, lifecycle transaction, audit-before-write and post-commit signal order.
The original architecture baseline and all original-owner limits are unchanged.
The integrated architecture scan passed at
`artifacts/verification/2026-10-13T01-21-31-657Z-architecture-metrics-79bc1f51`:
Gateway 13,107/13,132 lines with zero regressions. Wrapped Gateway typecheck
passed. Focused integration tests passed 276 tests across ten owner files with
zero skips; async-boundary and full documentation checks passed. Merge validation
logs are retained under `output/feature-quality/merge-*`.
The earlier failed integration scan remains available; it is not acceptance proof.
Existing edits in the primary checkout are excluded from the feature commit and
are separately backed up and reconciled as uncommitted work before main advances.
No push, installation, deployment, live model trials or two-machine acceptance
is included in this integration.

Runtime feature changes are present in the isolated checkout; restoration
switches remain disabled by default. Additional comparison adapter/supervisor
source validation has retained the closure results below. The following queue is current as
of 2026-10-12. Passing controlled checks do not promote a live model track.

| Acceptance lane | State |
|---|---|
| Original comparison harness, extension packaging, skill learning and Skill Hub lifecycle | Passed checkpoints; detailed receipts below |
| Additional comparative workflow adapters and supervisor | Native web and recovery adapters are wired through normal launch configuration; controlled launch and complete recovery-phase tests pass. Native Chat-visible route and canonical reconciliation metrics remain unavailable where public receipts omit them |
| Public MCP approval/restart/evidence and automatic fanout | Passed; detailed receipts below |
| Routed-context snapshots | Passed; eight scenarios, conditional PostgreSQL row skipped; separate real database proof passed |
| Durable recovery | Passed: actual restart/DLQ plus worker, approval and orchestration groups; failed prior receipts retained below |
| Agentic governance | Passed: all four named scenarios, including Code Mode and actual activation/revocation/deny runtime |
| MCP requester scope and memory truth | MCP passes all 15 scenarios and 18 executed checks, with one conditional PostgreSQL sub-check skip; separate real database proof passed. Memory passes three scenarios with zero skips, including desktop/mobile accessibility and overflow checks |
| Worker/provisioner/skills/memory consumer typechecks | Passed under the repository output-lock wrapper |
| Guided channel setup and Code Mode sandbox lane | Passed; Windows Code Mode proof does not promote hostile-code enforcement |
| Final current/stale MCP browser journey | Passed: actual UI approval/durable resume, exactly one MCP call, exact keyboard Chat link, stale revision refusal, six captures with zero accessibility violations/overflow |
| Final UI typecheck, async boundary, docs and hygiene | Passed; new comparison module syntax and formatting also passed |
| Architecture metrics | Passed named scan: Gateway 13,111/13,132 lines, 309/309 public methods, zero regressions. All 20 dependency-access regressions resolved. Original baseline and existing-owner limits unchanged; reviewed new owners have separate measured registrations |
| Hosted/local comparison and physical remote acceptance | Deferred by the user on 2026-10-12; no live acceptance claimed. Zero model requests and zero provider dollars |

## Resumed validation, 2026-10-12

The user explicitly deferred the live hosted/local comparative trials and physical
two-machine acceptance after the configuration request. This changes the active
validation scope, not the historical acceptance targets or runtime defaults.
These cells remain unrun, not passed. Local implementation and deterministic
validation continue. The architecture gate is now closed by the fresh receipt
below; native recovery adapter availability does not prove product acceptance.

### Architecture closure, 2026-10-12

The named gate passes at
`artifacts/verification/2026-10-13T00-41-33-960Z-architecture-metrics-0193a060`.
Gateway measures **13,111 / 13,132 lines** and **309 / 309 public methods**;
the comparison retains **zero regressions**. The original baseline file and
every original-owner limit are unchanged. The preceding failed receipts remain
historical evidence rather than current blockers.

Gateway delegates provider-secret generation, callable skill runtime selection,
replay scratch copying, notification projection and approved integration dry-run
replay through typed ports. Existing configuration generation, transaction,
credential, grant, approval and external-effect owners retain authority. Chat
feature guards/schema restoration and exact autonomous replay validation move
behind narrow owners; execution, budget reservation and settlement stay in their
existing services. Shared worker guards retain current protected assignment and
workload checks. MCP separates live admission from historical frozen-profile
decoding and keeps connection/credential custody in its transport owner.
Existing channel diagnostics and author guidance are factored without adding
channels, activating capabilities or enabling automation.

All **20** dependency regressions have closure evidence. Representative current
counts are Chat runner **113/113**, autonomous turns **89/91**, static MCP
**14/16**, integration diagnostics **138/146**, integration composition **104/105**,
approval effects **259/259**, cron generation **21/21**, cron automation **86/86**,
mesh binding **2/2**, and worker Chat authority/offer **6/6** and **5/5**.
New owners, including inherited OAuth and Nextcloud inventory gaps, are reviewed
and registered separately. Imported indexed/Pick types cause known single-file
scanner omissions: conservative registrations retain the inspected accesses
(static admission 22, historical static authority 6, worker tool binding 5,
Chat feature runtime 19); these accesses are not claimed absent.

Validation retains **209 passed / 2 failed / 20 skipped** in the first 16-file
runtime run (`architecture-runtime-regression-tests.log`). Both failures were
stale fixtures: a prep-port source assertion and a scheduled occurrence missing
its required creator receipt/profile. The corrected two-file run passes
**25 / 18 skipped** (`architecture-fixture-regression-tests-final.log`), giving
all **211 distinct executed tests** passing evidence. Historical skips remain
unrun. The earlier owner run retained an import-cycle/mock failure; splitting
worker execution revalidation from live-admission guards fixes the cycle, and
the final runtime run passes the remote policy/effect files without weakening
authority checks. The first Gateway extraction run also caught a forbidden
GatewayService type coupling; the replay port now uses explicit domain types,
and its architecture guard passes.

The final five-file operator/effect suite passes **111/111**, zero skips
(`architecture-operator-effect-regression-tests.log`). It includes a real
SQLite regression that preserves the pending fanout action, yields execution
to durable Chat, and prevents the settled approval effect from being claimed
again after processor replacement. Integration setup guidance composition,
approval recovery and Nextcloud diagnostics also pass. Together, these runs
provide **322 distinct executed runtime/operator cases** with passing evidence;
the 20 historical skips are still unrun.

Locked Gateway typecheck passes (`architecture-remediation-typecheck-final.log`),
async boundary passes **16 tests / 1,203 production files**
(`architecture-remediation-async-final.log`), and new-owner allowance validation
passes **14/14** (`architecture-remediation-allowances.log`). Only the new owner
files were formatted; the large Gateway file was not mechanically reformatted.
Full docs checks pass (`architecture-remediation-docs-final.log`).
No live model calls, provider spend, physical-machine acceptance, installation,
publication or production-data changes were performed.

- Native recovery now uses the normal OpenClaw Gateway config writer and Hermes
  config/CLI launch paths. Both bind one metered fallback and one explicitly
  reviewed marker tool before launch, with the original cell deadline and isolated
  runtime identity. Public terminal/history readers join exact model, workspace,
  prompt, session and tool-call receipts. OpenClaw's terminal route remains labeled
  `native_rpc`, not Chat-visible evidence. Hermes custom billing does not identify
  the fallback alias. Neither reader fabricates canonical reconciliation from
  assistant text, an error or a dropped response. The original acceptance
  predicates remain unchanged and unavailable metrics cannot pass them.
  Controlled binding/product/supervisor checks pass **49/49**
  (`native-recovery-launch-initial-tests.log`), launch checks pass **8/8**
  (`native-recovery-launch-tests.log`), and complete recovery-phase tests pass
  **4/4**, including the actual 30-second observation window for both products
  (`native-recovery-evidence-tests.log`). Native process/model responses in these
  tests are controlled fixtures; no live product/model trial ran.
- Approved requester/static/mesh resume orchestration moves into the existing
  admission-approval owner. Gateway still refreshes policy and executes pending
  approvals; canonical receipt materialization uses the same transaction and
  stored settled outcomes are never dispatched again. **42/42** focused tests
  and locked Gateway typecheck pass (`requester-resume-owner-tests.log`,
  `requester-resume-typecheck-final.log`). Gateway decreases **13,924 → 13,876
  lines**. The new owner registration records eight callbacks and a conservative
  22 dependency accesses, including 14 storage-alias accesses missed by the
  single-file counter. No original baseline or existing-owner cap is raised.
  Additional dispatch and remote authority owner registrations retain their
  reviewed evidence. This is not architecture gate closure.
- Remote placement selection now lives in the same remote admission authority
  owner, using an explicit ten-port contract and both original admission fences.
  Schema mapping, current policy, exact mesh evidence and conservative effect
  classification are unchanged. Gateway decreases another **91 lines to 13,785**;
  the remote owner measures **17 host / 21 dependency accesses**. Locked Gateway
  typecheck passes (`remote-selection-extraction-typecheck-final.log`). The
  five-file run retains **111 passes / one new test-fixture failure**
  (`recovery-owner-final-tests.log`); the corrected policy fixture passes all
  **17 tests** on rerun (`remote-selection-extraction-rerun.log`). Thus all 112
  distinct tests have passing evidence, including Gateway adapters and approval
  resume. The prior failure remains retained.
- Explicit-context source-access revalidation moves verbatim into the existing
  context admission owner, retaining the old source-service compatibility export.
  The source resolver returns to its original **0 host / 9 dependency** accesses.
  Fanout admission uses its existing narrow authority port directly, preserving
  the original receiver and failing closed when its callback is absent. Dispatch
  measures **61/61**, below its original **62/62** limits; preparation still exceeds
  its original limit. Stream diagnostics now share common event fields through
  one emitter (**1/1**, below the original **2/2**), with **300 differential cases**
  preserving all normalized events and clock boundaries
  (`stream-observer-differential.json`). Guard validation passes **175 tests / 13
  skips** (`architecture-guard-tests.log`) and locked Gateway typecheck passes
  (`architecture-guard-typecheck.log`). Skips are not accepted as executed proof.
- Final comparison/allowance family passes **289/289**, zero failures, skips or
  cancellations (`native-recovery-complete-family-tests.log`, 189.2 seconds).
  Reader refusals additionally cover oversized attempt traces and foreign
  model/provider attempts. These controlled results retain **zero live model
  calls and zero provider dollars**.
- Further remote authority composition moves into its admission owner, retaining
  exact actor/scope, workspace Citadel, current route, explicit context, selected
  tool schemas, runtime owner and policy checks. **81/81** focused remote/Gateway
  caller tests and typecheck pass (`remote-composition-tests.log`,
  `remote-composition-typecheck-final.log`). The owner now measures **34/38**;
  this additional coupling is explicit, not hidden by renamed callback bags.
  Fresh fallback configuration reads move to the fallback authority adapter;
  **125/125** tests and typecheck pass (`current-fallback-tests.log`,
  `current-fallback-typecheck.log`). Completion returns to its original **51/51**.
- Saved/requester MCP nomination and mesh policy filtering move from Gateway
  into their existing admission owners. Duplicate requester selections and
  missing saved-tool actor authority fail before discovery; mesh access denial
  filters schemas and admission revocation after inspection fails closed.
  Gateway measures **13,590 lines** before the canonical scan
  (`native-selection-metrics.json`), down 334 from the 13,924 checkpoint.
  The five-file selection run retains **72 passes / one new assertion failure**
  (`native-selection-tests.log`): the test incorrectly compared a structured
  error code to its human-readable message. The corrected assertion uses
  `code`; the requester file passes on the **110/110** evidence-owner run
  (`evidence-owner-tests.log`). All 73 distinct selection tests have passing
  evidence. Typecheck passes (`native-selection-typecheck-final.log`,
  `evidence-owner-typecheck.log`). Fanout completion reads and channel activation
  receipt assembly now use their evidence owners, returning stream to **91/92**
  and channel setup to **55/60**, within original limits.
- Admission-bound context replay validation also moves verbatim to its context
  admission owner. Historical profile replay stays in durable execution.
  **147/147** tests and typecheck pass (`durable-context-guard-tests.log`,
  `durable-context-guard-typecheck-final.log`). Durable execution measures
  **126/159**, within original **129/162** limits. Context admission measures
  **21/21**, registered separately (`durable-context-guard-metrics.json`).
  Reviewed new-owner registrations also cover selected-feature binding,
  schedule/heartbeat authority, requester schema/scope, diagnostic and retained
  setup evidence adapters. Every original baseline and existing-owner cap is
  unchanged. The subsequent full scan remains **failed**:
  `artifacts/verification/2026-10-12T21-40-08-535Z-architecture-metrics-96e6e28a`.
  It retains Gateway **13,590/13,132 lines**, **311/309 public methods** and
  outstanding existing-owner coupling and inherited-owner registration gaps.
- Fanout admission/project/grant guards and shared pure binding helpers move
  into a narrow guard owner. Reservation, child launch, cancellation, aggregate
  mutation, settlement and wake remain in `ChatDurableFanoutService`. **57/57**
  tests and Gateway typecheck pass (`fanout-authority-tests-final.log`,
  `fanout-authority-typecheck-final.log`). The durable service decreases to
  **588 lines** and returns from **53/53 → 32/32** accesses, its original cap.
  The new guard measures **21/21**; its registration conservatively records
  **23 dependency accesses**, including two storage-alias repository reads
  (`fanout-authority-metrics-final.json`). This does not waive remaining Gateway,
  preparation, native MCP or other service regressions.
- Explicit-context composition now belongs to its admission owner through a
  typed internal preparation port. Gateway's two schema/binding implementation
  methods are private; historical preparation callback hosts remain supported.
  Preparation returns to its original **55/58** accesses. The new owner measures
  **29/29**, including the port dispatch reads; Gateway measures **13,600 lines**.
  The four-file preparation/replay run passes **89 tests / 13 skips**
  (`context-preparation-tests.log`). The actual internal port, with legacy façade
  callbacks absent, passes in **9 current cases / 13 historical skips**
  (`context-preparation-port-tests.log`). Gateway typecheck passes
  (`context-preparation-port-typecheck.log`). The extraction's failed intermediate
  typechecks are retained; none are treated as runtime or acceptance evidence.
  The final named architecture scan, rather than these local counters, determines
  remaining acceptance gaps.
- The preceding named architecture result was **failed** at
  `artifacts/verification/2026-10-12T21-57-00-064Z-architecture-metrics-0e4e32b0`.
  Gateway public methods and all host-callback limits pass. Gateway remains
  **13,600 / 13,132 lines**, with **20** remaining dependency-access regressions,
  including inherited channel OAuth/Nextcloud owner-registration debt. The
  native launch/recovery-reader work is implemented and controlled-tested;
  architecture remediation was not complete at that checkpoint. Async boundary passes
  **16 tests / 1,183 production files**, full docs pass, new-owner allowance
  checks pass **14/14**, and native formatting/syntax/whitespace pass. Logs are
  `native-architecture-async-closure.log`, `native-architecture-docs-closure.log`,
  `native-architecture-allowance-closure.log` and `native-launch-format-closure.log`.
  Live trials and two-machine acceptance remain deferred; no release or
  production change was performed.

- Read-only capability discovery and governed skill-content reads now have an
  explicit narrow owner outside Gateway. Each call still checks the enabled
  feature and current canonical session workspace before reading the callable
  catalog, lifecycle or skill content. Scope mismatch, disabled discovery and
  inactive skill refusal have focused coverage. The five-file run passes 43
  tests and retains one requester-MCP timeout (`discovery-owner-tests.log`);
  that integration file passes **19/19** alone at its unchanged 15-second limit
  (`discovery-owner-mcp-rerun.log`). Thus all 44 distinct tests have passing
  evidence; the original failed run is not erased. Final locked Gateway
  typecheck passes (`discovery-owner-final-typecheck.log`). The new owner is
  registered at its explicitly measured **six host/dependency accesses**, with
  all original baseline and existing-owner limits unchanged.
  The full architecture scan remains **failed**:
  `artifacts/verification/2026-10-12T20-32-00-267Z-architecture-metrics-97d7967f`.
  It measured Gateway at **13,924 lines versus 13,132**, with 311 public methods
  versus 309, before the new-owner registration. Other existing-owner and
  unregistered new-owner regressions remain. The registration is not a pass.
- OpenClaw and Hermes export pinned configuration bindings for one native
  fallback and the reviewed marker MCP transport. Both retain the metered
  loopback route, model/context/output limits, deadline and separate permission
  review. They reject ambient routes, changed pins, enlarged output budgets,
  pre-existing fallback/MCP definitions and expired scopes. Real controlled
  HTTP tests retain the nonce marker before dropping its response and observe
  one dispatch without inventing native blocked/reconciliation state.
  **66 recovery/fault/product-adapter/allowance checks** pass with zero skips
  (`output/feature-quality/native-recovery-final-tests.log`). These are binding
  components. The subsequent launch/readers slice above completes the native
  adapter journey; public native receipts still cannot satisfy every unchanged
  acceptance metric. Live trials remain deferred and no model request or spend
  occurred.
  Closure checks pass: **16 async-boundary tests / 1,182 production files**, full
  docs and whitespace (`output/feature-quality/discovery-recovery-closure.json`).

- Fanout result projection is extracted as a pure helper, shared by immediate
  completion and recovered aggregate reads. Durable storage, grants, cancellation,
  settlement and wake ownership remain in `ChatDurableFanoutService`. The focused
  owner/projection tests pass **31/31**, and **867 differential cases** match the
  pre-extraction implementation, including incomplete output suppression,
  premature synthesis suppression, terminal failures and bounded excerpts.
  Locked Gateway typecheck passes. Receipts are
  `output/feature-quality/fanout-projection-tests.log`,
  `fanout-projection-differential.json` and `fanout-projection-typecheck.log`.
  The durable owner decreases **855 → 771 lines**; its host/dependency accesses
  remain **53/53**, and the pure helper has **0/0**. This is a readability
  extraction, not closure of the coupling gate (`fanout-projection-metrics.json`).
  Async boundary passes **16 tests / 1,181 production files**; the full docs lane
  and whitespace check pass (`fanout-projection-closure.json`). Final ledger-only
  documentation and whitespace checks pass again after recording these results.

- Primary and fallback completion dispatch now share adapters in the existing
  feature-dispatch authority owner. The fallback guard remains outside the
  admission and explicit-context guards; provider arguments, attribution,
  cancellation and original deadline handling remain with their current owners.
  **124 focused dispatch/fallback/completion tests** pass with zero failures or
  skips (`output/feature-quality/dispatch-adapter-tests.log`). Final locked
  Gateway typecheck passes (`dispatch-adapter-port-typecheck-final.log`).
  Differential tests cover exact transport arguments, all three guards,
  deferred-stream revocation and missing fallback transport support.
  Completion-service host/dependency accesses decrease **61 → 53**. The dispatch
  port is explicitly typed and measurable. Initial extraction had zero host
  callbacks and ten dependency accesses (`dispatch-adapter-metrics-final.json`).
  Capturing each fallback guard method once, with its original receiver, reduces
  that to **zero host callbacks and eight dependency accesses**
  (`dispatch-adapter-bind-metrics.json`). Final typecheck and all **124 focused
  tests** pass again (`dispatch-adapter-bind-typecheck.log`,
  `dispatch-adapter-bind-tests.log`). The named runtime receipt below predates
  this final method-capture change; it remains a checkpoint, not a promoted
  final-candidate certificate. The older
  indexed transport alias measured zero dependency accesses; that measurement
  limitation is not treated as zero actual coupling. Aggregate dependency debt
  is not claimed improved, and the unchanged architecture gate remains open.
  Runtime truth passes **4/4 with zero skips** in
  `artifacts/verification/2026-10-12T17-24-32-740Z-runtime-truth-00b91a89`.
  This includes the real authenticated approval, actual owned Gateway restart,
  recovered completed Chat, research tool exposure and served canonical UI.
  Root inspected the retained approval/recovery screenshot. The optional approval
  explainer's non-JSON controlled response remains visibly unavailable; it is not
  relabeled successful. Async boundary passes **16 tests and 1,180 files**, with
  governance documentation and whitespace also passing (`dispatch-adapter-closure.json`).
- The preceding runtime-truth run remains retained as failed (three passed,
  one failed): `artifacts/verification/2026-10-12T17-16-44-802Z-runtime-truth-67c0ca81`.
  Retained browser diagnostics show a successful exact recovered-thread GET
  after the response observer had expired during navigation/hydration. The lane
  now captures the first matching successful GET before navigation and starts
  any remaining response wait after readiness. Exact durable identity,
  completion and visible-reply predicates are unchanged. **Seven observer/lane
  tests** pass, including foreign sessions, non-GET/error responses, first-response
  preservation and listener cleanup (`runtime-truth-response-observer-tests.log`).
- A fresh preflight checks all five configured local provider IDs, without
  credentials, inference, starts or downloads. At **2026-10-12T17:38:20Z**,
  llama.cpp, LocalAI, LM Studio and NPU endpoints are unreachable; Ollama replies
  HTTP 200 but its model-list payload has no valid `data` array. No local model
  can be pinned from these observations. The shape-validated Node receipt is
  `output/feature-quality/all-local-provider-preflight-final.json`.
  Earlier PowerShell receipts are retained and superseded; a null-array counting
  error reported a phantom entry, which is not treated as model availability.
- The shared provider-schema selector now merges identical canonical/model/schema
  candidates before enforcing exposure budgets. Required reasons retain their
  strongest priority; duplicate candidates no longer duplicate provider schemas,
  inflate token estimates or consume the remote sixteen-tool limit. Conflicting
  canonical schemas/aliases or model names shared by different canonical tools
  fail closed, including candidates that would otherwise be deferred.
  Diagnostics distinguish distinct candidates from duplicates. Original policy
  filtering, eight-tool/2,200-token soft targets and required-tool exceptions
  remain. **Six owner tests** and the locked Gateway typecheck pass in
  `output/feature-quality/schema-identity-owner-tests.log` and
  `output/feature-quality/schema-identity-typecheck.log`. Live behavior remains
  unverified. Final Chat/schema/remote-selection/sequence caller tests pass
  **34 assertions across four files** with exit zero in
  `output/feature-quality/schema-identity-caller-tests.log`. The run reports
  two fork-termination warnings; both remain in the receipt. No matching task
  test runner/worker remained in the subsequent scoped process inventory.
  Async boundary passes **16 tests and 1,180 files**; governance documentation
  and whitespace pass (`schema-identity-closure.json`).
  A credential-free local preflight refreshed at **2026-10-12T16:50:55Z** still
  finds no port-8080 model endpoint and zero installed Ollama models on 11434
  (`output/feature-quality/local-preflight-refresh.json`). No model was started,
  downloaded or invoked; the local live lane remains incomplete.
- Remote admission schema selection and effect classification now use pure
  helpers in the existing remote admission authority owner. Initial placement
  and current worker revalidation share conservative effect rules; live policy,
  runtime-owner resolution, grant checks and write fences remain in their owners.
  Gateway decreased **14,025 → 13,960 lines**. Public methods (**311**), Chat
  host callbacks (**492**), total callbacks (**1,412**) and dependency accesses
  (**11,138**) are unchanged. The fresh architecture receipt still **fails**:
  `artifacts/verification/2026-10-12T16-29-21-629Z-architecture-metrics-4d8be76f`.
  No baseline or allowance was changed.
  Final Gateway typecheck and **39 admission/sequence tests** pass; logs:
  `output/feature-quality/remote-selection-final-typecheck.log` and
  `output/feature-quality/remote-selection-final-owner-tests.log`.
  The async boundary passes **16 tests and 1,180 production files**; governance
  documentation and whitespace pass (`remote-selection-closure.json`).
- Remote offer validation isolated a fixture preparation timeout: a fresh SQLite
  fixture took **21,938 ms**, while the first offer operation took **82 ms**.
  Fresh fixture creation now has a separately bounded 45-second setup hook;
  the original 15-second execution timeout and replay/denial/claim assertions
  remain. All **four offer tests pass** in
  `output/feature-quality/remote-offer-separated-setup-tests.log`.
  Earlier parallel/serial failures and stage timing remain in
  `remote-selection-tests.log`, `remote-selection-tests-serial.log` and
  `remote-offer-stage-diagnostic.log`; passing reruns do not erase them.
  These focused tests are separate from the 267 comparison conformance tests.
- The subsequent serial remote selection/authority/offer/placement group passes
  **52 assertions across four files**, exit zero, in
  `output/feature-quality/remote-selection-complete-tests.log`. It reports a
  placement fork-termination warning. An incorrectly named sequence path in that
  invocation selected no file; the correctly named sequence test is included in
  the final 34-assertion caller run above. Counts are reported by actual executed
  files, not requested paths, and overlap between these groups is not new coverage.
- Final canonical Mission Control typecheck and shared dependency builds passed
  under the repository output lock (`output/feature-quality/final-ui-typecheck.log`).
  Async boundary passed **16 tests, zero skips**, with **1,180 production files**
  scanned. `pnpm docs:check`, new comparison module syntax/formatting and
  `git diff --check` passed. Raw closure logs use `output/feature-quality/final-*`.
- Architecture metrics **failed**:
  `artifacts/verification/2026-10-12T15-36-01-060Z-architecture-metrics-8e864849`.
  The candidate exceeds the unchanged guard for Gateway lines/public methods and
  typed host callbacks/dependency accesses. The guard is not rebased or waived.
  This is a remaining maintainability acceptance gap, distinct from passed runtime
  safety and recovery tests. An archived exact-base source measurement is retained
  under `output/feature-quality/architecture-base-*` for attribution; it is not
  a second implementation checkout or promotion evidence.
  The exact base also fails the guard with **15 regressions**, so the failure is
  partly inherited. This change nevertheless adds real coupling: Gateway
  **13,112 → 14,025 lines**, **305 → 311 public methods**, Chat host callbacks
  **366 → 492**, total service host callbacks **1,215 → 1,412**, and dependency
  member accesses **10,840 → 11,138**. The differential is
  `output/feature-quality/architecture-differential.json`. These increases are
  not excused by the inherited debt. Narrow owner/adapter remediation and a fresh
  architecture pass remain required before claiming completion of maintainability.
- Full MCP requester-scope rerun passes in
  `artifacts/verification/2026-10-12T15-13-09-671Z-mcp-requester-scope-56c80d02`:
  **15 scenarios, zero failed or skipped scenarios**, 18 executed check groups
  passed and one conditional live-PostgreSQL sub-check skipped with its actual
  missing-URL reason. Separate fresh/upgrade PostgreSQL proof remains retained.
  Runtime truth within this run passes **4/4, zero skips** in
  `artifacts/verification/2026-10-12T15-20-44-439Z-runtime-truth-b16531be`.
  Original failed combined receipt and all focused repair receipts remain below.
- Memory truth passes **3/3, zero skips** in
  `artifacts/verification/2026-10-12T15-11-44-197Z-memory-truth-c019ff4b`.
  The browser enumerates all 503 scoped records, observes an actual stale cursor
  after a 504th write, reloads from the first page and verifies all current IDs.
  The policy journey races a real Gateway write after browser preflight, retains
  the winning policy and draft, and saves only after review against the new revision.
- Validation found two operator recovery defects: refreshing reused a stale
  continuation cursor, and failed maintenance saves displayed feedback behind
  the confirmation dialog. The canonical Memory workspace now resets paging
  when reloading and displays the save error inside the open dialog.
- Failed memory receipts remain retained: `14-34-53-817Z` (startup health timeout),
  `14-40-49-146Z` (obsolete Classic heading), `14-52-06-573Z` (recovery/callout),
  `14-58-11-509Z` (dialog hides the background editor from accessibility queries),
  and `15-06-03-831Z` (intermittent initial shell-readiness timeout; the other two
  scenarios passed). Initial-route failure capture was added without relaxing
  the readiness predicate. The final responsive run also passes **3/3, zero skips**:
  `artifacts/verification/2026-10-12T15-27-52-636Z-memory-truth-9588a0ec`.
  Both recovery states at 1440 and 390 pixels have **zero axe violations and no
  horizontal overflow**. Root visually inspected the desktop/mobile conflict
  dialog and mobile stale-directory recovery. The existing mobile dialog has
  bounded vertical scrolling; this proof does not assert every control fits at once.
- Final MCP browser receipt:
  `output/playwright/2026-10-12T02-34-14-968Z-usability-ede6ccd7/tested-evidence-summary.json`.
  An authenticated fresh Chat needed a real UI approval; canonical durable resume
  performed exactly one read-only MCP call. Its retained link was keyboard-activated
  for the exact session/turn. Changing the server revision made evidence stale and
  removed the link. Six desktop/mobile captures have zero axe violations and no
  overflow. Root visually inspected current desktop/mobile and stale desktop.
  Owned launcher/browser/stub/Gateway cleanup and free ports were verified.
- The shipped comparison supervisor now pins the imported driver family and native
  executable, uses fresh task-owned state, public APIs/native CLI and typed human
  reviews, and keeps setup/restart/observation within the original deadline.
  Controlled transport faults retain request accounting and distinguish reaching
  the fixture from forwarding upstream. The entire comparison family passes
  **267 tests, zero failures/skips/cancellations**, in 155.0 seconds; raw log:
  `output/feature-quality/comparison-final-tests.log`. This includes unchanged
  original fixtures, both track budgets, native web transcripts, typed review,
  imported-driver fingerprinting, controlled charged failures, exact MCP approval,
  and the 30-second uncertain-send observation. Controlled fixtures do not prove
  real model quality or a native launched candidate against hosted/local models.
  Subsequent OpenClaw/Hermes recovery launch/readers proof is recorded above;
  their exact unsupported scheduling/delegation predicates do not imply that the
  native products lack those features. Live comparative requests remain **0/$0**.

## Baseline capability inventory

`usable` means a normal supported entry point exists in current source; it does
not imply fresh live comparative proof. `conditional` requires stated settings,
grants or configuration. `paused/historical` is retained replay or implementation
without a normal new-Chat admission. `missing` means the reviewed addition has
no current implementation. `unverified` is an acceptance evidence gap.

| Capability | Baseline class | Entry point and owner | Restriction | Acceptance |
|---|---|---|---|---|
| Ordinary Chat, live callable tools | usable | Chat; turn prep / agent runner / policy executor | Current grants, approvals and scope apply | Public fresh-session task and interruption |
| Skill metadata selection | usable | Callable skill activation; skills activation owner | Existing substring selector; ranking is evaluation-only | Explicit aliases and labeled ranking comparison |
| Governed skill content | paused/historical | Governed instruction service through frozen profile replay | Normal new Chat does not bind instruction receipts | Capture, review, activate, fresh Chat reuse, revoke |
| Skill capture/review/activation | conditional | Workflow capture control; capability lifecycle owners | Candidate remains inactive until governed activation | Complete lifecycle including subsequent task benefit |
| Tool exposure budget | missing | Agent runner tool selection | Profile-free path exposes unbounded ordinary tools | Serialized schema cost plus task reachability |
| Memory retrieval and editing | usable | MemoryLifecycleService / MemoryContextService / memory-core | Access receipts, lexical fallback; quality needs labeled evidence | Relevant retrieval, forget/scope invalidation and timings |
| Provider fallback | paused/historical | Route resolution / completion service | New Chat cross-provider fallback is not configured | One authorized target before output; no privacy crossing |
| Explicit routed context | paused/historical | Routed-context snapshot owner | Snapshot persistence currently requires historical profile binding | Admitted bytes survive edits/replay; revoked access refuses |
| Supervised local delegation | conditional | Local child admission / delegation owners | Exact project, grant, admitted actor and bounded budget | Mixed child outcomes, cancellation and restart |
| Automatic fanout | paused/historical | Fanout aggregate / durable Chat | Existing profile-bound admission; maximum three children | Explicit opt-in and grant, no recursive scheduled children |
| Governed Code Mode | conditional | Existing approval/artifact/execution owners | Trusted code only; normal delegation integration incomplete | Approval/hash integrity, cancellation and retained output |
| Reminder scheduling | usable | Cron/reminder and delivery owners | A reminder does not execute an agent task | Independent delivery evidence |
| Scheduled agent Chat | paused/historical | Autonomous turn service / cron durable owner | Unconditional new-admission pause | Tool-using occurrence, overlap/missed skip, recovery |
| Proactive heartbeat work | paused/historical | Heartbeat occurrences / autonomous turn owner | New-admission pause; Inbox fallback remains | Quiet decisions, preemption, restart, delivery-only retry |
| Configured MCP connections | conditional | MCP Settings, manager, policy and approvals | Saved/connected/discovered are different from callable | Guided setup through real governed sample task |
| Requester-scoped Chat MCP | paused/historical | Requester resolver / connection registry | Frozen profile/process-local authority; default resolver empty | Admitted actor, generation/schema drift and restart refusal |
| Extension SDK packaging | usable | SDK validators and manifests | Optional guided form metadata absent | Old manifests valid; actionable author preflight |
| Native remote execution | unverified | Existing C5 worker/admission owners | Requires fresh physical Windows-to-Windows evidence | Admission, approval, cancel, artifact, worker death/recovery |
| Hosted comparison | conditional | Existing C6 comparison harness | Old pinned adapters; live config/revision preflight required | 45 trials under shared $25/450 ceiling |
| Local comparison | missing | Existing C6 transport/accounting | Hosted-only transport and positive-price assumptions | Loopback HTTP, zero dollars, bounded requests/deadline/tokens |

## Implementation and evidence

Work is in progress in the isolated checkout
`.worktrees/feature-quality-runtime-implementation`. Changes are uncommitted.
The following records source and controlled-test evidence, not release,
installed-runtime, live-model or physical-machine acceptance.

| Slice | Implementation | Deterministic proof | Live proof |
|---|---|---|---|
| Local transport and shared pilot accounting | Loopback-only local HTTP; zero provider dollars; unchanged request/token/deadline bounds; shared hosted journal | Comparison harness checkpoint passes 201 tests with zero skips; subsequent Goat adapter suite passes seven tests; original five fixtures unchanged | 0 hosted / 0 local trials |
| Admission references and final dispatch | Exact admission/lease and immutable selected references; historical replay preserved; actual transport rechecks authority after hooks; canonical child run identity stays distinct from delegation policy identity | SQLite binding/immutability/replay and transport guard tests pass; real PostgreSQL fresh and v200-to-v208 upgrade, repeated startup, exact binding, immutability and settlement pass | No live model |
| Ranked skills | Description-aware BM25; legacy/shadow/ranked; callable-only, explicit first; bounded implicit candidates and activations | Selection, integrity, budget and token/basic/loopback public lifecycle proofs pass: capture/review/approve/activate V1, fresh Chat V1 reuse, activate V2, fresh Chat V2 reuse, actual rollback to V1 with new approval, fresh Chat V1 reuse, then revoke and no fresh instruction reuse | Task benefit not measured with real models |
| Tools and prompt cost | Eight-tool/2,200 estimated serialized-schema-token soft target; essential overage diagnostics; read-only deferred discovery; normalized prompt/schema hashes after context and hooks; first useful text/tool-call timing distinct from first control chunk | Quick-web, sustained coding, schema budget, discovery and effect-owner tests pass; completion/telemetry 68 tests pass | Provider cache usage remains the provider-reported canonical usage metric; no comparative token savings claim |
| Memory | In-flight deduplication with cancellation; scoped access; labeled relevance/abstention metrics and stage timings | Retrieval, cancellation, lexical fallback and labeled benchmark tests pass | No live retrieval-quality comparison |
| Fallback and explicit context | Configured one-target fallback via server handle; admitted v3 context bytes; current access and context capacity checks | Fresh authenticated Chat with two controlled HTTP endpoints proves configured fallback and actual route retention; public integration, stream aggregation and completion owner suites pass 79 tests. Context admission/replay/denial and desktop/mobile browser composition pass | No hosted/local model acceptance |
| Delegation | Durable admission-bound automatic children; default ask policy; exact project/grant; three-child cap; bounded result schema and one consumed correction checkpoint | Fresh public Chat and public approval/resume both complete through two unique child admissions, canonical wait/join and same-parent synthesis; public/aggregate/wait suites pass 33 tests. Existing local-authority and result-contract suites pass | Local dispatcher executes children serially; no simultaneous-inference or real-model synthesis claim. Whole-Gateway crash cleanup and escaped process descendants remain unconfirmed |
| Scheduled Chat and heartbeat | Separate default-off switches; canonical occurrences, persisted server-issued creator receipts, live policy checks, durable settlement and delivery independence | Authenticated public cron create/run and canonical heartbeat both execute real `time.now` through durable Chat with a controlled provider; full app restart retains settled occurrences without another provider call. Heartbeat settlement and public integration pass seven tests. PostgreSQL receipt persistence, import refusal and changed-action invalidation pass | No live scheduled tool-using or channel delivery proof |
| Commitments | Source-turn creator evidence and one-shot canonical cron binding; unprovable historical authority remains Inbox-only | Six occurrence authority/overlap tests, 19 historical repository tests, and shared Gateway scheduling checks pass | Not run |
| Requester MCP | Actor/session admission scope; selected generation/schema receipts; live resolver and claim checks; canonical approval resume and ambiguous-send retention | Resolver/runtime, schema, approval join and materialization tests pass | Stock installation needs an actor-bound resolver; no shared-credential substitution |
| MCP and extensions | Guided setup states; optional versioned form metadata; backward-compatible author preflight | SDK, author validators and MCP UI component tests pass. Fresh browser Chat completes an actual fixed read-only HTTP MCP call after UI approval, with zero calls before approval and one retained effect receipt | Controlled provider and task-owned MCP server; no live third-party integration or model claim |
| Mesh and remote placement | Selected mesh publication/activation and exclusive worker admission variants use existing C5 owners; no synthetic frozen profile | Mesh selected-catalog/dispatch/approval tests pass; remote Gateway 174 tests, worker/contracts 73 tests, provisioner 34 tests with four skips; real storage admission-to-durable context freeze passes | Fresh two-machine acceptance unavailable |

The shared tool-effect owner regression suite passed 301 tests across coordinator,
policy and executor cases. These controlled receipts prove covered retry and
unknown-outcome decisions; they do not establish that an arbitrary remote effect
did or did not occur. The storage proof caught and corrected fresh-bootstrap
idempotence, schema-local migration and v3 context schema-validation defects.
Fresh and upgrade PostgreSQL proof now passes through migration 208, including
second-startup schema validation and creator-authority receipt checks (two tests,
zero skips). Migration parity and its 27 regression tests pass through SQLite
261/PostgreSQL 208. All published migration history remains
unchanged. This is a disposable-database proof, not a production-data migration.

Completion preparation now consumes the original deadline, including memory and
hooks. Exhaustion blocks provider dispatch and persists failed/interrupted truth;
expired final synthesis or revoked authority cannot be relabeled as model recovery.
Focused deadline/fallback/usage suites pass. Local-to-cloud consent includes
Docker, tailnet, short local hostnames and private/mapped IPv6 endpoint forms;
network policy remains a separate check. The shared Settings owner projects
availability for both the public route and internal callers.

The default Cockpit Conversation inspector now mounts fallback preferences,
supervised plan approval and coding delegate actions. Automatic fanout requires
explicit confirmation and current project-grant availability. Historical or
mismatched session selections do not expose these mutation controls. Nineteen
focused UI tests pass; scoped Cockpit styles give the new controls spacing,
visible focus and usable interaction targets. Visual/browser acceptance remains separate. The shared
Settings regression run passed 79 tests with one existing skip; Vitest reported
worker-termination warnings after the successful test result.

The public fallback proof exposed a stream-aggregation defect: successful backup
output lost its Gateway routing metadata. Final stream chunks now carry an
in-process canonical routing receipt through aggregation. Provider JSON and
serialized copies cannot mint this receipt. The public test verifies the backup
provider/model and exactly one successful backup completion request.

Windows background-process cleanup persists the existing tool result's exact
host, PID, creation time, session and turn. On canonical child settlement it
checks and terminates the same process handle. Historical PID-only receipts fail
closed, and outcomes remain explicit. This proves only the recorded root process;
escaped descendants and POSIX restart cleanup are not certified.
The focused process proof does not simulate an entire Gateway crash. Six additional
cleanup tests prove bounded maintenance discovery after terminal-step commit and
SQLite reopen, native termination before a lost ACK, cursor wrap and sub-page
fairness, and ownership changes before native termination or ACK. Discovery uses
existing step/tool indexes and a bounded cursor; canonical tool receipts remain
the authority. Missing descendants are never inferred safe from a root-process ACK.
Live settlement also forgets volatile browser state before any awaited retained
process cleanup, and a final cancellation check prevents an in-flight browser
snapshot from recreating that state. Seventy focused cleanup/browser tests pass,
including a failed cleanup receipt and cancellation during the final snapshot.
Existing Playwright operations close their browser and egress handles on abort
and in `finally`; abrupt process crashes and unrecorded descendants remain outside
the retained-identity proof.
Live MCP stdio sessions now retain a server-issued exact child session/turn
owner. Settlement closes captured entries, including pending client creation,
without closing sibling, parent, shared operator or replacement sessions. Forty
focused tests pass across pool ownership (12), static MCP (21) and child cleanup
(7). Close requests are not represented as confirmed OS process exits; an abrupt
Gateway crash before a native MCP identity receipt remains outside this proof.
An earlier loaded-host run hit subprocess startup timeouts and a test-fixture
cleanup error. The replay fixture now owns one direct process handle, avoiding
an untracked shell descendant; the bounded serial rerun passed all 40 cases.

Browser evidence retained under
`output/playwright/2026-10-11T22-35-08-578Z-usability-8c55c7d4` proves fresh Chat
Include/Send/completion with exact admitted note bytes and the scoped snapshot
inspection. Desktop and 390px mobile controls were visually reviewed; both axe
checks report zero violations, mobile has no horizontal overflow, and keyboard
focus reaches the inspector controls. This uses a controlled provider, not a live
model. The same journey connected a saved HTTP MCP server and discovered its
tool; it exposed missing new-Chat static-MCP composition that was subsequently corrected.

Static and requester MCP now use separate selected-receipt owners. Combined
composition and default-off/persistence tests pass with the shared admission
and UI availability suites (31 tests). The public browser sample now proves
one real static HTTP invocation after persisted UI approval and same-Chat durable
resume. The result is retained in
`output/playwright/2026-10-11T23-30-44-392Z-usability-9ba0081a`: turn
`27f86845-5aaa-4529-9182-907805443d3f`, approval
`8e351e8c-b789-48da-b56d-46597c63fa03`, tool run
`defe2152-6db6-4be1-a39e-f33d16b894f4`, and concrete effect receipt
`extfx_243f2c64a4614d8db93e843d`. The fixture recorded zero calls before
approval and exactly one after approval. Its earlier failed attempts remain
separate diagnostic history.
The final desktop Chat result and desktop/mobile MCP inspector were visually
reviewed. Four Chat/inspector accessibility checks report zero axe violations;
the mobile page has no horizontal overflow and keyboard focus reaches Attach.
The mobile Chat screenshot retains an earlier failed turn, so it proves layout
and focus rather than visible successful completion. At that browser checkpoint,
the inspector left Tested unverified; actual execution proof remained the retained
Chat tool/effect receipt. Disabled/unknown availability has component coverage,
not browser proof. The task-owned fixture exited cleanly and its Gateway, UI and
MCP ports were verified free.
`verified-mcp-summary.json` in the same artifact directory records the checked
canonical IDs, call counts, result and accessibility outcomes. Its assertions can
be rerun with `node output/playwright/summarize-feature-quality-mcp-proof.mjs
output/playwright/2026-10-11T23-30-44-392Z-usability-9ba0081a`.
The public path caught and corrected a missing admission-context handoff to the
native permission probe, then a mistaken comparison between the separate
approval-wait workflow and Chat run IDs. Exact pending action, approval, Chat,
turn, actor and selected-admission checks remain mandatory. Five native-policy
and sixteen approval/handoff regressions pass. A follow-up child-native approval
audit separates the aggregate policy run from the canonical child durable run
through the existing trace, delegation-step and admission binding; 38 focused
requester/static/mesh and handoff checks pass, including identity drift refusals.
The automated public restart regression also passes: a fresh authenticated Chat
pauses with zero MCP invocations, its real HTTP client disconnects, the app closes
and reopens the same disposable SQLite state, approval resumes the same Chat run,
and exactly one actual tool result is retained. A duplicate approval does not
invoke the tool again. Two earlier fixture attempts hung on buffered request
injection's SSE cancellation behavior; switching to an actual owned loopback
socket corrected the fixture. Those failures are not counted as passing proof.
The first combined named MCP receipt is retained at
`artifacts/verification/2026-10-12T01-34-38-815Z-mcp-requester-scope-9312b603`:
14 checks pass, four fail and live PostgreSQL is explicitly skipped. Failures are
a real-child stderr fixture timeout, an obsolete dispatch-function identity
assertion, historical mesh/answer-recovery regressions, and the runtime-truth
browser cross-check. Auth matrix, conformance, network guards, storage bindings,
static scans, attribution, typechecks, formatting and whitespace pass.
The nested runtime-truth receipt is
`artifacts/verification/2026-10-12T01-47-31-615Z-runtime-truth-2c53674a`:
profile-free approval, approval/restart and deep-research tool exposure pass;
the served shell's recovered-run check times out. The full MCP lane remains
unaccepted while these failures are repaired and revalidated.
The fixed stderr fixture passes at its unchanged 20-second cap, verifying the
intended child exit and bounded diagnostics; no fixture child remains. The
constructor dispatch and historical mesh cases pass two focused tests, preserving
correct owner routing and refusal of copied/missing handles. Worker, provisioner,
skills and memory-core typechecks pass under the repository output lock.
The recovered-evidence caller now retains useful deterministic partial content
after failed model repair, while keeping failed/interrupted, unrepaired and
unrecovered status. It makes no additional provider call and does not relax the
original deadline. Both complete owner suites pass 134 tests. The standalone
runtime-truth rerun passes all four scenarios at
`artifacts/verification/2026-10-12T02-03-51-081Z-runtime-truth-43ef99b9`, including
the exact recovered-run identity/reply in default Cockpit and the Classic approval
panel. No UI assertion, readiness deadline or production UI behavior changed;
the previous timeout has no proven root cause. The lane now retains its exact
failure stage, bounded structural state and browser artifacts on failure.

A final setup audit found that validated extension form metadata was not reaching
the operator editor. The current source projects optional labels, help and setup
guidance through the existing integration form and canonical channel wizard.
Metadata cannot add writable fields, change requiredness, override saved values,
grant permissions or reveal secret values. Older manifests remain valid.
The MCP inspector now has a bounded read-only Tested projection over existing
approved Chat/tool/effect receipts. It requires current operator access, exact
actor/workspace and admission joins, and matching server, connection and cached
tool-schema revisions; changed bindings are stale. Pruned evidence, exhausted
search bounds and unavailable owners remain explicit. It does not claim a live
schema probe or complete history search. Thirty-four owner/route tests, fifteen
UI tests and one shared API test pass. The final public restart regression also
passes (one integration test, 141.89 seconds total): evidence is unverified before
approval, verified after canonical completion, absent in another workspace, and
stale after a reviewed configuration revision. Invalid authentication is rejected;
this case does not simulate revoking a previously valid token. Fresh browser proof
for these final setup changes remains pending. The first guided-channel run
(`2026-10-12T02-07-55-068Z-channel-guided-setup-35e849ca`) found that the
guidance was mounted only in the Classic editor. The canonical Cockpit
`ChannelDraftEditor` now mounts the same presentation-only component, with a
passing regression covering both editors. The next run
(`2026-10-12T02-18-45-763Z-channel-guided-setup-808b78e1`) displayed the guidance
on desktop and mobile and captured all 14 adapters, but failed its later
reload-mutation count. Retained network evidence attributes the two additional
requests to `PUT /api/v1/notifications/presence`, not channel writes or sends.
That verification counter is being narrowed to distinguish presence signals;
the failed receipt is retained. A third run
(`2026-10-12T02-25-02-852Z-channel-guided-setup-95386cdf`) passed those boundaries
but failed a later Inbox locator that assumed the asynchronous projection title
was already populated. The lane now locates the canonical Current approval
region while retaining exact approval-ID, workspace, response and item joins.
The final named run
(`2026-10-12T02-31-06-084Z-channel-guided-setup-5b274f16`) passes its complete
scenario with zero skips: all 14 desktop/narrow adapter captures, keyboard and
guidance checks, saved-test reload without resend, exact plan and approval
handoff, and disabled loopback ntfy activation. Two explicit reviewed tests sent
two loopback messages; resuming the saved test did not issue another test POST.
Nine presence signals are recorded separately. The Code Mode named lane
(`2026-10-12T02-33-36-846Z-code-mode-sandbox-c5afb9c9`) also passes, with ten
Windows metadata/prerequisite checks and zero failures. Its receipt explicitly
retains `enforcementVerified: false` and `publicClaimAllowed: false`; this is not
hostile-code containment certification. Final current/stale MCP browser proof
remains pending.
The public browser fixture also exposed an unrelated-Chat admission failure when
saved MCP was enabled without an authenticated actor. The Gateway now checks
metadata-only explicit server selection first. Ordinary Chat does not resolve
MCP credentials or scope; selected tools require supported authenticated operator
identity and otherwise return a concrete setup error. Six composition regressions
pass, including lost ownership before selection and before discovery dispatch,
approval eligibility, and a policy denial with safe reason-code diagnostics.
The concurrent static-owner run passed 20 of 21 cases; its existing stdio fixture
timed out during process startup. A single-worker rerun passed that exact case
and the metadata-only admission regression (two passed, 19 unrelated filtered).
The named MCP lane remains the combined-suite acceptance gate.

Named-lane progress: extension packaging and skill learning pass. The initial
agentic `chatFanout` run (tool session 3197) passed
all 11 checks, including 143 Gateway tests and 15 storage tests. Public direct and approval/resume cases
prove same-parent synthesis after two unique children; the local worker runs
those children serially. A subsequent audit identified a terminal-aggregate/
lost-parent-wake crash cut. Recovery now uses a bounded query over the existing
fanout aggregate and waiting durable parents. It rechecks exact wait linkage,
canonical child settlement, active admission and current session-control
generation before waking the existing parent owner. Forty-two focused Gateway
tests and three storage tests pass, including a lost wake, cancelled or completed
admission, controller changes before and during recovery, and cursor fairness.
Historical frozen-profile replay remains separate and unchanged. A subsequent
named run passed all 154 Gateway tests but timed out launching the storage group;
the isolated storage rerun passed 16 tests. A subsequent retained failed report
at `output/feature-quality/chat-fanout-proof-child-wait-20261012T000434Z.json`
passes storage (16) but fails two public child-dispatch waits. These failed
receipts remain failures. Bounded canonical run and dispatcher diagnostics were
added without retaining prompt content. Both public tests then passed in
isolation with unchanged deadlines (tool session 94687, 63.61 seconds total).
The combined Gateway group now uses one test worker while preserving its full
file list, assertions and 420-second command ceiling. The final report at
`output/feature-quality/chat-fanout-proof.json` passes all 11 checks: Gateway
154/154 and storage 16/16. The storage summary is retained verbatim as `tests 16`,
`pass 16`, `fail 0`; the report's old generic parser recorded zero for Node's
Unicode summary format. That parser limitation is recorded separately rather
than rewriting the generated receipt. Gateway and storage commands completed in
209.589 and 108.975 seconds respectively.
The shared parser now recognizes complete Node TAP/spec summaries while preserving
Vitest aggregation. Its eight focused tests pass; re-reading the unchanged report
returns 16 storage passes. The retained report was not rewritten.
The successful
skill-learning artifact is
`artifacts/verification/2026-10-11T23-00-11-273Z-skill-learning-1ec64d25`:
all 86 Gateway tests, including the three authentication variants above, contract,
storage and schema checks, two targeted Code Mode lineage tests (109 unrelated
tests filtered), and final contracts/storage/Gateway typechecks passed. The first
failed skill-learning receipt is retained; its context-composition type error was
fixed before this full rerun. The live PostgreSQL row is explicitly conditional
and skipped here; the separate executed database proof is recorded above.

The expanded Skill Hub lifecycle lane has two retained failed receipts:
`artifacts/verification/2026-10-11T23-43-04-714Z-skill-hub-lifecycle-75c35ff3`
and `artifacts/verification/2026-10-11T23-51-05-343Z-skill-hub-lifecycle-02a5d3c0`.
Contracts, storage and their typechecks pass; lifecycle fixture setup and real
I/O exceeded test timeouts. The first failing case passed in isolation with the
same timeout. Later missing Vitest SSR files are consistent with worker teardown
after the timeout; no shared-directory deletion was found. Fixture ownership and
the existing schema-template accelerator are being applied before another full
run. These observations do not convert either failed lane into a pass.
The full rerun now passes at
`artifacts/verification/2026-10-12T00-30-17-078Z-skill-hub-lifecycle-dfb0f95e`:
contracts (5), fresh storage and template parity (52), Gateway (96), shared
client (2), operator UI (6), and all contracts/storage/shared/UI/Gateway
typechecks. Its live PostgreSQL row is explicitly skipped without a configured
test URL; the separate executed fresh/upgrade database proof remains applicable.

The first complete agentic-governance lane is retained at
`artifacts/verification/2026-10-12T00-01-40-356Z-agentic-governance-a7cbdda2`.
Marketplace and actual activation-grant runtime scenarios pass. The governance
and self-improvement profiles fail on four bounded commands: permission storage,
the permission/coordinator group, Code Mode and the improvement ledger. The
retained tails do not establish a product assertion failure. Expensive repeated
schema setup is being reduced through the existing isolated template owner
before rerunning the same assertions. Timed-out command descendants were checked
and had exited; no unrelated process was stopped.
The final rerun passes at
`artifacts/verification/2026-10-12T01-29-01-122Z-agentic-governance-c825a394`:
four scenarios pass in 4 minutes 59 seconds. Review-first passes all 11 checks,
including permission storage (11 tests), coordinator (175), delegation (65) and
Code Mode (111). Marketplace passes its check; self-improvement passes all three
checks (8, 51 and 18 tests). Actual grant activation, revocation and deny-wins
runtime behavior passes. The earlier command limits remain unchanged.

The first routed-context lane retained at
`artifacts/verification/2026-10-11T22-55-49-232Z-routed-context-snapshots-e68a0cd9`
passed storage (10), admission/public Chat (110), Gateway (417, 13 historical
skips), scoped-inspection hook (14), operator panel (9), and the targeted
composition check (1, 14 unrelated skips). Its final typecheck failed on the new
MCP composition helper's untyped provider definition. The helper now uses the
owner's typed model alias; Gateway typecheck and the 23 focused composition,
restoration-default and availability tests pass. This does not relabel the
failed full lane. The final named rerun passes at
`artifacts/verification/2026-10-12T00-48-21-262Z-routed-context-snapshots-35d8e6d8`:
eight scenarios pass, zero fail, and the conditional PostgreSQL scenario skips.
Storage, public admission/restoration, Gateway context, composition, operator
surfaces and final typechecks pass in 4 minutes 30 seconds. The conditional PostgreSQL
row was skipped without a test URL; the separate disposable fresh/upgrade
PostgreSQL proof above remains the executed database evidence.

Settings PATCH/public-owner checks pass 78 tests with one conditional PostgreSQL
skip. The updated documentation checks pass, and the async-boundary scanner
passes its 16 regressions plus 1,180 production Gateway TypeScript files on the
final source pass, including the new setup guidance and MCP evidence readers.

### Rollout and compatibility

The first expanded durable-recovery receipt is retained at
`artifacts/verification/2026-10-12T00-53-16-130Z-durable-recovery-6fb89fb2`.
The real stack restart/DLQ, 93 approval-wake tests and orchestration parking
scenarios pass. The worker group passes 286/287 tests; its 501-row recovery
fixture times out at 15 seconds. Only seed writes are now batched in one
transaction and the heavy worker group runs serially. The row count, actual
recovery, assertions and deadlines are unchanged. A subsequent retry
`2026-10-12T01-01-36-351Z-durable-recovery-d23c478e` stopped before scenarios on
Gateway loopback `EACCES`; no product assertion ran. The fresh-port retry
`2026-10-12T01-03-14-126Z-durable-recovery-4abf7df5` passes that 501-row case but
fails one native process-identity assertion and one 15-second watcher fixture.
Production already reports absent identity as unavailable. Capture now reads
the built-in process start time without dynamic C# compilation, retaining the
original child-liveness guards and 10-second bound; cleanup still compares and
terminates the same native handle. Cold compilation is a suspected cause, not a
proven diagnosis. The three Vitest groups now use the existing schema-only
template fixture; the actual restart stack and fresh migration proof do not.
Worker and parking groups are serial. No assertions or deadlines were relaxed;
the focused native identity/recovery proof passes nine tests, including capture,
same-handle termination, SQLite reopen and lost-ACK recovery. Its log is retained
at `output/feature-quality/native-capture-followup.log`. The full named rerun
passes at `artifacts/verification/2026-10-12T01-17-40-043Z-durable-recovery-85357850`:
all four scenarios pass in 10 minutes 50 seconds, including the actual
restart/DLQ exercise, 287 worker tests, 93 approval-wake tests and 175 orchestration
tests. Four existing orchestration skips remain explicit.

Restoration flags are independent and default off:
`chatSkillInstructionsV1Enabled`, `boundedToolExposureV1Enabled`,
`chatProviderFallbackV1Enabled`,
`chatDelegationControlsV1Enabled`, `chatAutomaticFanoutV1Enabled`,
`scheduledChatTurnsV1Enabled`, `proactiveHeartbeatTurnsV1Enabled`,
`commitmentScheduledTurnsV1Enabled`, `chatRequesterMcpV1Enabled`, `chatStaticMcpV1Enabled`,
`chatMeshCapabilitiesV1Enabled`, and `chatRemotePlacementV1Enabled`. `chatExplicitContextV1Enabled`
defaults on, so sources selected in the Chat composer reach the model; an explicit false still turns it off. WS9's `chatWorkPassportV1Enabled`
defaults on after its CI lanes passed (a passport recorded in feature references; a passport-only admission
pins the route only when one resolves), `chatModelCouncilV1Enabled` (an operator council request
recorded in feature references; tool-free members rechecked against readiness and the Citadel Ward at
resolution; no explicit context or delegated children) and `chatWorkspaceSnapshotV1Enabled` (one content-free
snapshot recorded in feature references for an operator turn; a snapshot-only admission pins the route only
when one resolves). Automatic fanout also requires the existing
durable fanout switch, explicit session policy and a current exact-project grant.
Read-only `chatFeatureAvailability` derives UI availability from actual settings;
it does not confer permission or report successful execution.

New feature admissions pin provider routing without freezing a callable catalog.
Current skills, grants, requester generations, mesh publications and policy remain
live authority checks. Changed admitted content fails closed instead of silently
substituting bytes. Historical profile decoding remains available. Fresh explicit
context restoration covers ordinary operator turns and edit/retry turns that carry refs.
WS9 adds `chatExplicitContextBranchesV1Enabled` (default on after its CI lanes passed; effective only with
`chatExplicitContextV1Enabled`): edit/retry without refs re-admits the
source turn's ids, and delegated children inherit the parent's ids, always as a fresh admission
(child path not yet proven by an end-to-end delegated run). Code Mode retains trusted-code
terminology, immutable artifacts and its existing approval/execution owners.

### Live evaluation preflight

[Secret-free preflight](FEATURE_QUALITY_LIVE_PREFLIGHT.json) records the actual
local configuration examined on 2026-10-11. The configured hosted route uses an
API style not handled by the current comparison transport; the compatible-key
route has no process credential available. The configured llama.cpp endpoint was
not listening and Ollama reported no installed models. No model or provider was
substituted, no credential was exported, and no model request was made.

Both 45-trial targets therefore remain incomplete. Actual model revisions,
quantization, effective context limits, matched baseline outcomes and candidate
outcomes must be pinned when those lanes become runnable. Controlled local stub
responses are never entered as local-model comparative trials.

The executable [additional acceptance suite](FEATURE_QUALITY_COMPARISON_ACCEPTANCE.md)
adds 36 separately reported cells per track for open-web research, scheduled
tool use, fallback and delegated recovery. It shares the pilot ceilings with the
unchanged original 45-cell matrix. An earlier completion audit found that only the Goat
public-API adapter and controlled conformance existed: the additional
OpenClaw/Hermes adapters and shared live supervisor were missing source work,
not merely operator configuration. Native web/recovery adapters, normal launch
configuration, public recovery-evidence readers and the shipped supervisor now
pass controlled conformance through the existing C6 owners. Native reconciliation
and Chat-visible route metrics remain unavailable where public receipts omit them;
exact unsupported scheduling/delegation predicates remain labeled per product. No live trial may
run until compatible model, clean product candidate and permission preflight passes.

## Promotion rules

Every restored feature requires its deterministic authority/recovery gates and
applicable hosted/local workflow checks before promotion. Missing model settings
block only that live track. Do not substitute providers or turn absent metrics
into successes. New default-off switches preserve upgrade behavior. Tool-effect
receipts distinguish retry guarantees from observed effects: timeout after send
requires reconciliation when the outcome is unknown.

Remaining work follows phases 0-6 in the ledger. Remote C5 acceptance, installer
publication and release deployment are separate; this task does not install,
publish, mutate production data or deploy a release.
