# GOATBOX worker installation

**Latest diagnostic, September 17 at 20:46 local:** the signer alone reached
RUNNING in 27 ms and stayed healthy for twelve seconds; the broker stayed stopped
as intended. Initial service configuration query sizes were 398/462 bytes, and
the signer token matched its contract. Its process DACL included both worker and
broker query/wait grants. Evidence:
`C:\worker-evidence\signer-client-boundary-20260917-204625-907.json`.
The observer could query/wait and read token information, but could not read the
token object's security descriptor. This does not prove native-client access.

A separate local regression reproduced an authentication blocker in the shared
client/server token collector: an empty `TokenRestrictedSids` result is 8 bytes on
x64, while the collector required `sizeof(TOKEN_GROUPS)` (16 bytes, including a
placeholder entry). The corrected check requires only `offsetof(TOKEN_GROUPS,
Groups)` for the header, still rejects nonzero restricted groups and invalid
handles, and retains all other caller-role/token/image/pipe checks. Before the
fix the valid empty query failed; after it, empty acceptance and restricted-token
refusal both pass. The installed signer already used this header-size rule.
The native client and service share this collector and must be updated together
with the broker's embedded signer hash. No keys or service registrations need
to be recreated. The exact prior failing authentication stage was not logged;
the corrected public inspection still requires a GOATBOX retry.

## Current handoff: client token-query correction

Copy the whole ZIP
`F:\code\personal-ai\.tmp\GoatCitadel-GOATBOX-client-token-fix.zip` to
`C:\worker-candidates\GoatCitadel-GOATBOX-client-token-fix.zip` on GOATBOX.
It is 40,019,494 bytes; all 1,782 ZIP files were verified against staging.
Use a fresh Administrator Windows PowerShell window:

```powershell
& {
  $ErrorActionPreference='Stop';
  if ($env:COMPUTERNAME -ne 'GOATBOX') { throw 'GOATBOX only.' };
  $zip='C:\worker-candidates\GoatCitadel-GOATBOX-client-token-fix.zip';
  $destination='C:\worker-candidates\client-token-fixed';
  if ((Get-FileHash -LiteralPath $zip).Hash -ne '160d2d6c6587c5ed9dbff527c53bb897f9ffd92d7617e36259b61b405f0b1392') { throw 'ZIP hash mismatch. Stop.' };
  if (Test-Path -LiteralPath $destination) { throw 'Destination already exists. Preserve it and paste this message back.' };
  Expand-Archive -LiteralPath $zip -DestinationPath $destination;
  $launcher=Join-Path $destination 'Run-GOATBOX-Client-Token-Fix.ps1';
  if ((Get-FileHash -LiteralPath $launcher).Hash -ne '95977959ddfd196d84dc411cd31bfbff2a40ae185fd6f5dd94fb5c5a55a7a21a') { throw 'Launcher hash mismatch. Stop.' };
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -Apply;
  if ($LASTEXITCODE -ne 0) { throw 'Preserve the output and paste it back. Do not repeat the update.' };
}
```

The repair requires both services already stopped, verifies the existing three
image hashes/configurations/protected directory descriptors, and obtains exclusive
update handles. It durably backs up all three images and the prepared receipt,
replaces through those handles, verifies bytes and file identity/security, and
restores originals on caught failure. Existing keys/state and service registrations
are retained; no disk provisioning or formatting occurs. This is not crash-atomic
across three files; preserve backups for operator-directed power-loss recovery.

The launcher starts the broker once and observes both services at approximately
three and twelve seconds. Only if both are still RUNNING does it request public
INSPECT once and print/save the result. No keyset is created. Paste all output
back, including `inspectionPassed` and the final service states. Do not rerun an
older diagnostic or repair. Manifest:
`d80b8d70375b40962947689e2cfc4787ae28aa9dc64a8ebc9e0fed3c5559256b`.

Validation: native ASan and two-clean-build identity passed; package verification
passed 34 tests and its foreground probe. The updated maintenance helpers passed
26 tests in PowerShell 5.1/7, including third-image failure rollback, unchanged
state fixtures and default refusal of client writes without the explicit client
replacement entry point. Launcher public-output/error handling and host guards
passed. Installed client authentication remains pending; broader historical
native test fixture-pin failures remain recorded separately.

