# GOATBOX failed broker installation recovery

GOATBOX's September 17 failed install report is
`C:\worker-evidence\broker-install-20260917-134914\broker-coordinator-install-evidence.json`.
It reports service permission mismatch and two access-denied rollback deletions.
Read-only operator checks confirm both exact services stopped, demand-start,
LocalSystem, with their expected paths under
`C:\ProgramData\GoatCitadel\RemoteWorkerProvisioner\bin`. That provisioner
directory is absent. These are orphan service registrations, not running services.

The installer expected administrator mask `0x120035`; GOATBOX retained `0x20035`.
The difference is `SYNCHRONIZE`, which is outside the documented service rights.
See [Microsoft service access rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights).
The corrected recipe and native validators require exactly `0x20035`; broker
service-open requests no longer request the unsupported bit. File, process and
event synchronization access remains unchanged.

Fresh-install rollback now retains the original CreateService handle with deletion
access across permission hardening. It verifies stopped state before deleting the
same SCM object, and preserves payload files if service deletion is uncertain.
This does not retroactively recover handles from the failed GOATBOX process.

## Read-only recovery preflight

Copy `scripts/remote-worker/recover-orphaned-broker-services.ps1` from the development
checkout to `C:\worker-recovery\recover-orphaned-broker-services.ps1` on GOATBOX,
outside the inventoried package. Retain the hash supplied in the handoff.
In Administrator PowerShell:

```powershell
$recovery = @{
  PackageRoot = 'C:\worker-candidates\controller-signed'
  EvidencePath = 'C:\worker-evidence\broker-install-20260917-134914\broker-coordinator-install-evidence.json'
}
& 'C:\worker-recovery\recover-orphaned-broker-services.ps1' @recovery
```

Default mode only reads. It validates failed local evidence, absent payload,
exact configuration, stopped/no-PID status and exact security for each named
service. A refusal requires investigation; do not weaken the checks.

## Apply after reviewing a passing preflight

Adding `-Apply` to the same command removes only these two verified orphan service
registrations. It holds the original SCM objects open, enables the administrator
take-ownership privilege, takes ownership, and grants the elevated administrator
DELETE on each verified service before deleting it. It performs no file, disk,
service-start or provider operations. An interrupted recovery may leave a partially
changed service descriptor; report any failure rather than improvising cleanup.

This recovery mechanism compiled under PowerShell 5.1 and 7 and its validation
function passed controlled exact-identity and six refusal cases with no service
mutations. Its privileged deletion has not been executed locally. Successful
GOATBOX recovery requires the final report that both registrations are absent.
Only then run replacement-package preflight with a fresh evidence directory.
Close the old PowerShell window and open a fresh Administrator PowerShell before
using the replacement installer. The old window may still hold the failed
candidate's compiled native helper type; a package copy does not unload it.
