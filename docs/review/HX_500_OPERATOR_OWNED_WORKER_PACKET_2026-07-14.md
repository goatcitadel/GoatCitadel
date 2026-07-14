# HX-500 Operator-Owned Worker Program Packet

Date: 2026-07-14
Status: architecture contract for HX-501 through HX-507

## Current implementation truth

GoatCitadel has mesh node metadata, one-time-style join-token plumbing, node/lease/session-owner records, durable local execution, a transcript outbox, hash-addressed artifacts, model-usage attribution, trusted Ops runtime truth, and shared-host drain tracking. It does not have a remote worker identity class, bootstrap exchange, purpose-bound worker credential, runtime/vendor attestation, worker registry, remote assignment lease, worker inference proxy, ordered worker event commit, worker resource cell, generation-fenced artifact/effect settlement, or a native Gateway mTLS worker listener.

Mesh join is not worker admission. Shared-host lifecycle admission tracks work inside the Gateway process and is not a remote-worker protocol. Generic companion, device, A2A, MCP, or session-control credentials cannot be reused as worker credentials. A caller-supplied certificate fingerprint is metadata, not proof of mTLS; remote worker admission remains blocked until Gateway either terminates mutually authenticated TLS itself or receives a cryptographically authenticated client identity from a pinned, trusted TLS terminator.

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

SQLite 170 / PostgreSQL 112 are reserved for the worker-admission foundation. They cannot land until HX-408 owns and lands SQLite 169 / PostgreSQL 111, so the physical migration heads and both dialects remain linear.

An operator creates a bounded bootstrap request containing worker label, platform, architecture, allowed workspace IDs, requested capability classes, and an exact signed runtime manifest. Gateway returns a short-lived one-time bootstrap secret once; storage retains only its hash, expiry, request hash, and state.

The worker generates its own key pair and exchanges the bootstrap secret over the existing authenticated TLS boundary using proof of possession. A successful exchange atomically consumes the secret, creates worker generation 1, binds the public-key/certificate fingerprint and runtime manifest, and mints a short-lived `worker_runtime` credential. Reuse, changed request bytes, expired secrets, wrong key proof, foreign workspace, or a second winner fails closed.

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

SQLite 171 / PostgreSQL 113 are proposed for assignment, ordered event, and settlement foundations, but are not allocated or reserved. The storage owner must allocate them only after HX-501 lands and the live migration heads are re-read.

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

SQLite 172 / PostgreSQL 114 are proposed for worker-cell resource and backup state, but are not allocated or reserved. The storage owner may allocate them only when the resource/backup contract is frozen and the live migration heads are re-read.

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

Workers upload chunks to Gateway-owned staging. Gateway verifies size, chunk order, full digest, media/type limits, assignment path, and generation before publishing immutable artifacts. An artifact manifest commits once and binds the active assignment, exact files, hashes, verification claims, and worker/runtime generation.

Verification results are evidence, not self-authorizing truth. Gateway reruns required trusted verification or marks external/worker-only proof explicitly.

External side effects are Gateway-owned intents. A worker may request an allowed effect but cannot bypass tool policy, approval, idempotency, or HX-305 outcome truth. Gateway commits the intent before delivery and one generation-fenced receipt afterward. Identical duplicate receipts are idempotent; changed or stale receipts conflict; ambiguous delivery remains manual-reconciliation work and is never silently retried.

## HX-507: Ops and one-Chat visibility

Ops adds a workspace-scoped worker registry and detail view showing canonical versus projected truth for admission, generation, key/certificate fingerprint, runtime attestation, workspace ceiling, capabilities, health, assignment, lease, resource cell, usage/cost, ordered-event watermarks, artifacts, effects, quarantine, revoke, and cleanup.

Operator actions are explicit and revision-bound: rotate, quarantine, revoke, cancel assignment, retry recovery, inspect reconciliation, and request cleanup. Raw tokens, transcript content, provider secrets, and unbounded logs are never displayed.

The existing one-Chat background rail may show assignment/worker/generation, progress, blockers, approval wait, detach/reattach, cancellation, artifact/effect outcome, and synthesis lineage. It does not create a new conversation surface or allow Chat to widen the assignment.

## Storage and protocol invariants

- All worker-owned tables use workspace plus worker/assignment generation in canonical uniqueness and foreign-key identity.
- Database clocks own expiry and lease authority.
- Bootstraps, generations, assignments, events, settlements, manifests, and revoke receipts are immutable or exact monotonic CAS state.
- Cross-workspace reads and mutations fail closed even when IDs collide.
- Hard delete first revokes credentials, cancels/terminalizes assignments, retains content-free tombstones/reconciliation evidence, then removes sensitive metadata under one owner transaction.
- Revoked generations never reactivate. Re-admission creates generation N + 1 with a new key/runtime attestation.
- Capability publication requires the admitted-node authority in HX-408 and remains subordinate to the assignment/workspace ceiling. HX-501 cannot substitute a worker bootstrap or caller-supplied fingerprint for that authority.

## Implementation order and subagent lanes

1. Architect/QA freeze auth class, route matrix, admission schema, native-mTLS or trusted-terminator identity contract, and two-connection replay/revoke tests.
2. Land HX-408 admitted-node authority at SQLite 169 / PostgreSQL 111, then re-read both live migration heads.
3. Contracts/storage subagent implements HX-501 at its reserved SQLite 170 / PostgreSQL 112 foundation and parity proof.
4. Auth/runtime subagent implements outbound bootstrap exchange, short-lived credential rotation, attestation, and revoke.
5. Durable/storage subagent implements HX-502/HX-504 assignment, lease, event, watermark, cancellation, and exactly-once settlement after receiving fresh migration allocations.
6. LLM subagent implements HX-503 assignment-bound inference proxy and HX-306 reconciliation.
7. Worker-runtime/security subagent implements HX-505 cell, egress/disk/process enforcement, backup/restore, and cleanup after receiving a fresh migration allocation if storage is still required.
8. Artifact/effects subagent implements HX-506 staged CAS, verification, and manual-reconciliation protocol.
9. Mission Control/Chat subagent implements HX-507 registry/detail and inline activity.
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

HX-501 through HX-507 remain non-shipped until HX-408 has landed, a real mTLS/trusted-terminator identity boundary exists, their individual owners pass, and `pnpm verify:remote-workers` passes. Existing mesh joins, caller-supplied fingerprints, local drain workers, generic Ops projections, or local durable execution are useful dependencies but do not independently satisfy remote worker parity.