## Earlier diagnostic history

**September 17 at 20:38:22 local:** public custody inspection
failed with native client exit 5 and no stdout/stderr. Subsequent SCM queries
showed signer stopped at 1066/6 (`ProtocolInvalid`) and broker stopped at 1066/3
(`TargetIdentity`). Both failures were logged at 20:38:22. The event-log text
"The handle is invalid" and "The system cannot find the path specified" is
Windows' generic numeric mapping, not a precise native failure location.
Keyset state remains unknown. Do not repeat the inspection or reinstall.

Next diagnostic: `scripts/remote-worker/read-signer-client-boundary.ps1`,
33,628 bytes, SHA-256
`3f7606976aab86b304ed0edf1e1afe1e81aec0e967983d7156d2bf4afb1ec662`.
Copy to `C:\worker-recovery\read-signer-client-boundary.ps1`; verify its hash and
run with `-StartOnce` in Administrator PowerShell. It pins all three current
images, requires the exact observed stopped failure states, starts only the signer
once and records twelve seconds of SCM/process/token metadata. The broker stays
stopped; no client protocol connection, key creation or custody-content read is
performed. Initial configuration query byte counts are included. Administrator
observer access does not establish native-client access. Five local tests passed;
GOATBOX diagnostic output is pending. Without `-StartOnce` this is preflight only.

**Previous result, September 17 at 20:25 local:** the retained-state update passed
on GOATBOX. The saved receipt reports `apply/passed`, three verified images,
five verified protected directories, empty refusals and rollback failures,
`serviceRegistrationsChanged=false` and `stateContentsAccessed=false`. Both the
broker (PID 6744) and signer (PID 9396) were RUNNING with zero exit codes at the
three- and twelve-second observations. Evidence directory:
`C:\worker-evidence\broker-inspection-update-20260917-202531-523`.
This establishes physical broker/signer startup across those observations;
worker/controller installation and enrollment remain open. Do not rerun the
update or remove the protected state.

The printed null summary fields were a Windows PowerShell 5.1 dictionary
projection bug; the persisted receipt contained the correct fields. Source now
casts the ordered dictionary to `PSCustomObject` before selecting display fields.
A regression reproduced the null console output while its saved receipt passed;
all 13 maintenance tests now pass, including console/receipt agreement in both
PowerShell versions. This display-only correction requires no GOATBOX reinstall.
The previously transferred ZIP remains unchanged for evidence integrity.

**Previous result, September 17 at 19:55 local:** the signer stayed RUNNING for
the complete twelve-second observation, while the broker stopped with target
identity code 3. Its process DACL lacked the broker's required query/wait grant.
The administrator observer's successful reads did not establish broker access.
Evidence: `C:\worker-evidence\broker-target-observation-20260917-195519-095.json`.

The corrected signer grants only its validated broker SID process query/wait
(`0x101000`) and token query (`0x8`). Controller grants remain unchanged; explicit
denies, unexpected masks and duplicate broker grants are refused. The captured
process descriptor reproduced denied broker access locally; 794 focused native
checks now pass. Token-object security was unavailable in the GOATBOX report;
the token grant is a required narrow counterpart, not an observed token-DACL claim.

## Completed handoff: preserve state and update two executable files

Historical procedure, completed successfully at 20:25. Do not execute it again.

Copy the **whole ZIP** from
`F:\code\personal-ai\.tmp\GoatCitadel-GOATBOX-broker-inspection-fix.zip`
to `C:\worker-candidates\GoatCitadel-GOATBOX-broker-inspection-fix.zip` on GOATBOX.
It is 40,018,573 bytes. All 1,782 archive files were checked against staging.
The ZIP includes the complete replacement payload plus the maintenance helpers.
Do not merge it into an earlier package folder or run an old uninstall recipe.

Run in GOATBOX's Administrator Windows PowerShell. Semicolons preserve command
boundaries when copying collapses lines:

```powershell
& {
  $ErrorActionPreference='Stop';
  if ($env:COMPUTERNAME -ne 'GOATBOX') { throw 'GOATBOX only.' };
  $zip='C:\worker-candidates\GoatCitadel-GOATBOX-broker-inspection-fix.zip';
  $destination='C:\worker-candidates\broker-inspection-fixed';
  if ((Get-FileHash -LiteralPath $zip).Hash -ne '67edcc7227c7e19508888bfe7931ba60c5740b5ec385e3baa49bffde17e0ebf5') { throw 'ZIP hash mismatch. Stop.' };
  if (Test-Path -LiteralPath $destination) { throw 'Destination already exists. Preserve it and paste this message back.' };
  Expand-Archive -LiteralPath $zip -DestinationPath $destination;
  $launcher=Join-Path $destination 'Run-GOATBOX-Broker-Inspection-Fix.ps1';
  if ((Get-FileHash -LiteralPath $launcher).Hash -ne '763274b0213a3655dcde9459b5eff6506b5f7543c98ab81ef48a723bf46dd042') { throw 'Launcher hash mismatch. Stop.' };
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -Apply;
  if ($LASTEXITCODE -ne 0) { throw 'Preserve the output and paste it back. Do not repeat the update.' };
}
```

The helper requires both services already stopped, verifies their configurations,
pins existing directories and files, and checks all package hashes. Preflight
tests exclusive update access without changing executable bytes. Apply saves both
original images and a prepared receipt before writing through the existing file
handles. It verifies bytes, file identity and security after each write and rolls
back caught failures. State contents are neither read nor modified; the five
protected directory identities and descriptors are checked through held handles.
The client and service registrations are retained. No disks are operated on.
Power-loss recovery is operator-driven from the backups; the two-file update is
not a crash-atomic transaction. Preserve its evidence and backups.

After success the launcher starts the broker once and prints both service states
at approximately three and twelve seconds. Paste all output back; do not repeat
the update. The 20:25 result above establishes broker/signer startup;
worker/controller enrollment remains pending. The new payload manifest is
`beafa81d55ade7d82274c86a0ab0c1ce2dc8a88685adb400dd2fdde04018eab2`.

Local verification: native clean-build/ASan receipt passed; package verification
passed 34 tests plus the foreground worker probe; 13 repair tests passed across
PowerShell 5.1/7, including real temporary-file replacement/rollback and mocked
SCM running-service refusal. The broader native packaging suite passed 45/47:
its x64 and ARM64 fixed client size/hash expectations still name older client
builds. Those two failures are not reported as green. GOATBOX subsequently
confirmed successful update and startup as recorded above.

## Earlier installation history (do not repeat these procedures)

**September 17 at 19:36 local:** the protected state repair passed
preflight, uninstall and install with empty refusals/cleanup failures, and all
five protected directories passed read-back. The signer reached `RUNNING` with
both exit codes zero (PID 7008). The availability broker stopped with Win32 1066,
service code 3 (`TargetIdentity`). Evidence uses
`C:\worker-evidence\state-repair-<stage>-20260917-193654-022`. This establishes
physical signer startup; it does not establish working broker supervision or
worker/controller enrollment. The signer has a bounded idle lifetime, so this
snapshot does not establish its current state. Preserve the installed state and
use the current handoff above. Do not repeat the repair or an older replacement.

**Previous result, September 17 at 19:09 local:** the self-image-fix package was
verified and installed with no refusals or cleanup failures. The broker stopped
with code 3 and the signer with `CustodyOrJournal` code 9. The signer reached
protected recovery after its identity, inspection, image and Ed25519 self-test
checks. A subsequent read-only directory listing showed only `bin` (attributes
8208), confirming that the installer had never created the required `state-v1`
tree. Install evidence: `C:\worker-evidence\self-image-fix-install-20260917-190911-790`.
That missing state was repaired in the 19:36 run above. Retain
`self-image-fixed\payload`; do not create custody directories manually.

