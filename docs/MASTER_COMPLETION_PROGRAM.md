# GoatCitadel Master Completion Program

Last updated: 2026-08-11

Status: canonical aggregate execution ledger

## Purpose and authority

This document is the single execution plan for unfinished GoatCitadel work and
intentional deferred backlog. It replaces cross-document ordering from older
parity plans, review snapshots, and feature-specific backlogs. Those documents
remain useful as owner contracts and historical evidence, but they do not create
work independently of this program.

When sources disagree, use this order:

1. current implementation under `apps/`, `packages/`, and `scripts/`;
2. `CANONICAL_RUNTIME_STATE_MODEL.md` and `1_0_CONTRACT.md`;
3. the current owner contract linked from the relevant tranche below;
4. this aggregate program;
5. dated reviews, packets, checklists, and older plans.

Before starting a tranche, reconcile its rows against the then-current `main`.
An unchecked historical box is not proof that work remains, and a shipped
foundation is not proof that an integrated journey is complete.

## Status vocabulary

| Status | Meaning |
|---|---|
| `complete` | The tranche's implementation and named acceptance proof are complete. |
| `in_progress` | Work has started, but at least one required acceptance row is still open. |
| `planned` | Current, evidence-backed work that has not started in this program. |
| `blocked_external` | Completion requires a real device, credential, second machine, or administrator-owned control that local code cannot supply. |
| `deferred_decision` | Intentional backlog that must not enter the critical path without an explicit product or architecture decision. |
| `superseded` | An older proposal or status row has been replaced by current implementation or product direction. |

## Verification strategy

The tranche order is designed to avoid rerunning broad proof after every small
change:

1. Run focused owner tests, the touched package typecheck, and
   `git diff --check` inside each implementation slice.
2. Run a named subsystem lane once when its tranche closes, not after every
   commit in that tranche.
3. Run browser, accessibility, and visual proof once after the consolidated UI
   tranche, unless an earlier change requires an immediate safety check.
4. Run installer, desktop, remote-hardened, and release-certificate proof only
   against the exact release candidate.
5. Run `pnpm verify:all` once in the final exact-SHA campaign after all earlier
   tranche gates are green.
6. Do not replace real PostgreSQL, browser, packaged-process, physical-device,
   or two-machine acceptance with mocked or source-only proof where the owner
   contract requires the real boundary.

## Program ledger

| ID | Priority | Tranche | Status | Depends on | Closing proof |
|---|---|---|---|---|---|
| `M0` | P0 | Canonical ledger and stale-status reconciliation | `complete` | None | `pnpm docs:check`; `git diff --check` |
| `M1` | P0/P1 | Proof integrity, storage correctness, and agentic hot-path foundations | `complete` | M0 | Focused storage/Gateway/harness tests, dual-dialect corrupt-shape proof, concurrent-verifier proof |
| `M2` | P0 | Remote-worker admission, transport, and operator control | `in_progress` | M1 | Focused mesh/auth suites and real two-machine TLS 1.3/mTLS/PoP admission |
| `M3` | P0 | Remote-worker durable execution and ordered event transport | `in_progress` | M2 | Worker death/reconnect/takeover, replay, transcript, approval-resume, and no-duplicate proof |
| `M4` | P0/P1 | Live worker inference, execution cell, settlement, and visibility | `in_progress` | M3 | `pnpm verify:remote-workers` with the connected-worker row executed, plus live Ops/Chat data |
| `M5` | P0 | Governed self-configuration and repair expansion | `in_progress` | M1; M2 for remote custody | `pnpm verify:self-configuration` with live provider, packaged restart, browser secure input, profile, rollback, and delegated-resume evidence |
| `M6` | P1/P2 | Gateway capability and policy follow-ons | `complete` | M1; M5 where repair is involved | Focused capability/policy/provider tests and explicit owner decisions |
| `M7` | P1/P2 | Consolidated Mission Control UX and live-worker projection | `in_progress` | M4; stable M5/M6 APIs | Focused component tests, populated stories, accessibility, surface, and one visual-regression pass |
| `M8` | P1 | Mobile companion completion and pinned-Gateway proof | `in_progress` | M3-M5 contract stability | External mobile build/tests and HX-508 device-auth, paging, approval, offline/reconnect, attachment, and revocation bundle |
| `M9` | P0 | Packaging, desktop, remote-hardened, rollback, and recovery | `planned` | M2-M8 release-bearing scope | `pnpm verify:install`, `pnpm verify:desktop`, packaged lifecycle, exact hashes/versions, hardened recovery bundle |
| `M10` | P0 | Final exact-SHA certification | `planned` | M1-M9 | All required named lanes, then `pnpm verify:all`, authenticated queues, and release evidence |

