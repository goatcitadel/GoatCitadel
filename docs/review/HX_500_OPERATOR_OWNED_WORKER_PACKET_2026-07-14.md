# HX-500 Operator-Owned Worker Program Packet

Date: 2026-07-14
Status: architecture contract for HX-501 through HX-507; committed production-dark admission, assignment/event, transport, attestation, native-listener, no-follow scanning, and startup-composition foundations

## Current implementation truth

GoatCitadel has mesh node metadata, one-time-style join-token plumbing, node/lease/session-owner records, durable local execution, a transcript outbox, hash-addressed artifacts, model-usage attribution, trusted Ops runtime truth, shared-host drain tracking, and production-dark remote-worker foundations. The committed foundations own exact manifests and credential claims, hash-only bootstrap-secret and credential-token material, immutable workspace/capability ceilings, worker generations, credential rotation, quarantine/revoke, N+1 readmission authority, assignment generations and leases, ordered hash-chained events, settlement/materialization receipts, native-TLS configuration and listener authority, transport-evidence validation, real no-follow trust loading, bounded installed-tree scanning and attestation validation, channel-bound proof of possession, bounded single-process nonce replay protection, and default-disabled startup composition before public HTTP/A2A readiness. They do not yet expose live Gateway worker bootstrap/registry/protocol routes, server-issued secret delivery, authenticated connection admission, a durable nonce-consumption owner, worker registry projection, inference proxy, scheduler dispatch, worker resource cell, or generation-fenced artifact/effect settlement.

Mesh join is not worker admission. Shared-host lifecycle admission tracks work inside the Gateway process and is not a remote-worker protocol. Generic companion, device, A2A, MCP, or session-control credentials cannot be reused as worker credentials. A caller-supplied certificate fingerprint, a forged `TLSSocket` prototype, or the exported pure identity validator is metadata/evidence, not transport authority. Commit `3cbb89c7f` adds the dedicated TLS 1.3 listener that terminates mutual TLS and issues module-private authority from its own `secureConnection` lifecycle. Commit `9ad427324` composes it into startup with environment-only enablement, serial reload/close, shared-host admission, rollback, and shutdown ordering, while preserving a fixed 503-only production-dark posture. Live admission remains blocked until governed worker bootstrap/registry/protocol owners consume the private connection authority and a durable nonce-consumption owner replaces the current single-process replay cache.

## Product boundary

The target is an operator-owned worker, not a multi-tenant fleet platform. A worker is a machine or isolated service controlled by the same operator that initiates an outbound authenticated connection to Gateway and executes only Gateway-assigned work inside an explicit cell.

The worker:

- never receives a long-lived provider secret;
- has no generic operator/companion/API authority;
- does not accept public inbound control traffic;
- cannot choose its workspace, run, capability profile, network posture, or settlement generation;
- cannot activate skills, tools, MCP servers, or provider routes;
- cannot commit transcript, artifacts, or external effects outside its active assignment fence.

Gateway remains the authority for durable scheduling, policy, approvals, provider routing, usage/cost, transcript materialization, artifact/effect settlement, audit, and revocation.

## HX-501: admission and identity

SQLite 170 / PostgreSQL 112 landed for the worker-admission foundation in commit `aa68ba9d9b13671c5e6587b9bead37568d034a31`, after HX-408 landed SQLite 169 / PostgreSQL 111, so the physical migration heads and both dialects remain linear. Commit `622648bae` closes bootstrap/admission and credential-rotation fencing defects. Commit `5fa644e30` adds the production-dark native-TLS configuration, transport evidence, attestation, proof-of-possession, and nonce core; independent review closed manifest TOCTOU, Windows alias/ADS/device paths, PoP receipt relabeling, and forgeable socket-authority defects before SHIP. Commit `3cbb89c7f` adds the native listener, module-private connection authority, no-follow trust loading, fixed-volume Windows validation, and isolated POSIX installed-tree scanning. Independent QA passed 128 focused cases, Gateway typecheck, exact style/diff/hash gates, live Windows fixed-memory and volume probes, and compiled Docker/Linux hang/kill/close/recovery proof. Commit `9ad427324` adds the default-disabled production-dark startup owner; its 5 focused suites/29 tests, 200 repeated race cases, isolated production compile, and exact style/diff proof passed independently. The listener still answers only the fixed pre-protocol 503 response and grants no live worker authority.