**September 17 acceptance:** the first controller-signed candidate
is superseded for installation. GOATBOX exposed an unsupported service
`SYNCHRONIZE` permission expectation and failed rollback deletion. Its two service
registrations were removed by scoped recovery. The corrected broker/signer install
then passed on GOATBOX, with no refusals or cleanup failures, in
`C:\worker-evidence\broker-fixed-install-20260917-140551`. Both services were verified
stopped by the installer. The subsequent broker start failed with its own
`ServiceIdentity` code 2. A read-only Win32 query on GOATBOX reproduced a successful
empty-trigger response with `pcbBytesNeeded=0`; the native collector incorrectly
treated this failure-only output as a success response length. The startup fix
uses the actual bounded allocation, preserves exact configuration/security
checks, and checks SCM process identity in the RUNNING phase. The signer shared
the same query defect and is fixed too. Do not rerun installation over the existing
services; use the replacement handoff's uninstall preflight first.
After recovery, open a fresh Administrator PowerShell window so the old native
installer helper is not reused.

**Previous replacement result, 18:35 local:** logon-owner-fix verification,
preflight, uninstall and install passed with no refusals or cleanup failures.
Evidence uses `C:\worker-evidence\logon-owner-fix-<stage>-20260917-183559-524`.
Both services stopped after the single broker start with service code 3. For the
broker this means target failure; for the signer it means `ProtectedImage`.
The signer's old `0x46040000` inspection refusal was not reported. Code 3 spans
initial path resolution, image/layout checks and the cryptographic self-test,
so this result alone does not identify the precise failing stage or prove that
inspection ACL publication completed. Do not rerun the logon-owner-fix launcher.

A source-grounded regression reproduced a definite blocker in that candidate:
`QueryProcessPath` rejects `GetCurrentProcess()` as `INVALID_HANDLE_VALUE` before
calling Windows. That pseudo-handle is valid for process queries, and startup
passes it for both self-image reads. The replacement corrects the same mistaken
guard in path, creation-time, liveness and client self-identity capture. Exact
image/path/token checks and permissions remain unchanged. The regression compares
the own-process path and creation time against Windows queries, checks retained
real-handle behavior, and rejects non-process handles, missing inputs and a
mismatched expected path. Protected client capture must still refuse the local
non-administrator test process. Its fully elevated success branch and physical
startup require installed acceptance.

The operator's subsequent read-only report showed the expected principals and
masks, ordinary directory/file attributes and only unnamed streams in the signer
and client images. `Get-Acl` uses a managed ACL representation that can reorder
same-type allow ACEs; a local in-memory comparison reproduced that ordering.
It is not evidence that the installed raw ACE order differs. No permission or
owner change follows from that report.

**Previous replacement result:** service-owner-fix package verification, replacement preflight,
uninstall and install all passed with empty refusals and cleanup failures. Evidence
directories are `C:\worker-evidence\service-owner-fix-preflight-20260917-164800-877`,
`C:\worker-evidence\service-owner-fix-remove-20260917-164800-877` and
`C:\worker-evidence\service-owner-fix-install-20260917-164800-877`. The signer passed
its initial SCM/token identity checks and stopped at `1174667264` (`0x46040000`):
process inspection ACL composition refused its existing object owner. The owner
is neither SYSTEM, built-in Administrators nor the signer's exact service SID;
the diagnostic does not identify its exact SID. No process/token ACL was changed: both descriptors must be prepared
before either is written, and process composition failed first. The broker stopped
with target-failure code 3. Both services are stopped. The decoded result is in
`C:\worker-evidence\service-owner-fix-startup-20260917-164800-877.json`.
Do not repeat the replacement.

**Previous observation, 18:15 local:**
`C:\worker-evidence\broker-owner-observation-v2-20260917-181521-752.json`
captured the availability broker in session zero, with process owner
`S-1-5-5-0-344967097`, SYSTEM token user and SYSTEM token default owner. Its own
token contained the identical logon SID with attributes `0xc000000f`: logon ID,
enabled, enabled by default, mandatory and owner-eligible. The observer's logon
SID was different and lacked the owner flag (`0xc0000007`). Its token-object owner
could not be read by the diagnostic (READ_CONTROL denied, Win32 5). No signer
sample was captured within the capped observation; poll counts were 40,000 and 31
for signer and broker. The broker was START_PENDING, so the matching SCM PID is
not documented-valid identity proof. Both services stopped again at their previous
codes: signer `0x46040000`, broker 3. This establishes the broker's own logon SID
as its observed process owner; it does not establish the signer's owner.