## M0 - Canonical ledger and stale-status reconciliation

### Scope

- Establish this file as the only cross-workstream execution order.
- Keep detailed owner contracts, but make them link here instead of publishing
  competing implementation sequences.
- Mark completed or superseded rows truthfully, including original parity
  epics, Google Meet, agent-fanout budget weighting, capability lifecycle APIs,
  and mobile voice capture.
- Correct remote-worker proof wording: the named composition lane and live
  PostgreSQL row exist, while two-machine admission and connected-worker E2E
  remain held.
- Preserve dated review and QA artifacts as historical evidence rather than
  rewriting them into current status.

### Exit criteria

- Every active or deferred item below has one master tranche.
- Owner documents link back to this program.
- No completed historical row appears in an active execution order.
- Documentation validation and whitespace checks pass.

Closure evidence (2026-08-08): `pnpm docs:check` passed, including governance
validation and 9/9 Docker-secret documentation tests; `git diff --check` passed.

## M1 - Proof integrity, storage correctness, and agentic foundations

### Implementation progress

- Worktree-scoped cross-process output locks and staged publication now protect
  the shared verifier/build outputs (`FR-362`).
- SQLite and PostgreSQL migrators now reject corrupt pre-existing object shapes
  instead of accepting name existence as shape proof (`FR-356`). Fresh
  PostgreSQL 16 proof covers the corrupt-table and corrupt-index cases; the
  schema inspector uses PostgreSQL's canonical `pg_catalog.bool` type name.
- Concurrent audit events are durably microbatched under the existing ordered
  lock, ordinary prompt-budget receipts are gated off the live path, and scoped
  active-grant reads resolve concurrently before the unchanged deny-wins merge.
- Capability-profile policy probes now use bounded, order-preserving fan-out and
  a non-materializing inspection path. The durable profile freezes the probe
  evidence, while canonical invocation still re-evaluates, records the
  limit-counting decision, and enforces deny-wins policy before execution.
- Pre-dispatch terminal outcomes use one canonical tool-row write, and advisory
  runtime-decision projections drain through a bounded, shutdown-owned queue
  after canonical settlement instead of extending response latency.
- Checkpoint continuation now follows bounded high-intent Chat classifications,
  and the first eligible successful root Chat turn warms the operator review
  inbox without promoting learned memory or adding a foreground model call.
- The final governed-remediation storage checkpoint is paired at SQLite 192 and
  PostgreSQL 135 with migration-lineage and schema-parity coverage.
- PostgreSQL 140 now installs one normalized final schema authority instead of
  treating a raw migration-text manifest as catalog truth. Destructive
  governed-remediation, remote-mesh, and mobile-push bootstrap bridges acquire
  replacement locks before reclassification, reject unmodeled owned objects
  and physical/catalog drift, preserve nonempty authority, and converge fresh
  and historical lineages to the same exact head. Live PostgreSQL 16 proof
  covers corrupt-object preservation, the writer-versus-replacement race, and
  the v140 finite-lineage repair; paired migration parity remains SQLite 196 /
  PostgreSQL 140.

### Closure evidence

- `FR-362`: concurrent verifier/build lanes cover cross-process exclusion,
  stale-owner recovery, staged publication, and worktree isolation.
- `FR-356`: focused SQLite/PostgreSQL shape regressions pass; a disposable real
  PostgreSQL 16 server passed the exact corrupt-table and corrupt-index cases,
  and the full PostgreSQL migrator suite passed 51/51.
- Focused policy/Gateway regressions cover non-materializing inspection,
  bounded eight-way probe fan-out with stable evidence order, canonical
  invocation recording, one-write terminal preflight, and bounded advisory
  decision draining.
- Audit microbatching, prompt-receipt gating, scoped-grant fan-in, high-intent
  checkpoint continuation, and first-turn operator-review warming retain their
  focused regressions.
- The paired SQLite 192/PostgreSQL 135 migration parity and integrity checks,
  touched package typechecks, documentation validation, and whitespace checks
  pass at closeout.

### Superseded proposals

- Do not move short Chat turns outside durable execution. Optimize admission,
  heartbeat, and checkpoint cost while keeping durable execution authoritative.
- `agent.fanout` budget weighting is complete: fanout consumes bounded subtask
  count rather than one flat tool run.

### Owner evidence and proof

- `review/full-code-review-2026-07-09.md` (`FR-356`, `FR-362`)
- `citadel_update/AGENTIC_FAST_LANE_PLAN.md`
- Focused storage/Gateway/harness tests, corrupt-shape regressions in both
  dialects including live PostgreSQL 16, concurrent-lane regressions, touched
  package typechecks, `pnpm docs:check`, and `git diff --check`.