An operator creates a bounded bootstrap request containing worker label, platform, architecture, allowed workspace IDs, requested capability classes, and an exact signed runtime manifest. Gateway returns a short-lived one-time bootstrap secret once; storage retains only its hash, expiry, request hash, and state.

The worker generates its own key pair and exchanges the bootstrap secret over the dedicated native mTLS boundary using TLS-exporter-bound proof of possession. A successful exchange atomically consumes the secret, creates worker generation 1, binds the public-key/certificate fingerprint and runtime manifest, and mints a short-lived `worker_runtime` credential. Reuse, changed request bytes, expired secrets, wrong key proof, foreign workspace, or a second winner fails closed.

Worker credentials:

- have immutable purpose `worker_runtime`;
- identify worker ID and generation;
- carry an explicit allowed-workspace set and capability-class ceiling;
- cannot call operator, companion, device, A2A, MCP, session-control, global event, generic transcript, or settings routes;
- rotate before expiry through proof of current key and healthy generation;
- are hash-only at rest and redact from logs/errors;
- are invalid immediately after quarantine, revoke, generation rotation, or hard delete.

The runtime manifest pins GoatCitadel worker bundle SHA-256, dependency lock digest, vendor-tree digest, launcher digest, supported protocol version, OS, and architecture. Admission requires download-byte verification and an installed-tree attestation. Unknown/missing files, symlinks/reparse escapes, mutable vendor paths, digest drift, unsupported platform, or stale protocol block readiness.

The worker initiates outbound transport to Gateway. No default worker listener, forwarded administrative shell, or copied provider credential is allowed. Any remote filesystem administration is a separate expiring operator-admin grant, visible in Ops and denied by default.

## HX-502: durable assignment and lease

SQLite 171 / PostgreSQL 113 landed for the paired HX-502/HX-504 assignment, ordered-event, materialization, and settlement foundation in commit `1ca6d3d6c` after the committed HX-501 heads were re-read.

The durable scheduler creates an immutable assignment bound to:

- workspace, durable run, task, session, and optional turn;
- worker ID/generation and monotonically increasing assignment generation;
- database-clock lease with fencing token;
- exact capability profile, context snapshot, tool/effect posture, and path-jail hashes;
- runtime manifest digest and worker health generation;
- resource, time, event, output, and artifact ceilings;
- idempotency and assignment-manifest hashes.

Only one active generation may own an assignment. Heartbeat/renewal uses compare-and-swap on worker, assignment generation, fencing token, and database lease. Cancellation is durable Gateway state. A worker that misses cancellation or lease expiry may finish local computation but cannot emit accepted progress or settle the run.

Restart/reconnect reads canonical assignment state. Duplicate identical terminal settlement returns the committed receipt; changed bytes conflict; stale generation, worker, lease, profile, runtime manifest, or workspace cannot mutate the run. Gateway recovers abandoned leases and either reassigns with generation + 1 or terminalizes according to durable retry policy.

## HX-503: Gateway inference proxy

Workers request inference only through an assignment-bound Gateway RPC. The request carries input/context hashes and a model intent ceiling, never a provider key or caller-selected secret reference.

Gateway rechecks assignment/lease/generation, deny-wins provider policy, budget, approval, routing, capability profile, and cancellation before dispatch. It owns provider selection/fallback, streaming, redaction, and HX-306 attempt accounting. Every streamed chunk and terminal usage receipt binds assignment, worker generation, provider/model/route, and attempt ID. Disconnect or worker cancellation stops delivery without erasing the provider attempt.

Worker-visible errors are bounded and secret-free. Workers cannot call provider adapters directly through published tools or environment credentials.

## HX-504: ordered transcript and live events

Each assignment generation owns an append-only event sequence starting at 1. Events use exact schemas for status, tool progress, model progress, approval wait, diagnostic, transcript delta, and terminal output. Generic caller-defined event types are rejected.

Gateway accepts only the next sequence for the active fenced assignment. Exact duplicate bytes are acknowledged idempotently; a changed duplicate conflicts; gaps return the last committed/acknowledged watermark. The worker retains an outbox until acknowledgement and resumes from that watermark after reconnect.

Transcript content materializes exactly once into the assignment-owned session/turn. Live realtime signals are projections of committed events, not authority. Diagnostics expose sent, acknowledged, and pending sequence counts without transcript content. Event payloads are bounded, redacted, and rejected if they contain internal credentials or foreign lineage.

## HX-505: worker cell controls

