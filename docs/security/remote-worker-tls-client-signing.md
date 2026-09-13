# Protected worker TLS client signing

Last updated: 2026-09-10

The Windows provisioner now exposes the fixed `SIGN_TLS_CLIENT_CERTIFICATE_VERIFY`
operation (`0x15`) through its authenticated local client/service transport.
The operation uses the active protected runtime-manifest key. It returns a public
signature receipt; it does not export that key or grant service-control authority
to the ordinary client.

## Signed material

The only accepted material is a TLS 1.3 **client** CertificateVerify preimage:
64 space bytes, the client CertificateVerify context including its terminating
NUL, and a 32-byte or 48-byte transcript hash. These are the SHA-256 and SHA-384
forms defined by [RFC 8446, section 4.4.3](https://www.rfc-editor.org/rfc/rfc8446.html#section-4.4.3).
Server-purpose signatures, other protocols, arbitrary files, truncated data,
unsupported lengths and noncanonical padding are refused. The protected signing
owner checks the purpose again on the retained artifact handle before reading a
key. Its existing two-pass byte/hash checks, file-identity checks, deadline,
stop, revocation and one-use signing lease remain in force.

## Local request and authority

The 280-byte request body has these fixed offsets; integers use little endian.

| Offset | Bytes | Meaning |
|---|---|---|
| 0 | 16 | Zero caller placeholder; authenticated client derives the inner operation ID |
| 16 | 32 | Expected protected-state SHA-256 |
| 48 | 2 | Schema version 1 |
| 50 | 1 | Signing purpose 4 |
| 51 | 1 | Zero reserved byte |
| 52 | 8 | Positive, contract-safe keyset/worker generation |
| 60 | 32 | Expected keyset-receipt SHA-256 |
| 92 | 4 | Preimage length, exactly 130 or 146 |
| 96 | 32 | Expected runtime public-key SPKI SHA-256 |
| 128 | 130 or 146 | Exact TLS client CertificateVerify preimage |
| Remaining | 22 or 6 | Zero padding |

The authenticated native client derives the first 16 bytes of SHA-256 over the
NUL-terminated domain `goatcitadel.remote-worker-tls-client.operation.v1`, caller
SID length (u16), caller SID, expected state, generation (u64), keyset receipt,
runtime SPKI digest and exact preimage. The service derives the same operation
ID from its independently authenticated caller and rejects a mismatch before
key access. The key, receipt, generation and state must still be current.

The 184-byte response uses the existing runtime-signature layout and dispositions:
signed, stale state, unavailable keyset, mismatched operation authority, or signing
failure. Rejections carry no signature or signing authority. The TypeScript
decoder checks the returned key and receipt and verifies the signature over the
exact sent bytes. The typed process wrapper snapshots its request before waiting
for the native process, so later caller-buffer mutations cannot change that check.

Signing identical authority and bytes is deterministic; it is not a durable
first-call/replay receipt. Staging files are delete-on-close and do not become
new canonical custody state. Existing admission and key-lifecycle journaling
remain separate.

## Integration and proof boundary

`WorkerWireClient` now awaits channel-bound evidence and signatures before
writing HTTP bytes. It snapshots request authority/headers, binds preparation to
the exact connection, and aborts that work when the connection closes, reaches
its deadline, or is cancelled. Late fulfillment/rejection cannot send a request.
The native client runner accepts the same cancellation signal, stops only its
owned child, and waits for close or the existing two-second termination watchdog.
Cancellation after dispatch does not establish that a durable native operation
was rolled back; callers must reconcile an uncertain outcome.

`WorkerWireClient` accepts either its existing PEM transport or an owner-supplied
TLS context, rejecting ambiguous/missing key sources and any negotiated protocol
other than TLS 1.3 before preparing HTTP. The native adapter below supports the
context path. Connected-worker admission and retained state now support a public
key reference supplied by a trusted composition owner, as described below. The
environment-configured CLI can now compose that owner through its fixed native
image guard. Installed package trust, authenticated service ownership and physical two-machine acceptance remain
required before claiming an installed protected Windows worker journey.

Native tests cover both transcript lengths, cross-purpose input, changed caller,
state/generation/key/receipt bindings, key replacement, revocation, failed-write
cleanup, and deterministic reproduction after signer-state restart. Packaging
proof separately checks x64 ASan execution, reproducible builds, the restricted
production symbol/import boundary, and ARM64 build output. An ARM64 build does not
prove ARM64 execution, and local test fixtures do not prove an installed SCM
service or a real TLS handshake using the protected key.

## TLS adapter compatibility evidence

A disposable Windows engine probe completed mutually authenticated TLS 1.3
handshakes with both 130-byte/SHA-256 and 146-byte/SHA-384 preimages on Node
24.19.0 / OpenSSL 3.5.7. The TLS client received public certificate/key material;
its private client key remained in a separate synthetic signer process. Each
connection consumed one external signature and both peers accepted the result.
The parent retained a process watchdog and closed its owned listeners/children.
The receipt is `.tmp/comparison-protected-tls-external-handshake.log`.

This establishes adapter feasibility, not native-custody or installed-service
acceptance. The disposable pipe/signing fixture is not shipped. A production
adapter must use the authenticated GCPW operation above, preserve installed-file
and keyset bindings, and bound native process/IO ownership during the synchronous
TLS callback. Node's
[engine-based TLS options](https://nodejs.org/api/tls.html#tlscreatesecurecontextoptions)
are deprecated with OpenSSL 3, so the adapter must retain a tested runtime pin
and fail closed when that interface is unavailable. The probe does not establish
support on other Node/OpenSSL versions or ARM64 execution.

## Native TLS key adapter

`apps/remote-worker-windows-tls-native` implements the public-only engine key
interface. It resolves the host's public OpenSSL exports and requires OpenSSL
3.5.7; the acceptance lane pins Node 24.19.0. It does not link another libcrypto.
Each key owns its public authority and retained helper image independently.
OpenSSL ex-data cleanup releases those handles, while the callback DLL stays
loaded for the host process lifetime because OpenSSL retains callback addresses.

The `goatcitadel-tls-v1:` identifier contains canonical lowercase hex: a 188-byte
header followed by a bounded local-drive UTF-16 helper path. The header binds
schema, generation, state, keyset receipt, canonical Ed25519 SPKI, SPKI hash and
helper image hash. It contains no private key, credential or service-control
authority. The TypeScript and native decoders reject malformed authority.

The adapter rejects reparse/ambiguous paths, retains directory handles during
launch and compares the reopened image's file identity and hash with its pinned
handle. Its child receives only `--service-stdio`, an empty environment and three
explicit pipe handles. The suspended child enters an owned job limited to one
process before resuming. Output must be exactly the successful 200-byte GCPW
receipt, with zero stderr, exit zero and EOF. Receipt/key bindings and the actual
Ed25519 signature over the exact TLS client preimage are verified independently.
There is no PEM fallback, generic-sign operation, service installation or start.

The callback checks a five-second operation deadline and allows two seconds to
observe owned-process termination. It is synchronous: Node cannot process other
events while it runs. Local file opens/reads use bounded file sizes but are
synchronous OS operations, so these checks are not a hard disk-I/O latency bound.
An uncertain termination never returns a signature.

`pnpm verify:remote-worker:windows-tls` checks both package typechecks, the worker
suite, the identifier suite, x64 native codec ASan execution, reproducible x64
and ARM64 DLL builds, both real TLS transcript variants, and a built
`WorkerWireClient` request whose body matches the server's TLS exporter. Helper
exit, stderr, excess/truncated bytes, wrong receipt, forged signature, timeout
and image hash drift all fail closed. The client processes receive only public
material; a separate test-only native executable holds the synthetic private key.
This proves adapter/transport integration, not an installed authenticated custody
service, production DLL admission, ARM64 execution or physical worker acceptance.

## Worker admission and retained key references

`createWindowsProtectedWorkerKeyOwner` consumes the public TLS key identifier
and independently pinned admission signer. It calls only the existing fixed
admission and runtime-PoP commands. The trusted composition must supply the
already-admitted TLS context and helper identity; this factory does not admit or
load an arbitrary DLL, install a service, or replace that trust boundary.

The vault's protected variant stores only generation, state/receipt hashes and
runtime public SPKI as its signing reference. It contains no helper path, callback
or private key. A live matching owner must be supplied again after restart. The
worker checks original-byte signatures, cancellation, admission response identity,
permission ceilings and installation receipts before retaining a new credential.
Gateway derives the bootstrap PoP-v2 worker generation from its own bootstrap
record. No worker-supplied generation becomes admission authority.

Reusable bearer and assignment-lease secrets still use the existing file-backed
state port. Public signing references do not provide encrypted credential storage
or native protected-volume guarantees. Lost admission responses and failed
durable retention remain reconciliation cases.

The named TLS verification lane includes actual native-helper admission and a
second worker process reconnecting through canonical Gateway owners. The built
foreground worker receives no private signing material. This uses a synthetic
native helper, not the authenticated installed custody service. The
[current evidence](../testing/COMPARISON_IMPLEMENTATION_STATUS.md#protected-worker-admission-and-restart)
keeps those boundaries and the failed-then-corrected bootstrap integration clear.

## Guarded worker startup

The normal worker entrypoint accepts
`GOATCITADEL_CONNECTED_WORKER_PROTECTED_KEY_FILE`, an absolute path containing
the exact public `goatcitadel-tls-v1:` identifier. Its admission ticket supplies
`protectedSignerPublicKeySpkiBase64Url`. Startup rejects a simultaneous
`GOATCITADEL_CONNECTED_WORKER_CLIENT_KEY_FILE`, any private signer field in that
ticket, or configuration attempting to select another native addon. Environment
values are snapshotted before choosing the key source. A native loading failure
does not fall back to PEM; malformed ticket errors do not echo ticket content.

`createWindowsProtectedWorkerTransport` verifies the runtime SPKI against the
TLS certificate before consulting the native guard. The addon is loaded only
from the fixed `native/GoatCitadelRemoteWorkerImageGuard.node` location beside
the built worker's `dist` directory. The builder compiles the exact adapter
SHA-256 into that addon; public configuration cannot change the adapter pin.
The native guard derives the sibling DLL path from its own loaded module path.
It opens the helper and adapter without write/delete sharing, rejects reparse
ancestors, hashes retained image handles, and holds ancestor directory handles
before the TLS engine is loaded. Existing write handles also prevent admission.

The opaque native lease remains reachable with both the TLS context and the
protected signing owner. Its finalizer releases both image and directory leases
when neither runtime owner retains it. The addon module stays loaded for the
process lifetime so finalizer code remains valid. Local tests prove replacement
refusal before TLS loading and lease release after GC while the child is still
alive, as well as after process exit. The x64/ARM64 import checks reject process
launch, socket, service-control and signing imports in the guard. These are
specific import checks, not a claim of general host containment.

The guard itself and the worker's JavaScript/runtime dependencies must already
belong to a trusted installed package. A fixed relative path cannot authenticate
the code executing there. The guard does not establish installer ACLs, package
provenance, service availability, protected-volume custody or the authenticity of
a public helper reference. Those remain the installed owner and admission
workflow's responsibility. The earlier startup proof used linked workspace
dependencies. The later [portable package](../testing/REMOTE_WORKER_WINDOWS_PACKAGE.md)
proof uses copied dependencies and the pinned embedded Node, including actual
launcher admission/restart outside the checkout. Its signer is still synthetic,
and the package is an unsigned candidate rather than installed-service proof.