## M2 - Remote-worker admission, transport, and operator control

### Implementation progress

- The hardened Windows provisioner, authenticated local service transport,
  Ed25519 custody, protected filesystem/journal recovery, deterministic x64 and
  ARM64 packaging are restored on the current program branch. The protected
  service can now sign a fixed, secret-free 288-byte admission-evidence
  envelope without exporting its private key; x64 execution, ASan, and paired
  deterministic x64/ARM64 builds pass.
- Proof-of-possession verification can now prepare a verified request without
  burning its replay nonce; durable nonce consumption and generation-1
  credential admission commit atomically, including rollback at injected
  post-nonce and post-generation failures.
- The native TLS listener now has a bounded authenticated-handler seam with
  strict POST/JSON framing, one request per connection, body/handler deadlines,
  bounded sanitized responses, buffer wiping, and explicit
  `listening_dark`/`listening_live` runtime truth.
- Operator bootstrap/control routes and the admission exchange are composed
  over the canonical repositories. Real two-connection replay uses distinct
  TLS exporters/nonces and returns the same canonical generation without
  replaying the credential secret.
- The fixed protected envelope and operator-pinned signer are now verified by
  the Gateway, settled atomically with nonce/generation/credential authority,
  retained across restart in paired SQLite 193/PostgreSQL 136 storage, and
  cryptographically revalidated on current-authority reads. Quarantine or
  revoke kills credential and protected-evidence authority.
- Production ingress has a real protected-evidence verifier and can become
  `listening_live` only after its preflight succeeds. The current-authority
  resolver is consumed only by the production-dark M3 assignment-protocol
  owner; the runtime factory still omits that handler, and raw evidence rows
  are never callable authority.
- The protected Windows service now has a production-dark PoP-v2 signing
  operation over the exact contract-owned 285-byte preimage. Its local
  operation authority binds the authenticated caller SID, caller-pinned state,
  active generation, keyset receipt, and exact preimage before state or key
  access. Delete-on-close staging survives the injected crash boundary, and
  deterministic x64/ARM64 builds plus x64 execution/ASan proof pass. The
  untrusted helper performs one sign exchange and has query-only SCM rights; it
  cannot start or restart the service.
- A distinct production-dark, one-shot Windows availability-broker service now
  owns the only new `StartServiceW` import. Its SCM entry accepts no operands;
  before one bounded start of the fixed signer it validates the exact demand-
  start service configuration, protected service-object ACL, stopped/pending
  state, fixed protected image path, file identity, single link, ADS closure,
  file ACL, and package-pinned SHA-256. A running result is accepted only after
  exact PID, image, LocalSystem token, service SID, privilege, status, and held-
  image revalidation. It cannot create, reconfigure, control, delete, or query
  an arbitrary service and persists no secret.
- The deterministic package proof now publishes an exact service/client/broker
  trio for x64 and ARM64, preserves partial publication as a HOLD, and passes
  the x64 ASan/native suite. The existing untrusted client/helper remains
  unchanged and query-only. The broker has no installed service or caller
  composition yet; this is PE authority isolation, not containment against a
  malicious local administrator who already has direct signer start/stop rights.
- An exact-commit Codex Security review closed all 29 changed source files and
  nine trust surfaces with zero findings or deferred rows. Root integration
  proof passes focused Gateway, contracts, provisioner, atomic-storage, paired
  migration-parity, and touched-package typecheck lanes.
- A separate exact-commit trust-chain review closed the PoP-v2 signer with no
  blocker or residual integration issue. Its ten route descriptors remain
  production-dark, and activation still requires an administrator-owned
  installed-service lifecycle plus real two-machine proof.

### Current work

- The distinct shipped coordinator principal and administrator-owned installer
  recipe for the broker service are now frozen as executable, testable
  artifacts. `scripts/remote-worker/install-broker-coordinator.ps1` plus its
  paired uninstall/rollback script materialize the coordinator virtual service
  account `NT SERVICE\GoatCitadelRemoteWorkerProvisionerAvailability` through
  the unrestricted service SID, install the exact demand-start broker/signer
  pair the broker validates, and pin the executable/directory ACLs, required
  privilege list, protected two-ACE broker SCM DACL, and package-verified
  image SHA-256s, with a read-only preflight, fail-closed refusal branches,
  mid-run rollback, and machine-readable evidence bundles. A repo-hygiene
  contract test pins the security-critical recipe text against the broker
  sources and proves nothing wires the untrusted helper to start anything;
  the scripts parse and compose under Windows PowerShell 5.1 and PowerShell
  7, and the refusal branches are proven without Service Control Manager
  writes. Nothing is installed or started by this tranche; the broker and
  one-exchange signer stay production-dark until the installed owner is
  composed and pinned on a real administrator host.
