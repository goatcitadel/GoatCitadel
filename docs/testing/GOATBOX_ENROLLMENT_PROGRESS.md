# GOATBOX enrollment progress

## Verified on GOATBOX

The operator ran the pinned first-keyset launcher. Its public result reports
`created`, generation `1`, predecessor `0`, `inspectionPassed: true`, and active
custody. Retain `C:\worker-evidence\first-protected-keyset-v1`; do not repeat key
creation or remove the protected signer state.

- Operation: `e78681891f16808807ad472d510352f0`.
- State: `ec89cf132f099e4ea95136e73d10fc54761403d16a8f0c65c5dee19cb80d5cde`.
- Keyset receipt: `f332cb03bcfe7bd12792cf94ce2465db90a8ae1617800e8c7a6cef39ffdb8593`.
- Runtime public-key digest: `35c5a20e5850629b6364164d56603b49edac0eaaef63b4cc3f80591798f2a57a`.
- Admission public-key digest: `44d8f24f9b8f26831a290d8b4daa09bdb7698b139f652b10c8590934742bd40c`.

Both pasted public SPKIs parse as Ed25519 and match these digests locally.
This establishes key creation and public inspection, not worker admission.

## Controller preparation

The operator selected this checkout as the controller. Its current LAN address
is `192.168.0.219`; the proposed native mutual-TLS listener is port `9443`.
The local Gateway API remains bound to loopback on port `8787`.

Dedicated CA, server, and manifest-signing keys are retained in the ignored
`runtime/remote-worker-goatbox` directory. Its inheritance is disabled and access
is limited to the creating Windows user, SYSTEM, and Administrators. Do not copy
this directory to GOATBOX or publish it. The server and client certificates have
30-day validity; the CA has 365-day validity. Renewal remains necessary.

The GOATBOX client certificate uses the existing generation-1 public key; no
GOATBOX private key was created or exported on the controller. OpenSSL verified
the certificate chains and intended server/client purposes. Node verified the
server IP SAN and exact worker public-key match. The production Gateway runtime
configuration parser accepted the generated settings. These are preparation
checks, not proof of an authenticated cross-machine connection.

## Installer correction

The runtime expects an encoded `goatcitadel-tls-v1:` identifier as the contents
of the historically named `protected-key.json` file. The installer previously
required a JSON object, which rejected the actual runtime format. It now calls
the inventory-verified package's canonical decoder before installation. Tests
on Windows PowerShell 5.1 and PowerShell 7 accept a valid identifier and refuse
JSON, a trailing newline, and a corrupt identifier.

The retained GOATBOX package has not been replaced with this installer fix yet.
No admission ticket has been issued. Gateway health, the native listener,
cross-machine reachability, installation evidence, worker/controller installation,
and end-to-end admission still require live verification. Do not substitute
fixture or locally invented receipts for installed-worker evidence.

## Controller startup blocker

The normal `pnpm dev:gateway` launcher built its project references successfully
on 2026-09-18, then failed during PostgreSQL canonical schema-shape validation.
Failures include integer column shapes and index shapes in channel delivery,
memory enumeration, and multiple remote-worker tables. The current expected
manifest uses `bigint` for the channel-delivery integer fields and renderer-named
unique indexes. Catalog inspection is still required before choosing a repair;
the error alone does not establish each actual column or index definition.

The identified task-owned Gateway supervisor and child processes were stopped
to prevent automatic retries. PostgreSQL was not reset, and its process was not
terminated. Normal startup invokes migrations, so this failed launch is not a
claim that the database was untouched. No manual schema repair was performed.
The native TLS listener never became ready and no bootstrap ticket was issued.

Next choose whether live acceptance belongs in a dedicated test database or the
existing Gateway database. The latter requires a validated migration repair and
a verified backup before applying changes. An isolated acceptance database would
not enroll GOATBOX into the existing personal workspace.

