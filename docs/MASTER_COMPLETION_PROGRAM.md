# GoatCitadel Master Completion Program

Last updated: 2026-08-08

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
| `M1` | P0/P1 | Proof integrity, storage correctness, and agentic hot-path foundations | `in_progress` | M0 | Focused storage/Gateway/harness tests, dual-dialect corrupt-shape proof, concurrent-verifier proof |
| `M2` | P0 | Remote-worker admission, transport, and operator control | `in_progress` | M1 | Focused mesh/auth suites and real two-machine TLS 1.3/mTLS/PoP admission |
| `M3` | P0 | Remote-worker durable execution and ordered event transport | `planned` | M2 | Worker death/reconnect/takeover, replay, transcript, approval-resume, and no-duplicate proof |
| `M4` | P0/P1 | Live worker inference, execution cell, settlement, and visibility | `planned` | M3 | `pnpm verify:remote-workers` with the connected-worker row executed, plus live Ops/Chat data |
| `M5` | P0 | Governed self-configuration and repair expansion | `planned` | M1; M2 for remote custody | `pnpm verify:self-configuration` with live provider, packaged restart, browser secure input, profile, rollback, and delegated-resume evidence |
| `M6` | P1/P2 | Gateway capability and policy follow-ons | `planned` | M1; M5 where repair is involved | Focused capability/policy/provider tests and explicit owner decisions |
| `M7` | P1/P2 | Consolidated Mission Control UX and live-worker projection | `planned` | M4; stable M5/M6 APIs | Focused component tests, populated stories, accessibility, surface, and one visual-regression pass |
| `M8` | P1 | Mobile companion completion and pinned-Gateway proof | `planned` | M3-M5 contract stability | External mobile build/tests and HX-508 device-auth, paging, approval, offline/reconnect, attachment, and revocation bundle |
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
  instead of accepting name existence as shape proof (`FR-356`). The real
  PostgreSQL test remains environment-gated where no test server is configured.
- Concurrent audit events are durably microbatched under the existing ordered
  lock, ordinary prompt-budget receipts are gated off the live path, and scoped
  active-grant reads resolve concurrently before the unchanged deny-wins merge.
- Checkpoint continuation now follows bounded high-intent Chat classifications,
  and the first eligible successful root Chat turn warms the operator review
  inbox without promoting learned memory or adding a foreground model call.

The remaining M1 closeout is the write-side policy/storage hot-path audit, the
final paired remediation-storage migration checkpoint, and any externally held
real-PostgreSQL proof required by the closing campaign.

### Current work

- `FR-362`: add a worktree-scoped cross-process verification/build-output
  exclusion boundary so concurrent lanes cannot invalidate one another.
- `FR-356`: validate the post-migration shape of pre-existing PostgreSQL and
  SQLite objects instead of treating `IF NOT EXISTS` as shape proof.
- Remove avoidable per-tool hot-path serialization while preserving durable,
  ordered, secret-free audit evidence.
- Avoid rebuilding full prompt-budget receipts when no consumer requires them.
- Extend checkpoint continuation by intent/capability rather than a legacy
  `cowork` surface label.
- Improve operator-profile warm-start quality without silently promoting
  ungoverned learned memory.

### Superseded proposals

- Do not move short Chat turns outside durable execution. Optimize admission,
  heartbeat, and checkpoint cost while keeping durable execution authoritative.
- `agent.fanout` budget weighting is complete: fanout consumes bounded subtask
  count rather than one flat tool run.

### Owner evidence and proof

- `review/full-code-review-2026-07-09.md` (`FR-356`, `FR-362`)
- `citadel_update/AGENTIC_FAST_LANE_PLAN.md`
- Focused storage/Gateway/harness tests, corrupt-shape regressions in both
  dialects, concurrent-lane regressions, touched package typechecks, and
  `git diff --check`.

## M2 - Remote-worker admission, transport, and operator control

### Implementation progress

- The hardened Windows provisioner, authenticated local service transport,
  Ed25519 custody, protected filesystem/journal recovery, deterministic x64 and
  ARM64 packaging, and production-dark artifact-signing owner are restored on
  the current program branch.
- Proof-of-possession verification can now prepare a verified request without
  burning its replay nonce; durable nonce consumption and generation-1
  credential admission commit atomically, including rollback at injected
  post-nonce and post-generation failures.
- The native TLS listener now has a bounded authenticated-handler seam with
  strict POST/JSON framing, one request per connection, body/handler deadlines,
  bounded sanitized responses, buffer wiping, and explicit
  `listening_dark`/`listening_live` runtime truth. It remains dark until a
  trustworthy admission handler is composed.

Operator bootstrap/control routes, live admission exchange composition, the
networked worker host, and the real two-machine proof remain open.

### Current work

- Add live bootstrap/admission and operator mutation APIs over the shipped
  admission, credential, nonce, quarantine, revoke, and N+1 owners.
- Compose authenticated protocol handling through the native listener rather
  than leaving the owners production-dark.
- Prove closed ingress, rotation/revocation, exact manifest/attestation binding,
  and operator-visible diagnostics.
- Execute the real two-machine TLS 1.3/mTLS/exporter-bound PoP row.

### Acceptance

- A real second machine completes join, rotation, quarantine, revoke, and N+1
  admission without exposing bootstrap or provider secrets.
- Durable nonce replay remains fenced across restart and concurrent connection.
- Live PostgreSQL, auth, audit, rate-limit, and workspace-isolation proof pass.

Owner contract: `OPENCLAW_HERMES_PARITY_PROGRAM.md`, `HX-501`.

## M3 - Remote-worker durable execution and ordered transport

### Current work

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

### Current work

- Add provider bootstrap and OAuth repair with owner-specific live probes.
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

### Current work

- Inspectable-versus-callable drift metrics and catalog/artifact audit exports.
- Safe continuation semantics only after explicit runtime design.
- Stronger production isolation evaluation without claiming hostile-code
  sandboxing.
- Decide whether `route_local` gains a real execution-routing seam or remains
  audit-only.
- Re-evaluate a bundled real embedding default and the trusted-local policy/audit
  fast path as optional, footprint- and security-sensitive work.

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

### Current work

- Complete MCUX-103, MCUX-106, and MCUX-108.
- Consolidate the evidence-backed July UI findings: intentional Run Detail empty
  state, progressive Skills loading, capability-page framing, wrapping provider
  chips, measured filter overflow, native reminder date input, honest saved-board
  cost coverage, compact Activity timestamps, and wider attention layouts.
- Group shared product polish into common primitives: blocked-state composition,
  ID chips, project/detail differentiation, route redundancy, diagnostics
  density, working-context tabs, model grouping, and repeated disclaimer copy.
- Integrate live HX-507 worker visibility after M4 instead of testing seeded and
  live variants in separate broad campaigns.

### Acceptance

Run focused component tests while implementing, then populated visual stories,
accessibility smoke, surface regression, and one clean visual-regression pass.

Owner backlog: `review/mission-control-ui-ux-backlog.md` and dated frontend
review evidence.

## M8 - Mobile companion completion

### Current work

- Finish consumer-safe approval-key/device-auth, push registration/refresh, and
  any approved geofence-context work.
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
  current integration/A2A side-effect owners. `route_local` remains a decision.
- Separate Cowork and Code primary surfaces are superseded by one Chat surface.
- Unchecked boxes in `superpowers/plans`, archived Mission Control plans, dated
  review ledgers, and blank manual-QA workbooks are not active tasks unless a
  current tranche explicitly promotes a reverified item.
