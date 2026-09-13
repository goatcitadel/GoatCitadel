/** Kept separate so the exact PowerShell branch logic can run against synthetic
 * vault objects without accessing the operator's Credential Locker. */
export const WINDOWS_CREDENTIAL_DELETE_FUNCTION = String.raw`
function Remove-GoatCredential($Vault, [string]$Resource, [string]$Account) {
  $missing = -2147023728 # HRESULT_FROM_WIN32(ERROR_NOT_FOUND), 0x80070490
  try {
    $credential = $Vault.Retrieve($Resource, $Account)
  } catch {
    if ($_.Exception.GetBaseException().HResult -ne $missing) { throw }
    return 'absent'
  }
  $null = $Vault.Remove($credential)
  try {
    $null = $Vault.Retrieve($Resource, $Account)
  } catch {
    if ($_.Exception.GetBaseException().HResult -ne $missing) { throw }
    return 'ok'
  }
  throw [System.InvalidOperationException]::new('Credential remained after deletion.')
}
`;

export const WINDOWS_CREDENTIAL_DELETE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
${WINDOWS_CREDENTIAL_DELETE_FUNCTION}
try {
  [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
  $vault = [Windows.Security.Credentials.PasswordVault]::new()
  Remove-GoatCredential $vault $env:GOATCITADEL_SECRET_SERVICE $env:GOATCITADEL_SECRET_ACCOUNT
} catch {
  [Console]::Error.WriteLine('Windows credential deletion failed.')
  exit 1
}
`;
