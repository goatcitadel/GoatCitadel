# Windows worker package

`pnpm package:remote-worker:windows` builds an unsigned portable foreground-worker
candidate. It does not install or start services, mint credentials, sign a runtime
admission manifest, or change an existing installation. Installed package ownership,
authenticated service custody and native volume/executor acceptance remain open.

The builder requires Windows, the repository's pinned native toolchain, current
offline pnpm dependencies, a fresh absolute output directory and the matching Node
24.19.0 executable and distribution license. Node executable hashes are fixed to
the [published release checksums](https://nodejs.org/dist/v24.19.0/SHASUMS256.txt);
the supplied pin must match that reviewed target. The TLS adapter also requires
OpenSSL 3.5.7. A build for ARM64 is not ARM64 execution proof.

For example, with a downloaded Windows x64 Node distribution:

```powershell
pnpm package:remote-worker:windows --target windows-x64 --output-dir F:\worker-builds\candidate-001 --node-executable C:\Downloads\node-v24.19.0-win-x64\node.exe --node-sha256 3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237 --node-license C:\Downloads\node-v24.19.0-win-x64\LICENSE
```

The named command holds the repository output lock while compiling the worker
and its declared workspace dependencies. It stages production dependencies offline
with lifecycle scripts and pnpm hooks disabled, copies the reachable dependency
graph into independent regular files, and excludes workspace test modules and
source-only output. It refuses non-exact external dependency versions, conflicting
versions, optional/peer dependency policies it does not implement, links, unsupported
paths and stale staged workspace metadata. The source dependency lock is retained.
The unrelated workspace image-size patch is allowed to remain unused by this
worker-only deployment; applicable patch failures are not ignored.

Dependency staging uses a fresh `.tmp/worker-package-dependencies-*` directory
inside the checkout, including when the requested output is on another Windows
drive. This avoids pnpm legacy deploy's cross-drive `modulesDir` path failure.
`dependency-staging.json` beside the payload records that retained staging path;
the final build receipt also includes it. Logs and native build outputs remain in
the requested output directory. Successful and failed staging directories are
retained, and existing directories or linked scratch roots are never reused.

The builder creates the native adapter/guard and dedicated cell controller, and uses the existing provisioner
builder for the reproducible service/client/availability trio and its native checks.
It retains build logs, native receipts and failed partial outputs. A successful
`payload` contains:

- `app/worker`: compiled worker, copied production dependencies, native helpers and cell controller.
- `app/runtime/node.exe`: the exact pinned target runtime.
- `app/provisioner`: the native service/client/availability trio and compact installation receipt.
- `app/install`: broker and worker install/uninstall recipes with their required helpers.
- `app/licenses` and `app/pnpm-lock.yaml`: distribution notices and dependency provenance.
- `bin/worker.ps1`: a foreground launcher requiring protected-key configuration.
- `bin/GoatCitadelRemoteWorkerHost.exe`: the native process owner used by the launcher.
- `app/runtime/worker-host-receipt.json`: native host source and image pins.
- `worker-package.json`: the exact file inventory and explicit unproven acceptance fields.

The current inventory schema is `goatcitadel.remote-worker-windows-package.v3`.
It requires the native host, cell controller and complete installer helper set; rebuild earlier
v1/v2 candidates and v3 candidates predating the controller or registry configuration helpers
before using this verification lane. Retained older receipts
describe their original boundary.

`worker-package-result.json` beside `payload` provides the expected manifest hash.
Retain that hash independently when moving or reviewing the package. Checking a
manifest against a hash read from the same untrusted package does not authenticate it.
The package inventory is separate from the Gateway's signed runtime manifest and
installed-tree attestation; it cannot substitute for either admission authority.

Validate the transferred directory using the expected hash from the build receipt:

```powershell
pnpm verify:remote-worker:windows-package --root C:\worker-candidates\candidate-001 --manifest-sha256 EXPECTED_BUILD_MANIFEST_SHA256 --probe
```

This runs the package-file regression suite, rejects changed/missing/additional
files, links, hard links and read-time mutation, and optionally runs the packaged
Node to load the production worker and resolve its dependencies inside the package.
The execution probe requires matching Windows architecture and checks Node/OpenSSL
versions. The controller and provisioning helper's controller mode must refuse
execution without their installed service identity. The probe also executes valid and invalid schema cases using the packaged
validator and reads the packaged worker metadata with the compiled filesystem
adapter. The validator graph is pinned to Ajv 8.20.0, ajv-formats 3.0.1 and
their exact transitive versions; changed dependency or peer metadata is rejected.
This explicit graph does not permit arbitrary package ranges or optional peers.
It checks the inventory again after execution. These script-level file
checks do not prove installed ACLs, retained native path authority or hostile-host
containment.

The launcher accepts no command operands. Its worker configuration uses the
documented `GOATCITADEL_CONNECTED_WORKER_*` settings, with the public protected-key
file required and the PEM key setting refused. It invokes the fixed native host in
foreground mode and retains a private stdin pipe. Native startup independently
filters the environment, pins the packaged Node and `main.js` hashes, and retains
their directory and file handles. Node preload/module-path options and other parent
variables are omitted. Keep tickets, certificates, state and reports outside the
package directory.

The foreground worker can load a digest-pinned local registry for the compiled-in
filesystem reader, Windows NTFS writer and directory lister, and destination MCP
HTTP client. The image guard pins the filesystem helper before launch. See
[destination tool setup](REMOTE_WORKER_MESH_TOOLS.md) for the exact fields,
permission envelopes and installed-service configuration. Package probing
exercises create/edit/stale-content refusal and exact registry-backed directory
listing in a fresh sibling fixture directory
and an actual bearer-authenticated loopback MCP file-read using the packaged
transport and validator. The probe verifies authentication on all five session
requests, credential exclusion from the native writer's root, and refusal after
credential bytes change. It uses a synthetic token in a fresh sibling file; this
does not prove installed credential permissions or protected custody.

The host creates Node with atomic Job Object membership and no inherited job handle.
Its job has a 64-process ceiling and a 4 GiB aggregate committed-memory ceiling;
these host limits do not replace per-assignment cell limits. Closing the host's
last job handle terminates its descendants. Pipe closure requests durable worker
shutdown with a 10-second grace period, followed by forced termination and a
5-second OS liveness check. Normal process exit allows one second for job accounting
to settle; remaining descendants trigger forced cleanup and an error result.
Native stdout contains only a bounded lifecycle result. The worker's configured
report remains the source of worker outcome information.

`pnpm verify:remote-worker:windows-host` exercises this owner on real Windows
processes, including detached descendants, nested jobs, forced owner death,
cooperative and timed-out shutdown, path drift and environment refusal. The binary
also contains a fixed-name SCM dispatcher with no service-install or service-start
operation. Before that dispatcher launches a worker, its OS identity guard requires
`NT SERVICE\GoatCitadelRemoteWorker`, a primary non-AppContainer service-logon token
in session zero, no thread impersonation, and only `SeChangeNotifyPrivilege`.
SYSTEM, shared service accounts and administrator tokens (including filtered
administrator membership) are refused. The LSA logon and process token must name
the same worker SID and authentication session.

The SCM configuration must name the exact quoted host executable with no arguments,
use its own process, demand start and unrestricted service SID, and have no triggers,
dependencies or failure actions. The SYSTEM-owned protected service DACL grants
control to SYSTEM and Administrators; the worker receives only query configuration,
query status and read-control rights. The worker cannot change or start a service
through those grants. The host build's v3 receipt records this policy and its fixed
installed configuration and filesystem roles.

Service mode uses the OS-derived `ProgramData\GoatCitadel\RemoteWorker` root.
Its native file owner verifies the full payload and configuration permissions and
retains handles for the child lifetime. It reads exactly twelve supported settings
from `configuration\worker.environment`; it does not inherit worker configuration
from the service manager's environment. An optional protected `mesh-registry.sha256`
selection adds two derived registry settings; the native host pins that selection
and its exact named JSON file until the child exits. The packaged administrator
command changes this selection only with stopped-service checks, an exclusive
writer lock and an exact previous-selection guard. The worker can modify only its separate
`state` directory. The installed profile limits files to 256 MiB individually and
512 MiB combined, stricter than the general portable inventory limit.

These checks do not establish successful installed-service startup or custody.
The signing transport now has distinct interactive-operator and runtime-worker
roles. The dedicated worker role admits only inspect, runtime PoP and TLS client
signatures after OS token and logon checks; key creation, admission signing and
revocation remain administrative. The source recipe and native validators now
agree on worker read/execute access to the signer/client images and protected
directories, pipe read/write access without instance creation, and signer SCM
query configuration/status plus descriptor-read access. The broker grants no
worker rights. After validating its own service identity, signer startup adds
worker query/wait access to its process and query-only access to its primary token.
It retains existing ACL entries and owner/protection state; failure prevents
transport startup. The broker accepts fresh-install status 1077 only for a stopped
signer with no PID and clean remaining status metadata. Actual cross-account
authentication, availability and installed custody remain incomplete; these grants
do not establish an operational signing path. Retained package receipts prove their
exact recorded source snapshot only.

The source availability broker is now a supervisor: an administrator starts it,
it reports RUNNING before starting another service, and it starts successive
one-exchange signer instances after clean completion or idle exit. Each cycle
rechecks the broker identity and fixed signer configuration/image. Failed signer
status, identity drift or a bounded startup/exit timeout ends supervision. STOP
prevents further starts; an already running signer retains its own bounded
lifecycle. The worker/client has no broker endpoint or service-control grant.
The client waits for a recreated pipe using one ten-second deadline and retries
only missing/busy/timeout connection errors before authentication or transmission.
Broker RUNNING means supervision is active; it does not certify signing or
installed acceptance. This follows the Windows requirements for
[starting another service](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-startservicew)
and [waiting for a named pipe](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-waitnamedpipew).

The process host is not an AppContainer, filesystem/network jail,
authenticated custody owner or hostile-code sandbox. The host verification lane
includes actual interactive/impersonated caller refusal, read-only Windows SCM
queries, and policy checks in normal and AddressSanitizer builds.

The separate worker installer stages the pinned package into `payload`, writes
administrator-controlled public inputs and configuration, then creates the exact
worker and cell-controller demand-start services and leaves both stopped. Existing services or worker footprints
are refused. Inputs are public certificates, the admission ticket with a public
signer reference, and the protected-key reference JSON from their existing owners;
private PEM inputs are refused. Preflight checks package/configuration composition,
not credential validity or authenticated custody. For example:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\worker-candidates\candidate-001\app\install\install-worker-service.ps1 -Target windows-x64 -PackageRoot C:\worker-candidates\candidate-001 -ManifestSha256 EXPECTED_BUILD_MANIFEST_SHA256 -GatewayHost gateway.example -GatewayPort 8787 -ClientCertificateFile C:\worker-inputs\client-cert.pem -TrustAnchorFile C:\worker-inputs\ca.pem -TicketFile C:\worker-inputs\ticket.json -ProtectedKeyFile C:\worker-inputs\protected-key.json -OutputRoot C:\worker-evidence\worker-preflight-001 -Preflight
```

This writes fresh evidence without installing or starting a service. Installation
requires elevation, matching host architecture and an empty worker footprint.
The separate `GoatCitadelRemoteWorkerCellController` runs as SYSTEM with its
dedicated service SID and exactly `SeChangeNotifyPrivilege` and
`SeManageVolumePrivilege`. The worker retains its single ChangeNotify privilege;
the signer configuration is unchanged. The controller SCM descriptor grants the
worker query access only. The recipe uses the administrator's backup privilege
to read the protected parent through retained handles; it does not grant that
privilege to either runtime service.

The installer creates `cells` with the runtime's SYSTEM/controller descriptor,
owner-rights restriction and medium integrity label. The worker has no access to
that directory. `configuration/cell-controller.identity` is a protected 120-byte
record containing controller/helper image hashes and the actual native/cells
directory identities. The image hashes come from the independently pinned package;
the directory IDs come from retained NTFS handles. Native readers verify this
record again before serving or forwarding a request.

Fresh-install source now creates `configuration/cell-capacity.identity`, a protected
320-byte GCCAPS01 record binding `cells` and twelve distinct state-area directory
identities. The `state` container is read-only to the worker; its recorded children
have the existing worker-state permissions. Runtime state and enrollment credentials
go to `state/retained-outbox`, and service reports go to
`state/diagnostic/service-report.json`. Startup pins the exact area directories;
enrollment checks the capacity-record hash against the protected installation
receipt before credential handoff. Legacy settings keep their original state and
report paths without automatic migration. Mixed old/new paths are refused.

`pnpm verify:remote-worker:windows-state-layout` checks both layouts and receipt
refusals using ordinary local fixtures, PowerShell 5.1/7 and native normal/ASAN
binaries. It does not install services. The controller now opens the fixed capacity
record and state paths through retained no-follow handles, verifies the exact
read-only/container and worker-state ACLs, and matches all thirteen IDs against the
independently admitted cells parent. Every controller identity check rereads that
binding. Missing records or changed roots refuse controller startup or further
verification; legacy worker settings support does not bypass this controller
requirement. Exported root handles remain borrowed from the admitted controller.
Cross-process writer coordination, complete pool accounting and successful physical
installation acceptance remain outstanding; this metadata does not enable capacity
measurement callbacks or establish execution readiness.

Fresh installations also create an empty protected
`configuration/state-writers.guard`. The worker host and controller retain shared
read handles before admitting work; enrollment holds an exclusive existing-file
handle before changing its private state or publishing a credential. Sharing
conflicts refuse the operation, so enrollment and service startup cannot pass each
other during a stopped-service check. Stop both services before enrolling a fresh
installation. The guard is not recreated if missing and its contents are never
used as authority. Legacy layouts retain their previous enrollment behavior.
This excludes enrollment only; it does not coordinate Node/helper writers or prove
that workloads from a previous lifetime have finished.

Fresh-layout installations also precreate a fixed 32-byte
`configuration/host-run.guard`. The host holds exclusive write custody and flushes
its process identity before creating the worker. It clears the marker only after
observing zero processes in the original child job. A missing, malformed or
uncertain marker refuses the next host launch; it is never silently recreated or
reset. This preserves uncertainty after host loss even if kernel kill-on-close
has been requested. The marker is fixed installed control metadata, outside the
workload-scanned roots. It does not prove that a currently running worker is
quiescent, and installed crash/recovery acceptance remains unverified.

Controller peer admission also checks the current running worker service, its
protected configured host image, and the marker's live host process identity.
The helper must belong to the same service logon and must not predate that host.
These checks are repeated with existing pipe and controller custody checks;
they do not replace canonical assignment authority or current writer quiescence.

`configuration/cell-runtime.identity` is a separate protected 96-byte GCRTCS01
record containing the actual packaged runtime-directory identity, the exact
runtime-bundle manifest hash, and the independently verified package-manifest
hash. The installed controller pins both custody records and the runtime directory,
checks their read-only security descriptors, and rereads the runtime binding during
custody verification. Missing records or mismatched identities fail closed. Older
installations without this record do not satisfy the new controller's custody
contract; do not generate a replacement from an unverified live directory.
This read-only binding does not yet copy a runtime into a cell or establish
installed execution acceptance.

The installed source owner also retains read-only handles for `node.exe` and
`worker-host-receipt.json`. Its `OpenRuntimeBundle` API accepts only that fixed
inventory and verifies the complete source tree against the installer-bound
manifest hash. The controller wrapper checks its running service identity before
and after opening the bundle. These pins supply source verification, not approval
to copy: the coordinator must retain the owner and recheck it through the copy
authority callback along with destination and capacity authority.

The native runtime-copy primitive requires a current-authority callback before
creating directories/files, each write, and final verification. It rechecks the
protected destination after callbacks and retains partial files and byte counts
on refusal. It never adopts an incomplete directory on retry. The controller
build composes this primitive through combined controller operation 21, with
package custody, approved installation and signed complete-pool capacity.
The local `node --test scripts/packaging/remote-worker-runtime-install-authority.test.mjs`
lane exercises revocation against temporary files without volume or service operations.

`CellMountedWorkspace::InstallRuntime` supplies the recorded guest destination to
that primitive. It freezes the mounted binding, identities and checkpoints,
rechecks mounted custody after authorization, and retains partial-copy counters
without marking the runtime verified. It does not create or repair a mount,
advance provisioning checkpoints, or establish complete-pool capacity authority.
`CellProvisioningJournal::InstallRuntime` adds the complete recorded journal,
independently retained anchor/head, plan identity and journal lifetime to that
boundary. It rejects recursive installation and defers native-owner destruction
if a callback closes the journal. Copies do not advance the provisioning history
or imply execution readiness. Controller coordination and complete-pool authority
are wired in source; installed acceptance remains unverified.

`GCRINST1` is a separate 272-byte runtime-installation request contract. The
TypeScript encoder and native `DecodeCellRuntimeInstall` bind the nonce, journal
identity, prepared/head hashes, package hash and exact current Node runtime
inventory. Both require an independently supplied request binding and recompute
the bundle digest. Controller operation 18 receives the independent binding and
installation frame after all 21 recovery checkpoints. It validates their anchor
and head agreement before entering the installation owner. The owner remains
unconnected in the installed service, which refuses the operation. A valid frame
grants no copying, capacity, execution or readiness authority. Run
`pnpm verify:remote-worker:windows-runtime-install-wire` for the cross-language
normal/AddressSanitizer decoder fixture; it performs no volume or service actions.

`InstallCellControllerRuntime` composes that decoder with the installed identity,
fixed source pins and `CellProvisioningJournal::InstallRuntime`. It checks the
admitted package and bundle against installer custody and rechecks the running
service, cancellation, deadline and caller authority before/after source pinning,
each journal-controlled write and final verification. Before copying, the adapter
flushes an exclusive local installation intent in the original journal's protected
control directory. It retains a sealed outcome, including partial-copy counters,
before returning success. Remote revocation does not suppress local retention;
loss of original host custody still refuses it. Installation records use distinct
magic, hash domains and `.runtime-install` names; they cannot become workload
records. Uncertain attempts remain for read-only recovery, never implicit replay.
The caller still supplies complete-pool reservation/current authorization.
The dedicated 136-byte installation authorization challenge binds connection
nonce, installation nonce/request hash, journal head, monotonic check number and
version. Every effect check needs an exact reply of the separate installation
message kind; volume authorization cannot satisfy it. Checks share a 60-second
operation deadline with a five-second per-exchange bound and 65,536-check ceiling.
The native client requires a dedicated installation authority owner, sends the
frozen request separately from its binding, and refuses mismatched/replayed/early
challenges or unearned success receipts. It cannot substitute a volume callback.
`pnpm verify:remote-worker:windows-install-client` exercises the real private-pipe
client with controlled server responses; it does not install a runtime.
The installed worker now selects the canonical reviewed request and uses combined
operation 21 through a bounded protected Gateway session. Signed capacity admission
and terminal-result persistence are wired; successful installed-host acceptance
and resulting readiness still require proof on the target machine.

The build receipt under `controller-build` describes reproducible source/images,
not installed custody.
Once the protected parent exists, installation failure preserves it and the
staged installation for recovery. Cleanup removes only an invocation-owned,
matching, stopped service; it never removes unknown cell resources.

The paired `uninstall-worker-service.ps1` accepts `-Target`, `-ManifestSha256`,
`-OutputRoot` and optional `-Preflight`. It requires the exact retained receipt,
payload and permissions plus stopped matching worker/controller services. It acquires verified
removal handles before deleting services or payload and retains cells, configuration
and state. It never stops a process or recursively deletes directories. Retained
cells/configuration/state need explicit operator archive or migration before reinstall.

Initial admission is a separate operator step. The restricted worker cannot sign
an admission envelope. After installing the verified signer/broker and worker
packages, the operator starts `GoatCitadelRemoteWorkerProvisionerAvailability`
from an elevated terminal. Keep `GoatCitadelRemoteWorker` stopped. The packaged
`app/install/enroll-worker-service.ps1` accepts the target, independently retained
manifest hash, fresh evidence output and optional preflight:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\GoatCitadel\RemoteWorker\payload\app\install\enroll-worker-service.ps1 -Target windows-x64 -ManifestSha256 EXPECTED_BUILD_MANIFEST_SHA256 -OutputRoot C:\worker-evidence\enrollment-preflight-001 -Preflight
```

Omit `-Preflight` and choose another fresh output directory to perform admission.
The command verifies and holds the full installed payload and configuration,
then runs the native host with a closed environment, `RUN_MODE=once` and
`STOP_AFTER=admit`. Its state/report live under the separate, pinned
`C:\ProgramData\GoatCitadel\RemoteWorker\enrollment` directory, which grants access
only to SYSTEM and Administrators. The elevated runtime does not read the
service-writable state directory. An exclusive enrollment lock prevents a second
enrollment writer.

Successful admission produces a new run-bound report containing the credential
hash, not its bearer. Only the exact validated retained credential is transferred
to `state/runtime-credential.json`. Publication uses a held file handle and
[Windows rename without replacement](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info);
an identical existing credential is retained and a differing one is refused.
No assignment, inference or tool execution is requested by this command. A clean
shutdown alone is insufficient evidence of admission. It leaves all services in
their existing states and requires the worker to remain stopped.

Private enrollment state is retained, including on failure and uninstall. A retry
with unchanged installation inputs can reopen a retained credential without
replaying the bootstrap secret. Changed bindings or conflicting worker authority
require operator reconciliation. If admission succeeded remotely but no local
credential was retained, reconcile with the Gateway; retrying cannot recover a
one-time secret from a report. A successful local handoff is not proof of an
installed service login, a protected state volume, or physical two-machine work.

`pnpm verify:remote-worker:windows-service-install` exercises temporary-file
behavior and installer/uninstaller/enrollment preflight entrypoints under
PowerShell 5.1 and 7, plus native configuration and permission checks with
AddressSanitizer. It compares PowerShell custody records with real NTFS identities
through the production native decoder and compares the intended full parent
descriptor with the runtime owner. Controller payload builds must reproduce for
x64 and ARM64. Enrollment checks cover settings exclusion, exact report/hash
binding, private access policy, publication conflicts, writer exclusion and
host-result handling. It does not install SYSTEM-owned fixtures or prove a
successful service start. The integrated worker/controller/signer service journey,
stock assignment composition and protected execution remain open. Packaging does
not activate native assignment placement.

The broker recipe now installs the package-pinned signer, client and availability
broker into the fixed provisioner layout, with the client and directory descriptors
required by the authenticated transport. It sets the Windows SDK's unrestricted
service SID type (`1`), preserves the exact service-control ACLs, and leaves both
services stopped. Installing the client grants no service-start right.

The package includes `app/provisioner/install-receipt.json`, whose image pins bind
broker to signer and signer to client. It is covered by the package file inventory.
The larger `provisioner-build-result.json` beside the payload retains native build
diagnostics; use the compact receipt for installation. Older receipts lacking the
client binding require a rebuild. To inspect preflight on the selected Windows host:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\worker-candidates\candidate-001\app\install\install-broker-coordinator.ps1 -Target windows-x64 -StagedTrioDir C:\worker-candidates\candidate-001\app\provisioner -PackageResultPath C:\worker-candidates\candidate-001\app\provisioner\install-receipt.json -OutputRoot C:\worker-evidence\preflight-001 -Preflight
```

Preflight queries files, permissions and service state and writes its evidence
bundle; it does not install or start a service. It refuses conflicting or incomplete
pins, a pre-existing footprint, reparse paths and untrusted ancestor permissions.
An actual install requires an elevated administrator context and omits `-Preflight`.
The paired uninstaller requires `-ClientImageSha256` from the retained compact install
receipt whenever the client is present; it refuses client drift and unknown footprint
content before service changes. The installer tracks partial copies for rollback,
uses exclusive creation, and holds directory and image handles during setup.

`pnpm verify:remote-worker:windows-install` runs the recipe contract and temporary
filesystem checks under Windows PowerShell 5.1 and PowerShell 7. These checks do
not prove SYSTEM-owned installation, service startup, authenticated key custody,
first-boot status handling or worker hosting. Those installed-host checks remain
required; package contents alone do not make a mini PC ready for protected work. The
[comparison status](COMPARISON_IMPLEMENTATION_STATUS.md#portable-windows-worker-package)
records the current local proof and the remaining installation/live gates.

Measurement cleanup metadata travels in two ordered phases on the authenticated
controller connection. The primary admission frame supplies the independent
challenge, digest and retained installation request. After replaying the complete
journal and checking current canonical authority, the controller invites the
separately framed cleanup data. The helper accepts that invitation only for the
exact connection and retained head. Receipt of cleanup data alone never grants
measurement authority: the controller also requires a retained writer-exclusion
hold and verifies sealed runtime and installation histories before scanning.
The native-host worker holds a shared byte-range lock on the precreated empty
`configuration/state-writers.guard` during normal activity. Its drained writer
pause releases that lock temporarily; the controller's exclusive lock provides
the measurement hold. Node mutations resume only after shared custody returns,
and pause/resume failure refuses further writes in that worker lifetime. The
separate host-run marker still protects against forgotten cleanup after a crash.
Ordinary protected-TLS workers outside the native host do not require this
installed gate. The controller now composes complete-pool observation and combined
capture/installation owners in source. The authenticated Gateway session adapter
and installed worker startup now select that combined path. The controller keeps
its signing key and measurement hold alive through terminal verification and
joined shutdown. Uncertain attempts enter read-only recovery, without recopying.
Installed acceptance remains unverified; source wiring does not establish a ready
installed worker. See [GOATBOX installation](GOATBOX_WORKER_INSTALL.md).

## Runtime installation review API

Protected operator routes expose the existing canonical installation-review owner:

- `POST /api/v1/ops/workspaces/:workspaceId/remote-worker-assignments/:assignmentId/native-installation-reviews`
  accepts `assignmentGeneration`, `packageSha256` and a normalized versioned
  `runtimeBundle` manifest, plus `controllerEnrollment` containing the independently
  collected `publicPointHex` and `keySha256` from the controller installer report.
  Controller-signed installation requires this approved pin; worker RPC cannot
  enroll or replace it. It creates a pending review and returns its approval
  identifier, status, expiry and request hash.
- `POST /api/v1/ops/workspaces/:workspaceId/remote-worker-assignments/:assignmentId/native-installation-reviews/:approvalId/retention`
  accepts only `assignmentGeneration`. After the existing approval lifecycle has
  approved that review, retention resolves its exact canonical request and
  rechecks the assignment and reviewed revisions. It returns the retained review
  identifier and request hash.

Both routes require operator access and an `Idempotency-Key`. Workspace and
assignment come from the URL; lease authority comes from recent protected worker
contact. Missing or expired contact refuses the operation. Callers cannot supply
lease tokens, approval status or replacement request bytes. A review or retained
request does not register a native capture, admit copying, retry an uncertain
installation or publish readiness. Those remain separate governed operations.