## Existing database repaired (2026-09-18)

The operator selected repair of the existing database. The repair used a new
forward migration, version 196 (`additive_schema_shape_convergence`); historical
migrations were not edited. It widens additive integer columns to canonical
bigint, adds canonical unique index names without removing existing constraints,
and retains descending enumeration/time indexes through explicit recreation.

The custom-format backup is retained under the protected controller directory at
`db-repair/before.dump` (2,218,574 bytes; SHA-256
`85b4918bc2c86707229fdc6ae28949b27cb7d8df9ed93d8c64d26c64afc9b774`). Its inventory
was read successfully and it was restored into a separate rehearsal database.
The normal migration runner applied pending migrations 195 and 196 first to that
copy, then to the selected existing database. Counts and order-independent row
fingerprints for all 365 pre-existing tables were unchanged in both runs.

Post-repair canonical catalog validation reported zero issues and zero column
differences. A fresh test database completed through version 196, and a second
run applied no migrations. All 59 focused schema-shape/migrator tests passed;
the old test snapshots were updated to the actual current catalog (364 canonical
tables, 5,024 columns, 758 canonical indexes), with descending-key assertions.

The Gateway returned `status: ok` from `/health` at loopback port 8787. The native
TLS listener bound `192.168.0.219:9443`; a local TLS 1.3 probe verified its exact
server certificate and received the required-certificate alert without a client
certificate. This does not yet prove GOATBOX network reachability or admission.
The task-owned Gateway is intentionally running for the enrollment sequence.
No new bootstrap ticket has been issued, and no database reset was performed.

## Network and admission activation verified (2026-09-18)

The operator reported `TcpTestSucceeded: True` from GOATBOX to
`192.168.0.219:9443`. This establishes cross-machine TCP reachability only.

The controller environment now explicitly enables
`GOATCITADEL_WORKER_ASSIGNMENT_RUNTIME_ENABLED=true`. Before this change the
listener settings alone left admission unregistered. The task-owned Gateway
process tree was identified by its launch command and ancestry, restarted with
the activation setting, and returned healthy readiness. Its startup diagnostics
reported `remote_worker_native` completed with `notes: listening_live` at
2026-09-18T22:22:10.900Z. The snapshot is retained in the protected controller
directory as `admission-startup-proof.json`.

Authenticated GOATBOX admission is still unverified. No bootstrap ticket has
been issued. The remaining enrollment preparation must reconcile the package
inventory with the installed-tree evidence contract and the installer's ticket
input ordering before issuing a real ticket. Test-fixture receipt hashes are
not acceptable live enrollment evidence. No GOATBOX services or disks were
changed during this controller activation step.

## Stopped installation handoff prepared (2026-09-18)

The installer now accepts explicit `-DeferEnrollment` instead of requiring a
ticket before the machine has installation evidence. Supplying both options or
neither is refused before native initialization. This mode omits `ticket.json`;
the runtime consequently cannot enroll until a real ticket is provisioned. It
retains the existing stopped-service contract and exports public installation
facts as `pending-enrollment.json`, not a claimed admission/attestation receipt.

The small handoff ZIP `.tmp/GoatCitadel-GOATBOX-worker-install-v1.zip` reuses the
retained `C:\worker-candidates\client-token-fixed\payload`. It includes pinned
installer helpers, public certificates and the generation-1 key identifier only.
It does not recreate the signer keyset or replace the signer installation.
ZIP SHA-256: `cdee19061b327afbc3661684774a2c27b653a7c41d6ec2f7a828943d50820843`.
Launcher SHA-256: `27190955ac84bc3a308b5f72d58e2038f4b19fb7f7b69160279585adbcb92089`.