The exact production-dark owner boundary is frozen in `HX_505_REMOTE_WORKER_CELL_PACKET_2026-07-14.md`. No migration is reserved for the worker cell. SQLite 172 / PostgreSQL 114 are committed to HX-411 at `70bb46facea606a4d2fcbc91d150cd766e91bf6b`. After a fresh head/reservation scan, SQLite 173 / PostgreSQL 115 are exclusively reserved for the HX-411 lifecycle and durable mutation-admission tranche. HX-503 or HX-505 may not share, infer, or reserve that pair from this packet.

Every assignment executes under a worker cell with:

- a canonical per-assignment filesystem root and no-follow path jail;
- disk, file-count, process, CPU/time, memory, output, and artifact ceilings;
- deny-by-default egress with exact host/IP/DNS/rebind controls inherited from Gateway policy;
- no inherited provider or operator secrets;
- bounded sanitized stdout/stderr/exit diagnostics;
- explicit container/service/process identity and cleanup state;
- hash-addressed backup manifest and restore receipt when backup is enabled.

Disk exhaustion, process-tree escape, egress denial, DNS rebinding, symlink/junction/reparse escape, ambiguous process termination, backup corruption, restore drift, and cleanup failure produce canonical blocked/manual-reconciliation state. Cleanup or remote administration outside the assignment root requires a separate operator approval/grant.

## HX-506: artifact, verification, and effect settlement

The exact production-dark owner boundary is frozen in `HX_506_REMOTE_WORKER_SETTLEMENT_PACKET_2026-07-14.md`. A paired migration is required for remote-only upload, manifest, verification, intent, transition, and receipt authority, but this packet allocates no number. Existing Chat/generated artifact rows and canonical external-effect rows remain separate owners rather than becoming a mixed remote-worker ledger.

Workers upload chunks to Gateway-owned staging. Gateway verifies size, chunk order, full digest, media/type limits, assignment path, and generation before publishing immutable artifacts. An artifact manifest commits once and binds the active assignment, exact files, hashes, verification claims, and worker/runtime generation.

Verification results are evidence, not self-authorizing truth. Gateway reruns required trusted verification or marks external/worker-only proof explicitly.

External side effects are Gateway-owned intents. A worker may request an allowed effect but cannot bypass tool policy, approval, idempotency, or HX-305 outcome truth. Gateway commits the intent before delivery and one generation-fenced receipt afterward. Identical duplicate receipts are idempotent; changed or stale receipts conflict; ambiguous delivery remains manual-reconciliation work and is never silently retried.

## HX-507: Ops and one-Chat visibility

The no-migration architecture and exact implementation boundary are frozen in `HX_507_REMOTE_WORKER_VISIBILITY_PACKET_2026-07-14.md`. Ops adds an operator-only workspace-scoped worker registry and detail route showing server-labeled canonical, derived, retained, or unavailable truth for admission, generation, key/certificate fingerprint, runtime attestation, workspace ceiling, capabilities, health, assignment, lease, resource cell, usage/cost, ordered-event watermarks, artifacts, effects, quarantine, revoke, and cleanup.

Operator actions are explicit, idempotent, and revision-bound: immediate quarantine, revoke, and assignment cancel use their canonical owners; rotation, recovery, and cleanup remain approval-gated and unavailable until their effect consumers exist. Raw tokens, transcript content, provider secrets, paths, manifests, and unbounded logs are never displayed.

The existing one-Chat background rail may show only stored workspace/session/turn-matched assignment/worker generations, progress, blockers, approval wait, detach/reattach, cancellation, usage availability, artifact/effect outcomes, and synthesis lineage. Retained realtime events invalidate and refetch canonical projections; they never become client-side truth. HX-507 creates no new conversation surface, widens no assignment, allocates no migration, and stays runtime HOLD until live HX-501 and HX-502/HX-504 composition exists.

## Storage and protocol invariants

- All worker-owned tables use workspace plus worker/assignment generation in canonical uniqueness and foreign-key identity.
- Database clocks own expiry and lease authority.
- Bootstraps, generations, assignments, events, settlements, manifests, and revoke receipts are immutable or exact monotonic CAS state.
- Cross-workspace reads and mutations fail closed even when IDs collide.
- Hard delete first revokes credentials, cancels/terminalizes assignments, retains content-free tombstones/reconciliation evidence, then removes sensitive metadata under one owner transaction.
- Revoked generations never reactivate. Re-admission creates generation N + 1 with a new key/runtime attestation.
- Capability publication requires the admitted-node authority in HX-408 and remains subordinate to the assignment/workspace ceiling. HX-501 cannot substitute a worker bootstrap or caller-supplied fingerprint for that authority.