- Prove the installed stopped/start-pending/running broker contract, signer
  restart, exact caller rejection, drift rejection, ARM64 execution, and clean
  uninstall/rollback on a real Windows host, including the first-boot
  `ERROR_SERVICE_NEVER_STARTED` status posture that the broker's exact
  `NO_ERROR` status-metadata validation must be proven against.
- Keep current-authority reads and every downstream mutation transactionally
  fenced through M3 node admission and assignment ownership.
- Prove operator-visible diagnostics and the real closed-ingress, N+1 rotation,
  quarantine, revoke, and restart journeys.
- Execute the real two-machine TLS 1.3/mTLS/exporter-bound PoP row.

### Acceptance

- A real second machine completes join, rotation, quarantine, revoke, and N+1
  admission without exposing bootstrap or provider secrets.
- Durable nonce replay remains fenced across restart and concurrent connection.
- Live PostgreSQL, auth, audit, rate-limit, and workspace-isolation proof pass.

Owner contract: `OPENCLAW_HERMES_PARITY_PROGRAM.md`, `HX-501`.

## M3 - Remote-worker durable execution and ordered transport

### Current work

- A production-dark task-bound durable-Chat offer/claim/workload owner now
  derives eligibility from the canonical durable payload and current session,
  M2 credential, M3 mesh admission, workspace, capability-profile, and parent
  run authorities. The worker supplies its lease secret, Gateway hashes it
  before the atomic claim, and response-loss replay returns secret-free
  canonical state.
- Route codes 8 through 10 now have a production-dark protected dispatch wire
  for offer polling, atomic claim, and immutable workload read. It requires the
  exact protected PoP-v2 descriptor, verifies current M2 credential/mTLS
  authority before proof, consumes the durable credential nonce before any
  assignment business read, and delegates the final M2/M3/task/durable fence
  to the storage transaction. The worker-proposed 32-byte lease secret is
  hashed at the Gateway boundary and cannot be echoed in the response. No
  native mux, runtime factory, startup composition, or worker poller is
  registered.
- The production-dark assignment RPC for synchronization, lease renewal,
  ordered event append, cancellation reads, and settlement now requires the
  contract-owned protected PoP-v2 proof. It binds the canonical M2 current
  credential/protected-evidence owner, worker generation, exact assignment
  workspace, and current mesh-admission generation before all five outcomes.
  The native mux and runtime factory remain intentionally uncomposed.
- Every protected route 2 through 6 now carries the exact M2 credential,
  protected-evidence, and M3 mesh-authority fence into its assignment owner.
  Storage rechecks that complete fence inside the same transaction after the
  canonical locks and before replay, read, or mutation. Focused regressions
  prove credential rotation, protected-context drift, and mesh join-authority
  revoke reject stale reads and writes. The live PostgreSQL contention proof
  now serializes credential rotation, protected-context drift, join-authority
  revoke, and duplicate replay against in-flight fenced routes on real
  concurrent connections: the stale side is rejected deterministically inside
  the storage transaction and the winning side commits exactly once.
  Composition remains gated on the authenticated worker runtime below.
- Compose the existing dispatch poll/claim/workload-read wire only after an
  authenticated worker runtime can retain its credential and lease secret,
  obtain the exact protected signing pin, and reconnect without replaying a
  one-time secret.
- Connect scheduler dispatch to generation-fenced assignments and the live
  worker protocol.
- Execute provider/tool work through Gateway-owned policy and secrets.
- Carry ordered transcript/events through a retained outbox with explicit
  acknowledgement, bounded backpressure, reconnect catch-up, and exactly-once
  materialization.
- Prove worker death, disconnect, lease takeover, cancellation, stale callback
  fencing, restart recovery, and approval-gated resume.

Owner contracts: `OPENCLAW_HERMES_PARITY_PROGRAM.md`, `HX-502` and `HX-504`.

## M4 - Live worker adapters, settlement, and visibility

### Implementation progress

- The production-dark HX-503 inference owner is hardened through paired SQLite
  196/PostgreSQL 139 authority. It hashes the raw lease at the sole boundary,
  sends only a lease-free normalized command to downstream owners, and binds
  the exact current worker/assignment/run/task/profile/context, route, budget
  owner, operation, and token ceilings.
- Denied and waiting requests reserve no budget. Dispatchable requests require
  durable budget authority; release records a stable blocked intent before the
  external effect, and response-loss, expiry, concurrent claim, terminal
  settlement, and restart recovery are exact-idempotent. Canonical HX-306 usage
  IDs are retained without fabricating accounting evidence.