Six focused tests passed across Windows PowerShell 5.1 and PowerShell 7:
explicit input choice, wrong-machine refusal before side effects, and canonical
protected-key input validation. All handoff PowerShell files parsed, their
inventory hashes matched, and the public certificate matched the protected
key identifier and CA. A real retained-package preflight completed package/input
validation but returned `refused` solely because this local session is not
elevated; no services, controller key or cells were created. Elevated GOATBOX
installation remains unverified and requires the operator's next run.

After successful installation, retain the reported evidence folder and public
controller enrollment. Next collect actual installed-tree evidence, issue the
controller-signed runtime manifest and bootstrap ticket, then provision the ticket
under the stopped worker's protected configuration before enrollment. These
steps and an authenticated live run remain outstanding; this ZIP is the stopped
installation stage, not completion of worker enrollment.

## GOATBOX controller-key installation failure

GOATBOX preflight passed, but the install at
`C:\worker-evidence\worker-install-20260918-153225-760` failed inside
`CreateMachineKey` with `0x80090010`. Installation ID:
`81877965c3b140539617e7699cd4e3e8`. No worker or controller service was created
or started. The protected cell parent and staged payload were intentionally
retained. Do not rerun installation or remove them blindly.

The subsequent operator-context machine-key open returned `0x80090016`.
This establishes failure to open the named key, not authoritative absence of
persisted key material. No key recovery, permission change or retry has occurred.
The read-only `read-controller-key-state.ps1` diagnostic enumerates machine key
names (reporting only whether the exact controller name was observed), attempts
the exact open, and reads key-storage directory ACLs. Five checks passed across
PowerShell 5.1 and 7, including native probe execution, wrong-host refusal and
the absence of mutation/signing/export native imports. GOATBOX output is pending.

## Persisted controller key located and permission boundary identified

GOATBOX returned a completed provider enumeration without the key name, but its
Security audit establishes successful creation and persistence at 2026-09-18
15:33:05 local time. The exact key file is
`C:\ProgramData\Microsoft\Crypto\Keys\5e73bfd4cd51dfdc788ed3095838b24d_b73bf112-8305-4217-a84f-f751c7d78199`.
Its owner is SYSTEM and its protected DACL grants full access only to SYSTEM and
the cell-controller SID. This matches the intended key policy. The installer
performs its next provider read under the administrator identity excluded by
that DACL; neither administrator enumeration nor open proved key absence.

The SYSTEM validation handoff `verify-goatbox-controller-key-system.ps1` opens
only this named existing key, verifies its unique filename, policies and both
provider/file permissions, and exports only its public point. It creates a fresh
administrator/SYSTEM-only review directory and a one-shot SYSTEM scheduled task,
then removes its own task. It does not create or alter a key or installed service.
Seven focused checks passed (descriptor/public-blob validation, wrong-host
refusal, public-only operation surface, and existing descriptor tests) across
PowerShell 5.1/7. Elevated task execution remains to be verified on GOATBOX.
Handoff SHA-256: `5a89c51481c0599a588ae88bfcd4a2e1a908ed318ba50ef440e0ea681e59287b`.

Do not rerun the original installer, recreate the controller key, relax its ACL,
or remove the staged installation. Retained-installation recovery still requires
successful SYSTEM key validation and matching public enrollment evidence.

GOATBOX SYSTEM review `ControllerKeyReview-11b7229783e847b195e313405c8d8c65`
opened the persisted key and passed its unique-name, machine-key, ECDSA_P256,
non-exportable and signing-only checks. It failed the shared grant validator;
the initial report did not distinguish provider versus file ACL or preserve
the returned ACE masks. This is not evidence that key permissions need changing.
The v2 review records both public descriptors and ACE details before applying
the unchanged validators, with separate failure stages. Seven focused checks
passed, including exact permission-mask diagnostic retention. No key or key
permissions were changed. V2 script SHA-256:
`fb901cfe815a4270cb5dcc466b52b729cd43ae6767e246a4a6b98f8c37cca644`.

