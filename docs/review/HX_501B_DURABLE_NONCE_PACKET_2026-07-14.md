# HX-501B Durable Nonce Packet

Date: 2026-07-14  
Status: B1 architecture SHIP after HX-411; B2 runtime HOLD  
Current committed base: `24c04fa5677fc0eb737c756bed690622e4a98d7c`  
Current migration heads under active work: SQLite 173 / PostgreSQL 115, exclusively HX-411  
New active reservation: SQLite 174 / PostgreSQL 116, exclusively HX-411 durable heartbeat-occurrence recovery  
Candidate B1 pair: the next free pair only after all HX-411 migrations commit and a fresh physical-head/reservation scan; HX-501B does not own 174 / 116

## Decision

Split the next HX-501 admission work into two non-competing tranches:

1. **HX-501B1** persists request-nonce consumption under the exact bootstrap or credential authority. It is production-dark and independently shippable after HX-411.
2. **HX-501B2** wires operator bootstrap creation and native admission exchange. It remains HOLD until trusted remote attestation, certificate custody, durable nonce consumption, and two-machine proof exist.

B1 removes the single-process replay-cache limitation without claiming that the native listener or worker protocol is live.

## B1 authority contract

The storage port accepts only a strict discriminated authority, nonce digest, canonical request timestamp, and expiry:

```ts
type RemoteWorkerNonceAuthority =
  | {
      kind: "bootstrap";
      registryWorkspaceId: string;
      workerId: string;
      targetWorkerGeneration: number;
      bootstrapId: string;
    }
  | {
      kind: "credential";
      registryWorkspaceId: string;
      workerId: string;
      workerGeneration: number;
      credentialGeneration: number;
      credentialId: string;
    };
```

Protocol identity mapping is exact:

- bootstrap `authorityId = bootstrapId` and `authorityGeneration = targetWorkerGeneration`;
- credential `authorityId = credentialId` and `authorityGeneration = credentialGeneration`.

The raw nonce, authorization credential, TLS exporter, certificate, public key, request body, and proof never cross the storage port.

## B1 schema

Add two authority-specific tables:

- `remote_worker_bootstrap_request_nonces`;
- `remote_worker_credential_request_nonces`.

Each row stores the complete parent identity, `nonce_sha256`, canonical request timestamp, database consumption timestamp, and expiry. Composite foreign keys bind the exact bootstrap or credential authority. Parent unique keys are added only where required for those complete foreign keys.

Required invariants:

- no raw nonce column;
- `expiresAt = timestamp + 60 seconds`;
- the database clock independently enforces the plus/minus 60-second request window;
- retained rows remain live for at most 120 seconds under clock skew;
- an exact duplicate under one authority returns `false`;
- the same nonce under a distinct exact authority remains independent;
- every failure except the exact unique collision throws and fails closed;
- live rows are immutable and undeletable;
- expired rows can be deleted only after database-clock expiry;
- bootstrap consumption requires a pending, unexpired, still-current target;
- credential consumption requires the latest fresh credential of the latest worker generation with no quarantine or revoke control;
- rotation, quarantine, revoke, expiry, or N+1 admission immediately blocks stale-authority consumption.

Pruning is deterministic and bounded: consume may remove at most 128 expired rows per table; explicit maintenance is capped at 1,000 per table; ordering is stable by expiry and identity; no live row is deleted for capacity.

## B1 writable fence

Contracts:

- `packages/contracts/src/remote-worker-admission.ts`
- `packages/contracts/src/remote-worker-admission.test.ts`

Storage:

- `packages/storage/src/remote-worker-nonce-repo.ts` (new)
- `packages/storage/src/remote-worker-nonce-repo.test.ts` (new)
- `packages/storage/src/remote-worker-nonce-repo.postgres.test.ts` (new)
- `packages/storage/src/remote-worker-nonce-schema-parity.test.ts` (new)
- `packages/storage/src/index.ts`
- `packages/storage/src/sqlite.ts`
- `packages/storage/src/postgres/migrations.ts`
- `packages/storage/src/postgres-migration-integrity.test.ts`
- `packages/storage/src/sqlite-migration-versioning.test.ts`

Gateway protocol boundary:

- `apps/gateway/src/services/remote-worker-protocol.ts`
- `apps/gateway/src/services/remote-worker-protocol.test.ts`

No route, listener, startup, runtime composition, assignment, inference, cell, artifact, Mission Control, documentation, or package-script owner belongs to B1.

## B1 acceptance

- Strict plain-data authority normalization rejects unknown keys, prototypes, accessors, proxies, and cycles.
- Protocol snapshots complete authority before awaiting nonce consumption.
- Top-level protocol authority ID/generation exactly agree with the discriminated binding.
- Tests prove only `nonceSha256` crosses storage and no raw authorization material does.
- SQLite restart preserves replay rejection.
- SQLite covers exact replay, changed authority, cross-workspace collision, expiry, future/stale time, rotation, quarantine, revoke, and N+1.
- Live PostgreSQL two-connection same-nonce race produces one winner.
- PostgreSQL rotation/revoke versus consume has a serial outcome with no post-revoke admission.
- Bounded cleanup preserves live rows and eventually removes expired rows.
- Direct malformed insert, update, and early-delete attempts fail in both dialects.
- Fresh install, exact prior-head upgrade, schema parity, and migration integrity pass.
- Forced migration failure leaves no version row and no partial B1 objects.
- Contracts, storage, and Gateway typechecks, focused lint/format, and `git diff --check` pass.

Migrations are forward-only. Operational rollback is to leave the repository uncomposed; the additive tables remain inert.

## B2 HOLD

B2 cannot start until all of the following exist:

- a trusted remote download-byte verifier bound to the signed manifest;
- a trusted remote no-follow installed-tree scanner for supported platforms;
- an exact trusted adapter receipt contract; caller attestation is never authority;
- dedicated client-certificate provisioning and key custody;
- committed and verified B1 nonce persistence;
- a live generation quarantine/revoke operator path;
- real two-machine TLS 1.3/mTLS and exporter-bound PoP proof;
- restart replay rejection, redaction, and one-time secret-delivery proof.

Secret-once semantics are non-negotiable. Bootstrap creation exposes the raw secret only on the original `created` response. Admission exchange exposes a runtime credential token only on the original `admitted` response. Exact replay returns a secret-not-recoverable conflict; it never recreates, remints, or returns either secret. Lost-response recovery is revoke plus N+1 re-admission.

B2 owns a separate admission API, service, native handler, manifest-trust/attestation ports, listener/runtime composition, and operator bootstrap route. The committed HX-507A GET-only registry route remains untouched. B2 adds no scheduler, assignment dispatch, inference, cell, artifact/effect settlement, Ops UI, Chat surface, or connection-health claim.

## Exclusions

No X, xAI, Grok, additional provider, additional conversation surface, caller-authored attestation authority, weak polymorphic foreign key, unbounded nonce cleanup, or live-runtime claim enters either tranche.