- Integrated proof passes 22 contract tests, 53 Gateway tests, 24 selected
  storage tests with two live-PostgreSQL rows visibly skipped, all three package
  typechecks, and the full 196/139 migration-parity, integrity, and runtime
  schema lane. No listener, scheduler, live atomic budget adapter, or fallback
  ceiling is composed.

### Current work

- Connect the shipped HX-503 inference owner to live RPC and the canonical
  atomic budget/accounting adapter.
- Connect the shipped HX-505 cell owner to the real container, backup, and
  native-filesystem boundaries.
- Connect HX-506 artifact, verification, and external-effect settlement to the
  live worker without introducing a second accounting authority.
- Populate the production-dark HX-507 Ops and one-Chat projections from live
  worker records, then promote route visibility only after their upstream gates
  pass.

### Acceptance

`pnpm verify:remote-workers` already proves the Gateway-side composition and
live PostgreSQL owners. M4 closes only when its connected-worker E2E row runs
instead of reporting the documented conditional skip and the UI renders live,
truth-labeled data.

Owner contracts: `OPENCLAW_HERMES_PARITY_PROGRAM.md`, `HX-503` through `HX-507`.

## M5 - Governed self-configuration and repair expansion

### Implementation progress

- The generic durable coordinator binds requester, parent reservation,
  normalized recipe digest, purpose-specific approvals, phase leases, owner
  revisions, and receipt lineage in paired SQLite/PostgreSQL storage. Broad
  declarative-config repair remains explicitly manual because the canonical
  config owner cannot prove restart-safe rollback after an arbitrary config
  commit.
- The two dependencies that kept the fixed `config/budgets.json`
  compatibility mirror manual now exist. A native handle-relative
  capture/publish/restore port (Windows, following the repo's fixed
  System32 PowerShell + strictly-validated win32 wrapper precedent) walks
  each path segment relative to the previous directory handle under
  no-follow/no-reparse semantics, captures entry bytes plus volume/file
  identity through those handles, and publishes atomically with
  rename-by-handle against the pinned parent; live Windows tests prove it
  refuses a mid-flight junction/parent-identity swap instead of following
  it. The coordinator now also exposes a per-owner completion callback plus
  a durable settlement query so a finished recipe's pre-effect journal
  entries retire boundedly in process and across restarts.
- The budgets.json mirror is therefore the first callable recipe. It is
  approval-gated (`required_before_apply`), installation-scoped, limited to
  `local_dev`/`trusted_local` with `remote_hardened` failing closed, and it
  never auto-fires. The owner journals the handle-captured prior bytes
  before crossing the publish boundary and proves prior state, effect
  identity, restart reconciliation (journal replay on boot decides
  commit/rollback/no-effect from coordinator truth), and rollback to the
  exact captured bytes, with non-disclosure of every non-budgets config
  section. The coordinator itself is still not composed into the production
  Gateway, the handle port has no POSIX implementation (the recipe reports
  owner-unavailable and fails closed off Windows), and live provider,
  packaged-process restart, and browser secure-input rows stay held.
- OpenAI Codex OAuth has an exact installation-scoped, secret-free
  assessment and manual-required recipe boundary. It deliberately exposes no
  effect owner or live-probe claim: current keychain/OAuth APIs cannot prove
  CAS ownership, restart reconciliation, or rollback custody after token
  replacement or refresh.

### Current work

- Add provider bootstrap and OAuth repair only after an owner-specific live
  probe plus durable effect/reconcile/rollback custody exists; the current
  OpenAI Codex OAuth row remains manual rather than faking that authority.
- Compose schema/config, managed dependency, and owned-service recipes through
  existing owners with rollback.
- Add reason-specific rollback-failure reconciliation and high-signal Ops
  recovery.
- Add scoped remote credential custody only after M2 establishes the remote
  trust boundary.
- Prove exact-once delegated child-to-parent wake and continuation.
- Close packaged/source/Docker/shared-host profile coverage.

### Acceptance

The complete matrix in `GOVERNED_SELF_CONFIGURATION_AND_REPAIR.md` passes with
retained, secret-free live-provider, browser secure-input, packaged-process
restart, rollback, crash, replay, and durable-continuation evidence. Until then,
public claims remain “repair foundations,” not generic self-repair parity.

## M6 - Gateway capability and policy follow-ons

### Implementation progress

- Verified Code Mode source/wrapper and adapter artifact inspection plus
  cross-run evidence comparison were already live and are now removed from the
  active backlog.
- Workspace-scoped catalog metrics now distinguish intentional
  inspectable-only capability state from a broken callable-subset invariant,
  with stable catalog hashes and per-kind counts.
