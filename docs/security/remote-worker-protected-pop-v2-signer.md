# Protected Remote-Worker PoP-v2 Signer Boundary

Last updated: 2026-08-09

This document freezes the production-dark Windows protected signer boundary for
remote-worker PoP-v2. It does not activate a Gateway route, the native mux, or
an assignment runtime.

## Signed bytes

The protected service signs only the contract-owned, 285-byte PoP-v2 preimage
with the active Ed25519 runtime key. The local service-operation authority is a
custody fence and is not part of the PoP wire signature.

The service-operation authority is the first 16 bytes of SHA-256 over this
exact byte sequence:

1. `goatcitadel.remote-worker-pop-v2.operation.v1` including its terminating
   NUL byte;
2. the authenticated caller SID length as unsigned 16-bit little-endian;
3. the exact authenticated caller SID bytes;
4. the caller-pinned protected-state SHA-256 (32 bytes);
5. the caller-pinned active generation as unsigned 64-bit little-endian;
6. the caller-pinned keyset-receipt SHA-256 (32 bytes); and
7. the exact 285-byte PoP-v2 preimage.

The outer client request carries a zero operation placeholder. After mutually
authenticating the local service connection and capturing the caller token, the
native client derives the authority above and submits it on the protected inner
exchange. The service independently derives it from the impersonated caller SID
and rejects any mismatch before state hashing, key access, or signing.

## Idempotency and replay truth

The runtime PoP signer has no process-local or durable replay cache. It does not
claim a first-call, exact-replay, changed-replay, or capacity-exhausted
disposition. Ed25519 is deterministic, so signing identical pinned authority
and identical preimage bytes in separate one-shot service invocations
truthfully returns `signed` with the same signature. A legitimate outer request
with changed material derives a distinct local operation authority. A nonzero
outer placeholder is rejected, and an inner operation ID that does not match
the authenticated caller SID, pinned state, generation, receipt, and exact
preimage is rejected as `operation_authority_mismatch` before key access.

Admission, key creation, and revocation retain their separate protected journal
semantics; this runtime-signing rule does not change those operations.

## Crash and lifecycle boundary

Admission-evidence and runtime-PoP signing stages use protected
delete-on-close files. Write/sign/flush failures and abrupt process termination
therefore cannot leave a staging child that blocks the fixed protected-state
root. Native cutpoint tests require the root child count to remain unchanged and
require protected-state reinitialization plus deterministic re-signing to
succeed after the injected failure.

The TypeScript helper performs one `sign` exchange using caller-supplied pinned
state, generation, and keyset receipt. It does not inspect, start, or restart the
Windows service. The untrusted client is intentionally not granted
`StartServiceW` or other service-control authority. A missing service, a changed
generation, a revoked key, or a changed receipt fails closed.

## Activation prerequisites

Keep the signer, assignment routes 8 through 10, and native mux production-dark
until all of the following are owned and freshly proved:

- an admin-owned installer or worker-runtime coordinator owns installed-service
  availability and restart without delegating service-start authority to the
  untrusted client;
- the admitted protected-authority owner supplies the exact state, generation,
  and keyset-receipt pin for the one sign exchange;
- an installed SCM test proves service availability, authenticated local
  connection, signing, restart behavior, and fail-closed rotation/revocation;
- the complete x64, ARM64, ASan, deterministic-build, contracts, Gateway, and
  provisioner lanes are green on the integrated release candidate; and
- live two-machine TLS, credential, nonce, PoP, assignment, and reconnect proof
  is completed in the later activation tranche.

Until those prerequisites are met, route descriptors are contract reservations
only and must not be registered as callable Gateway or native-mux handlers.
