import { WINDOWS_CREDENTIAL_DELETE_SCRIPT } from "./windows-credential-delete.js";

/** The OS identity is read inside each helper, never from caller-provided
 * environment values. Only its domain-separated digest leaves that process. */
export const WINDOWS_CREDENTIAL_CUSTODY_FUNCTIONS = String.raw`
function Get-GoatCredentialCustodyDigest([string]$MachineId, [string]$UserSid, [string]$Resource) {
  $guid = [Guid]::ParseExact($MachineId, 'D')
  if ($guid -eq [Guid]::Empty -or $UserSid.Length -gt 184 -or $UserSid -cnotmatch '^S-1-[0-9]+(-[0-9]+)+$' -or $Resource -cne 'goatcitadel') {
    throw 'Invalid credential custody identity.'
  }
  $material = 'goatcitadel.windows-credential-custody.v1' + [char]0 + $guid.ToString('D') + [char]0 + $UserSid + [char]0 + $Resource
  $hash = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($material))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}
function Get-GoatCurrentCredentialCustody {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  try { $sid = $identity.User.Value } finally { $identity.Dispose() }
  $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
  try {
    $key = $registry.OpenSubKey('SOFTWARE\Microsoft\Cryptography', $false)
    if ($null -eq $key) { throw 'Credential custody identity is unavailable.' }
    try { $machineId = $key.GetValue('MachineGuid') } finally { $key.Dispose() }
  } finally { $registry.Dispose() }
  return Get-GoatCredentialCustodyDigest $machineId $sid $env:GOATCITADEL_SECRET_SERVICE
}
function Test-GoatCredentialCustody([string]$Expected) {
  if ($Expected -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid credential custody binding.' }
  return [String]::Equals((Get-GoatCurrentCredentialCustody), $Expected, [StringComparison]::Ordinal)
}
`;

export const WINDOWS_CREDENTIAL_CUSTODY_READ_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
${WINDOWS_CREDENTIAL_CUSTODY_FUNCTIONS}
try { Get-GoatCurrentCredentialCustody }
catch { [Console]::Error.WriteLine('Windows credential custody is unavailable.'); exit 1 }
`;

// The guard must precede PasswordVault construction in both mutation scripts.
const CUSTODY_GUARD = String.raw`
$ErrorActionPreference = 'Stop'
${WINDOWS_CREDENTIAL_CUSTODY_FUNCTIONS}
try {
  if (-not (Test-GoatCredentialCustody $env:GOATCITADEL_SECRET_CUSTODY)) {
    Write-Output 'custody_mismatch'
    exit 4
  }
} catch { [Console]::Error.WriteLine('Windows credential custody is unavailable.'); exit 1 }
`;

export const WINDOWS_CREDENTIAL_CUSTODY_DELETE_SCRIPT = CUSTODY_GUARD + WINDOWS_CREDENTIAL_DELETE_SCRIPT;

export const WINDOWS_CREDENTIAL_CUSTODY_WRITE_FUNCTION = String.raw`
function Add-GoatOwnedCredential($Vault, $Credential, [string]$Secret) {
  $missing = -2147023728
  $exists = $false
  try { $null = $Vault.Retrieve($Credential.Resource, $Credential.UserName); $exists = $true }
  catch { if ($_.Exception.GetBaseException().HResult -ne $missing) { throw } }
  if ($exists) { throw 'Immutable credential slot is already occupied.' }
  $null = $Vault.Add($Credential)
  $saved = $Vault.Retrieve($Credential.Resource, $Credential.UserName)
  $null = $saved.RetrievePassword()
  if (-not [String]::Equals($saved.Password, $Secret, [StringComparison]::Ordinal)) {
    throw 'Credential write verification failed.'
  }
  return 'ok'
}
`;

export const WINDOWS_CREDENTIAL_CUSTODY_WRITE_SCRIPT = CUSTODY_GUARD + String.raw`
${WINDOWS_CREDENTIAL_CUSTODY_WRITE_FUNCTION}
try {
  [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
  [Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
  $secretValue = [Console]::In.ReadToEnd()
  if ([String]::IsNullOrWhiteSpace($secretValue)) { throw 'Credential value is required.' }
  $vault = [Windows.Security.Credentials.PasswordVault]::new()
  $credential = [Windows.Security.Credentials.PasswordCredential]::new($env:GOATCITADEL_SECRET_SERVICE, $env:GOATCITADEL_SECRET_ACCOUNT, $secretValue)
  Add-GoatOwnedCredential $vault $credential $secretValue
} catch { [Console]::Error.WriteLine('Windows credential write failed.'); exit 1 }
`;