The v2 GOATBOX report identified the exact mismatch: the provider returns
`0xD01F01FF` for both expected principals, while the file returns `0x001F01FF`.
Both descriptors have SYSTEM ownership, a protected DACL and exactly the SYSTEM
and controller allow entries with no ACE flags. The provider validator now also
accepts that exact observed mask. File validation does not accept it. Tests
reject changed masks, an Administrator substitute, and an additional principal.
All seven focused checks passed in PowerShell 5.1/7. The C# provider descriptor
validator was corrected consistently; the administrator-context creation flow
still needs the separate SYSTEM-owner fix before a fresh install can be claimed.

V3 SYSTEM review handoff (key and permissions unchanged):
`.tmp/verify-goatbox-controller-key-system-v3.ps1`, SHA-256
`b0f4711bcc4a877d05ea12d684282aa062f972db828d85056ef86ffe698da6d8`.
Live public-point export and retained-install recovery are still pending.

## Existing controller key verified; retained-install recovery prepared

GOATBOX v3 SYSTEM validation passed. Public review:
`C:\ProgramData\GoatCitadel\ControllerKeyReview-b078588a4d3f44978dc0ca66c4cab883\public-review.json`.
Controller public point:
`0473401e4f060e970cbc5814df8428c6b34dc557ad2127d33b8b155f9c9a57ce96b925db1947adf2ae3c2c19e6678d1f4016c33364a88483537a661d2de71ca0ca`.
Domain-separated key hash (independently recomputed locally):
`173b2848bc3fd5b2f0f41e983a46c8883fe1f1919369826e96704cb091edf362`.
No key was created, permissions changed or private material exported.

`resume-goatbox-worker-install.ps1` is a narrowly pinned recovery for installation
`81877965c3b140539617e7699cd4e3e8`. It verifies the failed-install and SYSTEM-review
evidence, exact retained inventory, public inputs, configuration ACLs, custody
records and empty worker state. Apply acquires the installed writer gate,
restores the worker's read access to the shared parent, creates the two missing
configuration records, then registers both dedicated services stopped. Existing
services or extra configuration cause refusal. It never calls key creation,
copies payload files, starts services, deletes retained state or formats disks.
Any partial failure is preserved with stage-specific evidence, not auto-cleaned.

Five focused checks passed across PowerShell 5.1/7, covering exact incident
acceptance, ten evidence substitutions, wrong-host refusal and operation bounds.
All packaged PowerShell parsed. Full elevated recovery has not run locally and
requires GOATBOX's next result.
ZIP: `.tmp/GoatCitadel-GOATBOX-worker-recovery-v1.zip` (36,318 bytes).
ZIP SHA-256: `84e9adbf8051136473b376de89f4a0234edbe1013954bdc3482af6b0c3254d0e`.
Launcher SHA-256: `572f29177bde0085d663aecadf58693224ce9e60e1a24b48749cddfdc62c470a`.

Recovery v1 refused before mutations because the cell-parent SACL had the
Windows-added auto-inherited control flag: `S:AI(ML;OICI;NW;;;ME)` versus
`S:(ML;OICI;NW;;;ME)`. All other reported fields matched. The new
`Assert-WorkerCellParentSecurity` ignores only `SystemAclAutoInherited` and then
compares serialized descriptors, including the mandatory-label ACE bytes.
Testing uncovered that `GetSddlForm(All)` can omit those label ACEs, so textual
comparison alone did not reject modified labels. The binary comparison accepts
the captured descriptor and rejects thirteen changes covering owner, group,
DACL/SACL controls, extra grants, label SID, policy, inheritance and missing label.
Seven focused tests passed across PowerShell 5.1/7. No GOATBOX permissions were
changed. The v2 recovery handoff contains this corrected validator; successful
elevated recovery still requires the operator's result.

## Worker recovery v3: retain completed controller, correct virtual account password

GOATBOX v2 evidence `worker-resume-20260918-160046-472` reports controller creation and both configuration records completed, followed by worker CreateService account rejection. Neither service started; keys and payload unchanged.