- Exact-snapshot audit exports now include the catalog plus explicitly requested,
  workspace-scoped Code Mode run hashes and durable artifact references. They do
  not export artifact contents or claim a fresh byte-integrity verification.
- Production-isolation evaluation and fail-closed hostile-sandbox claim metadata
  already cover the supported and candidate native/backend postures. General
  hostile-code promotion remains proof-gated and deferred, not an implementation
  claim.
- `route_local` remains an evaluated, durable audit signal. It will not gain an
  execution seam until a real local-placement authority can enforce it without
  bypassing Gateway policy, accounting, or the remote-worker scheduler.

### Closed design boundaries

- Automatic Code Mode continuation across uncertain effect boundaries remains
  unimplemented pending a separate durable replay/authority design.
- A bundled real embedding default and a trusted-local policy/audit fast path
  remain optional, footprint- and security-sensitive portfolio decisions.

### Deferred decisions owned here

- Candidate asset-store ownership, governed parallel read-only Code Mode
  fanout, and richer imported-skill provenance.
- Krea, FAL, Novita, and SimpleX adapters. These are portfolio choices, not
  release blockers.

Capability promotion, revoke, rollback, candidate detail, and lifecycle
filtering already exist and are not M6 implementation tasks. Verified Code Mode
source/wrapper artifact inspection and run comparison across catalog, source,
wrapper, policy, permission, override, and sandbox evidence are also complete
in the Gateway and Chat workbench. Google Meet has a Gateway-owned voice/session
integration and is not a missing adapter.

Owner backlogs: `CAPABILITY_SYSTEM_BACKLOG.md`,
`PROVIDER_CHANNEL_EXPANSION_BACKLOG.md`, and `citadel_update/STATUS.md`.

## M7 - Consolidated Mission Control UX

### Implementation progress

- `MCUX-103` is complete: Integrations, Channels, Permissions, Runtime, and
  Add-ons now participate in the shared route dirty-state registry. Editors
  with local selection also require an explicit discard confirmation and keep
  active drafts across background reloads.
- `MCUX-108` is complete: the unused shared split-layout components and their
  accidental app-owned React Reflex dependency were retired.
- The reverified July polish rows for Run Detail's no-selection state,
  progressive Skills loading, capability-route framing, provider capability
  chips, measured filter overflow, reminder date input, and saved-board cost
  coverage truth are complete.
- MCUX-106 fixture implementation is complete: Projects and Approvals now seed
  real selected records, route through exact fixture identifiers, and wait for
  populated master/detail selectors.
- The remaining July layout defects are complete: Activity uses compact ages
  and readable summary tracks, Schedules use wider grid tracks, mobile section
  indexes wrap, and command-palette overflow guidance is measured.
- Projects now has distinct overview and selected-detail routes; the legacy
  agent-catalog URL focuses its catalog owner; onboarding and Mason replace
  internal state captions with operator language; Curator uses readable time
  and aligned evidence columns.
- Chat now renders one canonical approval or user-input control card in the
  composer instead of repeating the same blocked state in a second warning
  strip. Header approval navigation and execution-plan status remain because
  they expose persisted queue access and plan truth rather than duplicate the
  decision controls.
- The shared accessible identifier chip now middle-ellipsizes visible values,
  preserves the full value for assistive technology and hover inspection, and
  copies the exact identifier. Approval, user-input, selected-turn trace,
  Council seat, Journey evidence, artifact lineage, and expanded trust-policy
  identifiers use it without turning ordinary descriptive text into copy UI.
- Focused Settings and primitive proof is green. Broad accessibility, surface,
  and visual proof remains intentionally grouped with the rest of M7.

### Current work

- Integrate live HX-507 worker visibility after M4 instead of testing seeded and
  live variants in separate broad campaigns.

### Acceptance

Run focused component tests while implementing, then populated visual stories,
accessibility smoke, surface regression, and one clean visual-regression pass.

Owner backlog: `review/mission-control-ui-ux-backlog.md` and dated frontend
review evidence.

## M8 - Mobile companion completion

### Current work

- The Gateway now has a production-dark, grant-bound push-registration and
  delivery owner in paired SQLite 195/PostgreSQL 138 storage. Raw Expo/FCM
  tokens remain only in deterministic OS-keychain custody; durable metadata,
  approval-refresh payloads, provider receipts, audit, replay, and diagnostics
  are secret-redacted. Registration/revoke, crash-gap suppression, outbox CAS,
  unknown-after-send quarantine, and custody-mismatch cleanup have focused
  proof. The production provider and scheduler remain explicitly unavailable,
  and the API reports that delivery posture instead of treating an enabled
  registration as live delivery.