## Implementation order and subagent lanes

1. Architect/QA freeze auth class, route matrix, admission schema, native-mTLS identity contract, and two-connection replay/revoke tests — complete for architecture.
2. Land HX-408 admitted-node authority at SQLite 169 / PostgreSQL 111, then re-read both live migration heads — complete.
3. Contracts/storage subagent implements HX-501 at SQLite 170 / PostgreSQL 112 with parity proof — complete at `aa68ba9d9b13671c5e6587b9bead37568d034a31`.
4. Auth/runtime subagent implements native-TLS configuration, proof-of-possession, attestation validation, revoke, dedicated listener authority, real no-follow loading/scanning, and default-disabled startup composition — production-dark core complete at `5fa644e30`, `3cbb89c7f`, and `9ad427324`; live bootstrap/registry/protocol routes remain open.
5. Durable/storage subagent implements HX-502/HX-504 assignment, lease, event, watermark, cancellation, and exactly-once settlement at SQLite 171 / PostgreSQL 113 — production-dark contracts/storage foundation complete at `1ca6d3d6c`; scheduler and transport integration remain open.
6. LLM subagent implements HX-503 assignment-bound inference proxy and HX-306 reconciliation under `HX_503_REMOTE_WORKER_INFERENCE_PACKET_2026-07-14.md` — architecture complete; coding waits for HX-411 to release storage owners and a fresh migration allocation.
7. Worker-runtime/security subagent implements HX-505 under `HX_505_REMOTE_WORKER_CELL_PACKET_2026-07-14.md` — architecture complete; coding waits for HX-411 to release storage owners and a fresh migration allocation.
8. Artifact/effects subagent implements HX-506 under `HX_506_REMOTE_WORKER_SETTLEMENT_PACKET_2026-07-14.md` — architecture complete; coding waits for a committed clean base, HX-411/HX-505 dependency ports, and a fresh migration allocation.
9. Mission Control/Chat subagent implements HX-507 registry/detail and inline activity under `HX_507_REMOTE_WORKER_VISIBILITY_PACKET_2026-07-14.md` — no-migration architecture complete; coding waits for live HX-501 and HX-502/HX-504 composition, with HX-503/HX-505/HX-506 sections explicitly unavailable until their owners ship.
10. Independent QA runs cross-cutting adversarial, restart, live two-connection PostgreSQL, two-machine mTLS, browser, and release proof.

Each lane receives an exact file allowlist and migration reservation. No lane may infer authority from a green neighboring gate.

## Named proof

`pnpm verify:remote-workers` is the sole proposed integrated worker lane and must cover at minimum:

- one-time bootstrap, changed replay, expiry, proof-of-possession, credential purpose isolation, rotation, quarantine, revoke, N+1 re-admission, and secret redaction;
- runtime/download/vendor-tree digest pinning, installed-tree drift, symlink/junction/reparse attacks, and unsupported platform;
- assignment one-winner lease, heartbeat, cancellation, recovery, reassign generation, duplicate/changed settlement, and stale worker rejection;
- ordered events across disconnect/gap/duplicate/conflict/restart and exact transcript materialization;
- inference policy/approval/budget/fallback/cancel/stream and HX-306 usage/cost reconciliation without worker-visible provider secrets;
- disk/egress/process/output caps, sanitized diagnostics, backup corruption, restore drift, and cleanup reconciliation;
- artifact chunk/digest/generation fencing, trusted verification, side-effect idempotency, and ambiguous outcome handling;
- exact workspace isolation, operator/worker route class denial, rate limits, no-store operator reads, audit/evidence, Ops/Chat rendering, and default local-mode regressions;
- live SQLite, conditional live PostgreSQL, and conditional two-machine mTLS proof with explicit skips when infrastructure is absent.

## Release gate

HX-501 through HX-507 remain non-shipped until the dedicated native mTLS identity boundary exists, their individual owners pass, and `pnpm verify:remote-workers` passes. HX-408 admitted-node authority and the production-dark HX-501/HX-502/HX-504 foundations are satisfied dependencies, not live worker-runtime proof. Existing mesh joins, caller-supplied fingerprints, forged TLS objects, local drain workers, generic Ops projections, or local durable execution do not independently satisfy remote worker parity.