Corrected `CreateStoppedWorkerService` to pass NULL rather than an empty password for the virtual service account, as required by Microsoft CreateService documentation. Recovery v3 verifies that exact partial incident, retained controller configuration/stopped state, and byte hashes of both expected records. It creates only the missing worker service; it neither recreates the controller nor writes those records. It preserves existing keys, payload, and disk layout.

Validation: 10 focused recovery and cell-parent checks passed across Windows PowerShell and PowerShell 7; native installer helpers compiled; packaged PowerShell files parsed. Live virtual-account creation remains unverified pending GOATBOX run.

Handoff: `.tmp/GoatCitadel-GOATBOX-worker-recovery-v3.zip`, SHA256 `b860fc87ef4a4565c5a3b04fa9fce11dc47309a5fc99628b35512f984adf1fb8`; launcher SHA256 `4be45706241e1001e013a925b9d307b9eaf15e3a0596f8bf3a58f854e1140929`.

## GOATBOX recovery v3 passed (2026-09-18)

Operator-reported evidence: `C:\worker-evidence\worker-resume-20260918-160753-289\recovery-report.json`.
Verdict passed, stage completed. Worker service created; existing controller retained. Both services remain stopped, enrollment deferred. No keys or payload changed, and no new configuration files were written. This confirms the virtual-account CreateService correction on GOATBOX.

Next boundary: protected enrollment, not another service recovery. The current enrollment script requires installed `ticket.json`, which has not been provisioned. The installed-tree scanner still expects bundle/launcher/locks/runtime/vendor, whereas the retained package uses app/bin. A compatible verified installation-evidence path and protected deferred-ticket provisioning are required before issuing admission inputs and starting the worker. Service registration success does not establish enrollment, connectivity, or execution success.

## Deferred admission inputs and installed package survey (2026-09-18)

Added optional hash-pinned TicketFile/TicketSha256 enrollment inputs. Preflight checks inputs without publication. Apply uses the installed writer gate, checks stopped services, and publishes through the existing atomic create-only transfer before admission. Different existing ticket bytes remain untouched; ticket contents are excluded from evidence. Legacy configuration binding field order is preserved for retries. Enrollment behavior tests pass on PowerShell 5.1 and 7, including missing pins, private-key inputs, malformed-JSON redaction, and existing atomic no-overwrite cases.

The installed-tree scanner now has an explicitly selected Windows package profile pinned to the v3 worker-package manifest. It requires SYSTEM ownership, covers every inventory file plus the manifest, derives bundle/lock/launcher/vendor/runtime roles from fixed paths, and retains native link/stream/ACL/identity and before/after checks. Windows inspection batches at most 32 operations per fixed native-helper invocation; framing, response bounds, deadlines, and per-item validation remain enforced. Existing default scanner behavior remains covered.

Proof: Gateway typecheck passed; four scanner/helper test files passed (62 tests, one platform-specific skip), including real local Windows batched inspection. The retained package inventory parses to 1,776 files and 109 directories. GOATBOX's full scan and enrollment remain pending; local tests do not establish either.

Read-only handoff `.tmp/GoatCitadel-GOATBOX-installed-survey-v1.zip` SHA256 `2b6456470e8ab395d9d642de9e3c75658c8bf57034e77223052985625a4918aa`; launcher SHA256 `a357928903d896bfded2b60f70cc13662f9f67c5bc284be62095c396a1c1796a`. The survey writes public evidence only, makes no service/key/installed-file changes, and explicitly reports admissionReady:false. Its preliminary package-bound scan is not a signed-runtime-manifest admission attestation. After these installation facts are returned, issue the signed manifest and obtain a scan bound to that manifest before preparing the admission ticket.

## Survey v1 failure: capture child diagnostics