- The credentialed Expo provider and outbox scheduler now exist
  production-dark. The Expo access token is config/secret-store shaped and
  ABSENT by default (`GOATCITADEL_MOBILE_PUSH_EXPO_ACCESS_TOKEN`, then the
  `mobile-push-expo` OS-keychain provider secret); with no credential the
  scheduler creates no timer and the posture stays
  `deliveryAvailability: "unavailable"` — both test-pinned. The adapter sends
  the pinned data-only/silent payload (no title/body/sound the OS could
  display before the companion app's JavaScript validates the hint),
  classifies tickets honestly (invalid token, rate-limit/5xx retry, auth
  failure unavailable, transport ambiguity unknown-after-send), and keeps raw
  FCM delivery `provider_unavailable` until its own credentialed adapter
  exists. An atomic revoke/send fence (registration row-lock plus delivery
  CAS in one immediate transaction) commits immediately before the provider
  boundary: a revocation or token rotation that committed after claim wins
  and no send happens, while a revocation racing an armed in-flight send
  leaves the running row to settle exactly once with an honest receipt —
  proven in SQLite and under live PostgreSQL for both commit orders.
- The Gateway-verifiable consumer approval-key owner now exists
  production-dark in paired SQLite 197/PostgreSQL 141 storage: one Ed25519
  device approval public key per durable companion grant, registration fenced
  on the active grant row, idempotent rotation/revoke with revision
  authority, cross-grant key reuse refused by a unique SPKI digest, and
  operator forensics retained after revoke. Signed-companion
  registration/rotation/disable, operator list/revoke, panic-off and
  device-grant-revoke projections, and versioned
  approval-decision-signature verification helpers
  (`goatcitadel.mobile-approval-decision.v1`) are in place and fail closed on
  missing/revoked keys, inactive grants, stale timestamps, and digest
  mismatches. Every registration response pins
  `verificationAvailability: "unavailable"`: the `approval_key` capability
  stays `scaffolded` until the mobile client ships its device-auth-gated
  signer under the physical-device hold.
- Full-body companion signatures still cover push tokens and rejected extra
  fields, while the retained replay/audit correlation hash uses a versioned,
  allowlisted secret-free tuple. Durable replay authority remains the
  session-scoped nonce rather than a token-derived fingerprint.
- The external mobile client now implements the Expo notification/device/task
  modules, signed token registration/rotation/revoke, a grant-and-session fence
  immediately before raw-token send, fail-closed tombstones across session or
  grant changes, refresh-only foreground/background handling, and typed opaque
  approval deep links. Final correction tip `6834a14cd` passes 49 Jest suites
  (193 passed, one skipped), lint/typecheck, Android Expo export, and npm-ci
  dry-run; a real clean install remains blocked by private-package registry
  authentication.
- Paired general companions can now read the secret-redacted pending approval
  queue and submit a request-signed rejection. Approval and edit remain
  operator-only because the current client-local biometric key is not bound to
  a Gateway-verifiable approval signature; the capability must remain
  `scaffolded` until that end-to-end key owner exists.
- Remaining M8 mobile scope: the mobile client's device-auth-gated approval
  signer against the new Gateway key owner (then the `approval_key`
  capability decision that retires `scaffolded`), live credentialed delivery
  (operator-provisioned Expo access token plus physical-device delivery
  proof), an FCM-credentialed adapter if raw FCM delivery is ever wanted,
  and any approved geofence-context work. The Gateway-side approval-key
  owner, credentialed provider/scheduler, revoke/send fence, and
  data-only/silent payload pin above are built and production-dark.
- Exercise device auth, session paging, approvals, offline/reconnect,
  attachments, and revocation against one pinned Gateway SHA (`HX-508`).
- Keep screen share, notification awareness, accessibility helper, and call
  screening outside the consumer build unless an explicit enterprise/sideload
  decision accepts their policy and OS-permission posture.

Mobile voice capture is implemented. Transcription is a separate optional
follow-on and must not keep the capture row open.

Owner contract: `MOBILE_NATIVE_CAPABILITIES_PLAN.md`; implementation and device
proof live in the adjacent `personal-ai-mobile-app` repository.

## M9 - Packaging, desktop, and deployment parity

### Current work

- Execute the clean Windows install, first launch, status, restart, stop,
  uninstall, reinstall, and single-instance journeys on the exact candidate.
  Harness ready (2026-08-11): `scripts/install-smoke/run-clean-host-smoke.ps1`
  runs the full journey as one command with a machine-readable evidence bundle
  (runbook: `scripts/install-smoke/README.md`); its read-only preflight refuses
  on any non-clean host (proven refusing on a developer machine, exit 2). The
  clean-VM execution itself remains the outstanding evidence item.
- Prove `remote_hardened` network allowlist, no loopback bypass, secure auth,
  and illegal-egress refusal.
- Exercise failed startup and broken auth/policy recovery with operator-visible
  rollback evidence.
- Include M5 packaged restart and, where claimed, M2-M4 remote-worker runtime
  posture in the same candidate campaign.
- Assemble exact installer hashes, installed version/identity, logs, traces, and
  the packaging proof bundle.

Owner checklist: `PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md` (`GC-P1-09`).

Signed public-trust release promotion additionally requires administrator-owned
GitHub tag/environment protections and signing controls. That external control
plane is not a local code task and remains fail-closed until independently
verified.

### Broad verification record (2026-08-11, merged tip 7df5584e4)

The 2026-08-09 handoff blockers are closed and the program branch merged
cleanly into `main` after a defect-free broad campaign: the final full
`verify:all` scored 592 scenarios with 10 classified non-defect failures
(3 fast-lane parallel-shard load-flakes green solo, 4 cross-platform
visual margins against freshly Linux-captured baselines, 3 tracked
pre-existing usability harness drifts unmasked by earlier fixes). The
arc eliminated the un-awaited route-port defect class (sweep plus the
`verify:gateway:async-boundary` guard), required companion request
signatures on read routes, fixed stuck-loading hook guards, re-verified
the native deterministic pins after toolchain servicing, and refreshed
all 104 mission-control visual baselines. The HX-407 sparse-repair proof
is an explicit declared hold pending an owner decision (see the skip
note in `external-source-schema-parity.test.ts`). This record is broad
single-host verification evidence, not M9/M10 completion: every external
hold above remains open, and packaging artifacts must be rebuilt and
re-hashed at any SHA they are claimed for.

## M10 - Final exact-SHA certification

After M1-M9 close, build one release candidate and run every required named
lane against that exact source state. At minimum this includes runtime truth,
durable recovery, agentic proof, memory truth, realtime truth, backup,
remote-workers, self-configuration, surface, accessibility, visual, desktop,
install, auth/security, provider/channel/A2A/Code Mode lanes required by the
changed scope, and finally `pnpm verify:all`.

Also close credential- or control-plane-dependent queues with an authenticated
operator: live provider probes, GitHub AI-quality review, signing, and release
environment evidence. Record genuine environmental limitations separately from
product or harness failures.

The dated `qa_pre_qa_usability_2026-07-29` workbook is a useful campaign
checklist, but its results belong to an older SHA and are not current status.

## Deferred portfolio register

| Item | Status | Entry condition |
|---|---|---|
| Facilitated specialist review presets (`GC-P2-13`) | `deferred_decision` | Product approves a bounded Chat-native design built on existing Model Council/Assembly/delegation; no second runtime or chat surface |
| Advanced Citadel Vault keys | `deferred_decision` | Architecture for per-Chamber keys, rotation, recovery, and E2EE is approved |
| Sensitive mobile helpers | `deferred_decision` | Enterprise/sideload flavor, Play policy, OS access, consent, and audit boundaries are approved |
| Krea, FAL, Novita, SimpleX | `deferred_decision` | Provider/channel portfolio decision and the owner backlog's governance bar pass |
| Bundled real local embeddings | `deferred_decision` | Footprint, licensing, model distribution, fallback, and quality proof are approved |
| Trusted-local governance fast path | `deferred_decision` | Security design preserves deny-wins, Wards, rate limits, and durable audit |
| Cross-platform hostile-code isolation | `deferred_decision` | Platform-specific adversarial proof exists; Docker alone is insufficient |
| macOS/Linux packaging promotion | `deferred_decision` | Exact artifacts obtain the required signing/notarization/checksum/smoke evidence |

## Explicitly closed or superseded inputs

- Original parity epics `GC-P0-06`, `GC-P0-07`, `GC-P1-08`, `GC-P1-10`,
  `GC-P2-11`, and `GC-P2-12` are complete and do not belong in an active order.
- Google Meet is implemented as a governed voice/session integration; it is not
  a missing channel adapter.
- Agent fanout tool-run weighting is implemented.
- Capability candidate promotion, revoke, rollback, detail, and lifecycle
  surfaces exist; the May backlog must not reopen them generically.
- Mobile voice capture is implemented; only transcription remains optional.
- Citadel screens are shipped, and `require_dry_run` is enforced across the
  current integration/A2A side-effect owners. `route_local` remains audit-only
  until a real local-placement authority exists.
- Separate Cowork and Code primary surfaces are superseded by one Chat surface.
- Unchecked boxes in `superpowers/plans`, archived Mission Control plans, dated
  review ledgers, and blank manual-QA workbooks are not active tasks unless a
  current tranche explicitly promotes a reverified item.
