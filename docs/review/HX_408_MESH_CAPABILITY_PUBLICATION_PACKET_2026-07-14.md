# HX-408 Governed Mesh Capability Publication Packet

Date: 2026-07-14
Status: durable contracts/storage committed at SQLite 168 / PostgreSQL 110, with workspace-scoped node admission committed at SQLite 169 / PostgreSQL 111; runtime HOLD

## Current implementation truth

Legacy mesh join still exposes a descriptive `capabilities: string[]`, but current HEAD also contains strict v1 manifest contracts, immutable publication/activation/invocation storage, callable revalidation, and durable node admission. These foundations are production-dark: no authenticated publication owner, exact detached-linkage approval factory, catalog/profile projection, generation-fenced dispatch, HX-306 linkage, publication-specific Ops surface, two-node proof, or named verification lane consumes them. The existing string list remains descriptive metadata only and must not be treated as callable publication.

## Boundary

An admitted mesh node may publish inspectable descriptors for three kinds:

- `tool`
- `mcp_server`
- `skill`

Publication never grants callability. Every descriptor enters `review_required`, is namespaced to its publisher, and is visible only in the inspectable catalog. A later operator-governed activation may make an exact manifest entry callable while its publisher generation, lease, health, policy, permission envelope, and activation revision remain valid.

Remote publication does not install code into Gateway, create a direct network bypass, copy provider credentials, or activate a skill candidate. MCP traffic remains Gateway-mediated. Published skills remain review-only descriptors until exact bytes pass the existing candidate/evaluation/approval lifecycle.

## Identity and manifest

The publisher identity is the tuple:

- admitted `nodeId`;
- immutable join/admission generation;
- mTLS certificate fingerprint when mTLS is required;
- monotonically increasing publisher generation;
- active capability-publication lease fencing token.

The manifest schema is `goatcitadel.mesh-capability-manifest.v1`. It contains 1-128 exact-key entries, canonical JSON bytes, a SHA-256 digest, publisher generation, and creation timestamp. A capability ID is server-derived as `mesh:<nodeId>:<kind>:<localId>`; clients cannot choose a global capability ID.

Common entry fields are local ID, kind, display name, description, semantic version, descriptor digest, declared permission envelope, declared effect posture, and health-check contract. Unknown effect posture is preserved as `unknown` and never upgraded to `none`.

Kind-specific rules:

- A tool descriptor declares JSON input/output schemas, timeout ceiling, idempotency posture, effect posture, and bounded permission/resource claims. It contains no executable bytes, shell command, provider secret, or direct URL.
- An MCP server descriptor declares protocol/version and bounded tool metadata. Gateway selects and owns the supported transport; the publisher cannot supply a policy-bypassing endpoint or auth secret.
- A skill descriptor declares metadata plus exact manifest/instruction/proof artifact digests. It is never callable directly; activation can only stage an inactive candidate bound to those exact bytes for the existing skill lifecycle.

Unknown fields, duplicate local IDs, duplicate derived capability IDs, invalid schemas, unsafe names, oversized metadata, embedded credentials, URLs where forbidden, noncanonical JSON, digest mismatch, or unsupported versions fail closed.

## Lifecycle and storage

SQLite 168 and PostgreSQL 110 own additive, workspace-aware records for:

1. publisher generations and their admission identity;
2. immutable manifests;
3. immutable manifest entries;
4. activation grants bound to exact entry/manifest/publisher generation and operator approval;
5. invocation intents and immutable terminal settlements for remotely callable tools/MCP entries.

Required invariants:

- Manifest publish is same-key/same-byte replayable and conflicts on changed bytes.
- A new publisher generation supersedes but never mutates the prior generation.
- Activation requires a real approval ID, an exact permission/effect diff, healthy publisher status, and a live database-clock lease.
- Disconnect, offline/suspect status, lease expiry, certificate drift, manifest supersession, policy drift, permission drift, activation revoke, or publisher-generation change removes callability before the next dispatch.
- Disconnect changes catalog projection only; immutable manifests, activations, invocations, evidence, and audit remain inspectable.
- Reconnect does not reactivate a prior generation. The operator must review the new exact generation/manifest binding.
- At most 16 admitted publishers per workspace, 32 active manifests per publisher generation, 128 entries per manifest, and 256 active remote callables per workspace. Database enforcement must be concurrency safe.
- Cross-workspace publication, activation, listing, or invocation is rejected even when IDs collide.

## Catalog integration

The capability system receives one server-built projection:

- `inspectableCatalog` includes review-required, active, revoked, offline, superseded, and blocked entries with explicit reasons.
- `callableCatalog` includes only exact active tool/MCP entries whose publisher generation and lease revalidate at profile freeze and again immediately before dispatch.
- Published skill descriptors never enter `callableCatalog`; they may create only an inactive candidate through the governed skill lifecycle.

Capability-profile snapshots record publisher node, generation, manifest digest, entry digest, activation revision, lease fencing token, permission/effect posture, and health generation. Any drift blocks the turn before remote delivery.

## Invocation protocol

Gateway is the sole invocation authority. It creates an immutable intent only after deny-wins policy, workspace scope, tool grants, approvals, network policy, and profile-drift checks pass. The dispatch envelope carries no provider credential and binds:

- invocation ID and idempotency key;
- workspace/session/turn/run lineage;
- exact capability/profile/manifest/entry/activation identities;
- publisher generation and lease fencing token;
- input hash and bounded deadline;
- required approval ID when applicable.

The remote node returns progress and one terminal settlement through a generation-fenced mesh RPC. Duplicate identical settlement is idempotent; changed bytes conflict; stale generations cannot settle. Missing/ambiguous delivery remains `unknown` under HX-305 and is never auto-replayed unless the capability explicitly proves idempotency and policy authorizes retry.

All attempts retain audit/evidence and exact effective cost attribution when the remote capability performs a Gateway-proxied model call.

## API and operator surface

Mesh publication routes require admitted-node mTLS/token identity and cannot be called with ordinary operator or companion credentials. Inspection, activation, revoke, and retry/manual-reconciliation routes are operator-only and no-store.

Ops shows publisher identity/generation, manifest digest/version, entry kind, permission/effect posture, health/lease truth, inspectable versus callable state, activation approval, invocation outcome, revocation, and blockers. It does not render raw schemas or arbitrary manifest text as the primary UI.

## Proof matrix

The named `verify:mesh:capability-publication` lane must cover:

- manifest canonicalization, exact replay, conflict, caps, and SQLite/PostgreSQL parity;
- unknown/extra fields, digest mismatch, schema bombs, credential/URL smuggling, ID collisions, and workspace collisions;
- activation with missing/foreign/stale approval, permission drift, unknown effects, unhealthy publisher, or expired lease;
- disconnect/suspect/offline, reconnect generation, certificate rotation, manifest supersession, and revoke removing callability immediately;
- profile-freeze and pre-dispatch drift checks;
- one-winner dispatch/settlement, duplicate identical receipt, changed receipt conflict, stale generation, timeout, cancellation, and ambiguous delivery;
- no direct skill activation and no remote MCP transport bypass;
- actor/auth class isolation, rate limits, no-store inspection routes, audit/evidence, and secret redaction;
- Ops and one-Chat activity rendering without raw JSON or a new conversation surface;
- independent security review plus live two-node proof when an mTLS test environment is configured.

## Release gate

`HX-408` remains partial until the paired foundation, admitted-node publication owner, governed activation, catalog projection, generation-fenced invocation/settlement, Ops visibility, and named proof lane ship. Advertising arbitrary strings in `MeshNodeRecord.capabilities` does not satisfy any of those gates.