The replacement candidate adds this documented owner form to the shared signer/
controller check. It accepts a logon owner only when it exactly matches the unique
logon SID collected from that service's own validated SYSTEM primary token, has
both enabled and owner-eligible flags, and has no unsupported flags. The same
bounded token-group read must independently contain the exact role's enabled,
owner-eligible service SID. A caller cannot supply the accepted logon identity;
another service's or prior session's logon SID remains refused. SYSTEM and the
exact service SID remain supported owners. Worker, Administrators, arbitrary
owners, duplicate or malformed groups, and ineligible logon owners are refused
before either inspection DACL is written. No owner, privilege, existing ACE or
inspection mask is changed. Windows documents the
[logon and owner flags](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_groups)
and distinguishes an [object's owner](https://learn.microsoft.com/en-us/windows/win32/secauthz/owner-of-a-new-object)
from its token's user and default owner. The installed logon-owner-fix candidate
now reports the broader code 3, as described above; signer owner identity and
successful startup have not yet been independently established.

The installer intentionally limits the service to `SeChangeNotifyPrivilege`, so
SCM removes its other privileges. Filtering history is not evidence of restricting
SIDs. The corrected collector uses `IsTokenRestricted`, checks its error result,
and independently retains the zero restricting-SID count, exact enabled privilege,
SYSTEM identity, service SID, session, SCM configuration and ACL requirements.
See Microsoft's [service privilege rules](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_required_privileges_infow)
and [token restriction query contract](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-istokenrestricted).
The token-filtering correction has passed its initial identity check on GOATBOX;
the 19:36 state repair subsequently established signer startup.

The controller-signed installation path is integrated in source. Local tests cover
protected RPC, native signing, capacity checks, joined shutdown and retained
outcomes. GOATBOX broker/signer installation has passed; worker/controller installation,
protected enrollment and execution remain unverified.

Signer builds with startup diagnostics report the failed identity check through
SCM's `SERVICE_EXIT_CODE`. They expose only a numeric reason, without writing
token contents or credentials:

| Code | Failed check |
|---|---|
| 2001–2002 | Opening SCM or the fixed signer service |
| 2010–2011 | Collecting service configuration or security descriptor |
| 2020–2030 | Token collection: open, user, type, session, restrictions, AppContainer, restricted SIDs, groups, privileges, privilege lookup, thread token |
| 2040 | Current process identity |
| 2041–2042 | Service configuration or required privilege list |
| 2043 | Token execution context, AppContainer, ambient token or restricted SIDs |
| 2044 | Restricting-SID status; the earlier diagnostic candidate incorrectly used filtering history |
| 2045–2046 | Token bounds or service DACL structure |
| 2047–2050 | SYSTEM identity, signer SID attributes, prohibited logon SID or service group counts |
| 2051–2053 | Actual token privilege, service ACE count or exact ACE contents |
| 2060 | Legacy combined result for granting read-only worker inspection access |

The inspection diagnostic encodes a refusal as
`0x40000000 | (stage << 24) | (reason << 16) | win32Error`. The handoff launcher
decodes these fields into readable labels. Stages distinguish token opening and
identity, original process/token descriptor reads and composition, then each
before/write/readback check. Reasons distinguish API errors, malformed descriptors,
unexpected owners (including a separate built-in Administrators classification),
unsupported ACL/ACE forms, worker-grant mismatch and descriptor changes. This
candidate also reports reason 13 for a logon-owner mismatch and reason 14 for
missing or unsupported owner-eligibility flags. These diagnostics expose no
additional owner, ACE or permission to the worker.
Error `0xffff` means a Win32 error did not fit the bounded field; it is not a
truncated error code. No SID, ACL or credential contents are emitted.

The broker's separate target-failure code 3 can also occur while the signer is
healthy and RUNNING, as the 19:36 report shows. It spans snapshot collection,
status/configuration checks, held-image revalidation and process/token inspection;
the code alone does not isolate the refusal.

GOATBOX is Windows 11 Pro x64. Its installed executables are the self-image-fix
trio. Retain `C:\worker-candidates\self-image-fixed\payload`; the repair verifies
and reuses this package. Its manifest SHA-256 is
`7d49ac3eae7c2c0435b2838a2fea8e4ff494454d2b06f175e176fe67d5076eda`.
The original package, 1,773 files and 105,904,252 bytes, passed its native ASan,
reproducibility and portable execution checks. Those checks did not establish
SYSTEM-owned installed startup. The earlier intermittent native handle-count
failure remains recorded; no assertion was relaxed.

## Completed target observation (historical; do not rerun)

The following records the procedure already completed at 19:55. Its result and
the next handoff are at the top of this document.

Copy the single `Read-GOATBOX-Broker-Target.ps1` handoff file into
`C:\worker-recovery` on GOATBOX. It is a standalone diagnostic, not a replacement
package. Source: `scripts/remote-worker/read-broker-target-diagnostic.ps1`.
The 33,228-byte handoff is at
`.tmp/worker-goatbox-broker-target-observation-20260917/Read-GOATBOX-Broker-Target.ps1`,
SHA-256 `4917f56095bca068c1a51d9d0820271cc0d079cb267ad8922504aaa82aebe2b0`.
Verify this hash before running it with `-StartOnce` in a fresh Administrator
PowerShell process:

```powershell
& {
  $ErrorActionPreference = 'Stop';
  if ($env:COMPUTERNAME -ne 'GOATBOX') { throw 'Run this on GOATBOX only.' };
  $scriptPath = 'C:\worker-recovery\Read-GOATBOX-Broker-Target.ps1';
  if ((Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash -ne '4917f56095bca068c1a51d9d0820271cc0d079cb267ad8922504aaa82aebe2b0') {
    throw 'Diagnostic hash mismatch. Stop.';
  };
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -StartOnce;
  if ($LASTEXITCODE -ne 0) { throw 'Diagnostic failed. Preserve its output and stop.' };
}
```

The diagnostic verifies and retains read-only handles to the exact installed
self-image-fix trio, checks their final paths and the fixed service configurations,
then issues one no-argument broker start. The broker must already be stopped;
the signer may be healthy and stopped or already RUNNING. A failed signer is
refused with its current codes. Without `-StartOnce` this is read-only preflight.

Two observers record at most 64 distinct SCM statuses per service for twelve
seconds, including exit codes, checkpoint, wait hint, flags and PID. Signer
process/token inspection is attempted only after RUNNING is observed. The report
records exact process query/synchronize access, security descriptors when readable,
SYSTEM identity, token type/session/restrictions, service groups and privilege
checks. Unavailable security reads remain explicit errors. It writes a fresh
`C:\worker-evidence\broker-target-observation-<timestamp>.json` and prints it.

This runs in the administrator observer's context; a successful query does not
prove access from the broker's token. Status classification is diagnostic only,
not full broker identity verification. Windows documents both the
[SCM PID validity boundary](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-queryservicestatusex)
and [token query access checks](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocesstoken).
The script does not open custody contents, change privileges or permissions,
install/remove/stop services, or operate on disks. Paste its report back once;
do not repeat the startup attempt.

Local verification passed seven tests, including real own-process/token/path
queries, mismatched-path refusal, 28 status/token classification cases in each
PowerShell engine and rejection of another host before service access. The
GOATBOX observation and actual broker failure remain pending.

## Completed state repair: retained history, do not rerun

Copy this whole small ZIP to `C:\worker-candidates\GoatCitadel-GOATBOX-state-repair.zip`:

```text
F:\code\personal-ai\.tmp\worker-goatbox-state-repair-20260917\GoatCitadel-GOATBOX-state-repair.zip
```

ZIP SHA-256: `98b0260aec46cfaba5cd93d4583529e406e7e071f8d927e0b01997dead19c599`.
The archive is 37,703 bytes, containing five repair sources and the launcher;
all six entries were read back and hash-verified. It contains no replacement
executables. Launcher SHA-256:
`a77fd532de2db11df772ab442bcf746aebd8aa5ade45f95b42eaf4a7f6ca68c7`.

The updated installer exclusively creates `state-v1` with `journal`, `keysets`,
`controls` and `quarantine`, using the native signer's exact SYSTEM owner/group,
SYSTEM+signer-only protected DACL and directory-only attributes. It reads these
back before service registration. Existing state is refused; rollback only
removes owned empty directories through their retained creation handles.
Nonempty state is preserved. The image-only uninstaller explicitly refuses
custody state before mutating services. A future state-preserving upgrade must
use a separately verified path.

All 19 installer checks passed, including 32 existing filesystem/refusal cases
and eight new state cases in each PowerShell engine. The new cases use real
Windows APIs under a temporary current-user owner; SYSTEM ownership and live
startup required the GOATBOX retry, which reached signer RUNNING at 19:36.
Both engines also passed launcher syntax and
all 280 existing diagnostic mappings.

The launcher verifies GOATBOX, elevation, every retained package file, its five
repair sources, the exact installed trio hashes and stopped services. It runs
the protected uninstall preflight, reinstalls the same binaries with the missing
state layout, and starts only the availability broker once. Recreating the
registrations clears SCM's retained failed-start metadata, which the broker
otherwise refuses. Without `-Apply`, the launcher stops after preflight. No disk,
volume, VHD, partition or formatting operation is performed.

In Administrator PowerShell on GOATBOX:

```powershell
& {
  $ErrorActionPreference = 'Stop';
  if ($env:COMPUTERNAME -ne 'GOATBOX') { throw 'Run this on GOATBOX only.' };
  $zip = 'C:\worker-candidates\GoatCitadel-GOATBOX-state-repair.zip';
  $destination = 'C:\worker-candidates\state-repair';
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne '98b0260aec46cfaba5cd93d4583529e406e7e071f8d927e0b01997dead19c599') {
    throw 'ZIP hash mismatch. Stop.';
  };
  if (-not (Test-Path -LiteralPath $destination)) {
    Expand-Archive -LiteralPath $zip -DestinationPath $destination;
  };
  $launcher = Join-Path $destination 'Run-GOATBOX-State-Repair.ps1';
  if ((Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash -ne 'a77fd532de2db11df772ab442bcf746aebd8aa5ade45f95b42eaf4a7f6ca68c7') {
    throw 'Launcher hash mismatch. Preserve this folder and stop.';
  };
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -Apply;
  if ($LASTEXITCODE -ne 0) { throw 'Repair failed. Preserve the output and stop.' };
}
```

Paste the full output, including both service states/codes and any inspection
diagnostic. The install output must include `Protected state directories verified: 5`.
Recipe evidence uses `C:\worker-evidence\state-repair-<stage>-<timestamp>`;
an inspection refusal also writes `state-repair-startup-<timestamp>.json` there.
Do not repeat the repair after it has removed the old installation.

## Inputs required before preflight

The operator confirmed all four files below are absent on GOATBOX. Do not run
worker installation yet. This checkout's `.env` and the agent process also have
none of the remote-worker TLS enablement/listener/trust settings; that inspection
does not establish the configuration of a separately launched Gateway process.

First read public metadata from the installed signer using
`scripts/remote-worker/read-protected-enrollment-state.ps1` (2,864 bytes, SHA-256
`4b3fd7fb6f0ff160eea0ab8958b08d6fb88b1a000648690a8c054afd7ae55e23`).
Copy it to `C:\worker-recovery\read-protected-enrollment-state.ps1` and verify its
hash before running in Administrator PowerShell. It validates the retained package
inventory and installed client hash, holds that client read-only, and calls only
the existing public INSPECT operation. Output contains public key references and
generation/capacity metadata, never private key bytes. No key creation or service
control occurs. Four focused tests passed, covering fixed-path/public projection,
bigint serialization, mutation exclusions and wrong-host refusals in both shells.
Live inspection and subsequent keyset/certificate/ticket preparation remain pending.

The existing Gateway enrollment and protected-key owners must supply these files
in `C:\worker-inputs`, outside the package:

- `client-cert.pem`: worker's public client certificate.
- `ca.pem`: trusted Gateway CA certificate.
- `ticket.json`: current admission ticket with its public signer reference.
- `protected-key.json`: the protected TLS signing-key reference, never a private PEM.

Use the actual configured protected Gateway TLS listener and its certificate name.
The development PC's LAN address was `192.168.0.219`, but neither that address nor
an example port proves a reachable, certificate-valid worker listener. Enrollment,
signer custody and network reachability must be established before service start.
No credentials should be pasted into chat.

## Preflight on GOATBOX

Open **Windows PowerShell as Administrator**. This recipe requires elevation for
its access checks even in preflight. Supply the independently retained hash and
configured listener when prompted:

```powershell
$candidate = 'C:\worker-candidates\broker-inspection-fixed\payload'
$manifestHash = Read-Host 'Expected manifest SHA-256 from the build handoff'
$gatewayName = Read-Host 'Configured protected Gateway TLS host name'
$gatewayPort = [int](Read-Host 'Configured protected Gateway TLS port')
$evidenceRoot = Join-Path 'C:\worker-evidence' ('controller-signed-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$workerArgs = @{
  Target = 'windows-x64'
  PackageRoot = $candidate
  ManifestSha256 = $manifestHash
  GatewayHost = $gatewayName
  GatewayPort = $gatewayPort
  ClientCertificateFile = 'C:\worker-inputs\client-cert.pem'
  TrustAnchorFile = 'C:\worker-inputs\ca.pem'
  TicketFile = 'C:\worker-inputs\ticket.json'
  ProtectedKeyFile = 'C:\worker-inputs\protected-key.json'
  OutputRoot = "$evidenceRoot-worker-preflight"
}
& "$candidate\app\install\install-worker-service.ps1" @workerArgs -Preflight
if ($LASTEXITCODE -ne 0) { throw 'Worker preflight refused or failed; retain its evidence.' }

```

These commands inspect inputs, package inventory, permissions and existing service
state, and write fresh evidence directories. They do not install or start a service,
create a persistent signing key, create a VHD, mount a volume or format a drive.
Do not delete an existing footprint to get past a refusal.

## Installation after successful preflight

The installation targets are fixed by the recipes under
`C:\ProgramData\GoatCitadel`; inspect the preflight evidence before proceeding.
In the same elevated PowerShell session, installation uses the same reviewed inputs:

```powershell
$workerArgs.OutputRoot = "$evidenceRoot-worker-install"
& "$candidate\app\install\install-worker-service.ps1" @workerArgs
if ($LASTEXITCODE -ne 0) { throw 'Worker installation failed; retain evidence and stop.' }
```

Proceed here only after broker replacement and startup have passed. Worker
installation creates protected files, service registrations and a fresh,
non-exportable controller signing key. Services remain stopped. It performs no
disk formatting or cell provisioning. Retain any partial failure for inspection;
an uncertain installation is not permission to delete keys or repeat installation.

Collect `controller-signing-enrollment.json` from the worker install evidence
directory. It contains the public key, key hash and custody binding, not the private
key. Independently inspect it from this GOATBOX installation. The Gateway's runtime
installation review accepts only its `publicPointHex` and `keySha256` as
`controllerEnrollment`, alongside the exact package and runtime bundle. Approval
and retention use the existing operator approval lifecycle; worker RPC cannot
approve its own key.

## Installed acceptance remains a separate step

Do not start the services or dispatch native work merely because installation
succeeded. Protected signer/enrollment readiness, the reviewed cell backing-file
and directory targets, complete-pool authority and the installation approval must
be established first. No physical-disk selector or generic formatting command is
part of this handoff. Native provisioning and its precise targets require a
separate reviewed acceptance run.

The resulting run must demonstrate current protected contact, controller signature
verification, approved capture/copy, terminal verification, joined shutdown and
retained outcome. Failed or uncertain attempts use read-only recovery; they do not
silently recopy. Successful local fixtures and a verified package do not establish
these installed-host results.