GOATBOX's survey exited nonzero without visible scanner output. The launcher used CreateNoWindow with unredirected standard streams, so its generic failure did not reveal the underlying error. No successful survey or enrollment is claimed.

The launcher now drains stdout/stderr concurrently, retains the real child exit code, saves bounded output to survey-process.json, and prints it before reporting failure. Both PowerShell 5.1 and 7 tests cover successful and failed child exits with both streams. The scanner bundle is unchanged (SHA256 34535f59569cd90fc74579db20b1c1c520e71ef3017462830764aa1248f551e1).

Read-only retry handoff: `.tmp/Run-GOATBOX-Installed-Survey-Diagnostics.ps1`, SHA256 c8c75e0d4112ae51738ff5686393f496bf3768fa2ba01811b859e6b41b44aaee. Copy alongside the existing survey.mjs in C:\worker-candidates\installed-survey-v1. No installation, service, key or disk changes. The underlying scanner failure remains unknown until its captured output returns.

## Survey v2: helper stderr surfaced (2026-09-20)

The v1 survey failure was undiagnosable by construction, and the v1 diagnostics
retry would not have resolved it. The Windows no-follow helper spawned System32
PowerShell with `stdio: ["pipe", "pipe", "ignore"]` and, on a nonzero child exit,
threw a bare `Windows no-follow inspection failed.` carrying neither the exit code
nor any output. The retry launcher drains the survey process's own streams, but
the helper's stderr was discarded one level deeper, inside the gateway scanner.

`remote-worker-windows-no-follow.ts` now pipes helper stderr into a bounded 2 KB
buffer, zero-filled on every terminal path in line with the file's existing
poisoning discipline. `sanitizeHelperDiagnostic` strips PowerShell CLIXML progress
noise and non-printables, collapses whitespace and caps the excerpt at 240
characters. The nonzero-exit error now reports the helper exit code and that
excerpt. The POSIX helper in the installed-tree scanner retains the original
`ignore` stderr and is unchanged; it is not the GOATBOX path.

Proof: gateway `tsc --noEmit` clean. Four scanner/helper test files passed (62
tests, one platform-specific skip), matching the recorded baseline. A real local
failure reproduction (subst-backed drive) returned
`Windows no-follow inspection failed. Helper exit 73 produced no diagnostic output.`
where the previous message carried no exit code at all.

`build-goatbox-installed-survey.mjs` replaces the previous ad hoc packaging: it
bundles the pinned entry with the vendored esbuild, substitutes the launcher's
single `__SURVEY_BUNDLE_SHA256__` placeholder with the built bundle's digest, and
refuses if the placeholder is absent or survives. It has no test yet.

Read-only handoff `.tmp/GoatCitadel-GOATBOX-installed-survey-v2.zip` (94,357 bytes),
SHA-256 `79e4da0489ba84e990199b1525d52970d65f5c2ba8514b1a6292a0af6ccd53fa`.
Bundle SHA-256 `4bdafde5f97ad919c56768acc5e4db70ab013acb60493ddf143020162dc755f4`
(462,715 bytes); launcher SHA-256
`7d8320d827e91514c0a719e9e4b36a3107874e8f213467a754f2767b27b2a42c` (3,834 bytes).
Both parse under Windows PowerShell 5.1 and PowerShell 7, and the archived bytes
round-trip to those digests. The package pin, node pin and GOATBOX host guard are
unchanged.

This makes the v1 failure reportable; it does not explain it. One hypothesis
considered and NOT established: the helper bootstrap requires
`[Convert]::FromBase64String`, `[IO.Compression.GzipStream]::new`,
`[ScriptBlock]::Create` and inline `Add-Type` C#, all refused under PowerShell
Constrained Language Mode. A local attempt to force that mode via
`__PSLockdownPolicy=4` still reported `FullLanguage`, so it was not reproduced.
The next GOATBOX run decides it. No GOATBOX services, keys, payload or disks were
touched, and no admission ticket has been issued.
