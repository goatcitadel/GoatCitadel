import { WINDOWS_CREDENTIAL_CUSTODY_GUARD } from "./windows-credential-custody.js";

/** Runs against one captured credential object. A recovered receipt proves the
 * immutable writer's single Add crossed its boundary, even if its acknowledgement
 * was lost. Missing/mismatched slots never establish ownership of an old writer. */
export const WINDOWS_CREDENTIAL_RECEIPT_FUNCTION = String.raw`
function Test-GoatCredentialWriteReceipt($Credential, [string]$WriteId) {
  if ($WriteId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') { throw 'Invalid write receipt identity.' }
  $null = $Credential.RetrievePassword()
  $encoded = $Credential.Password
  if ([Text.Encoding]::UTF8.GetByteCount($encoded) -gt 49152) { return $false }
  try { $receipt = ConvertFrom-Json -InputObject $encoded -ErrorAction Stop } catch { return $false }
  if ($null -eq $receipt -or $receipt -isnot [pscustomobject] -or @($receipt.PSObject.Properties).Count -ne 3 -or
      ($receipt.version -isnot [int] -and $receipt.version -isnot [long]) -or $receipt.version -ne 1 -or $receipt.writeId -isnot [string] -or
      $receipt.secret -isnot [string] -or [String]::IsNullOrWhiteSpace($receipt.secret)) { return $false }
  return [String]::Equals($receipt.writeId, $WriteId, [StringComparison]::Ordinal)
}
function Invoke-GoatCredentialWriteReceipt($Vault, [string]$Resource, [string]$Account, [string]$WriteId, [bool]$Remove) {
  if ($Resource -cne 'goatcitadel' -or $Account -cnotmatch '^mcp:.+:(access-token|refresh-token|environment):receipt-v1:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') { throw 'Invalid credential receipt target.' }
  $missing = -2147023728
  try { $credential = $Vault.Retrieve($Resource, $Account) }
  catch { if ($_.Exception.GetBaseException().HResult -ne $missing) { throw }; return 'absent' }
  if (-not (Test-GoatCredentialWriteReceipt $credential $WriteId)) { return 'mismatch' }
  if (-not $Remove) { return 'written' }
  $null = $Vault.Remove($credential)
  try { $null = $Vault.Retrieve($Resource, $Account) }
  catch { if ($_.Exception.GetBaseException().HResult -ne $missing) { throw }; return 'ok' }
  throw 'Credential remained after deletion.'
}
`;

export const WINDOWS_CREDENTIAL_RECEIPT_SCRIPT = WINDOWS_CREDENTIAL_CUSTODY_GUARD + String.raw`
${WINDOWS_CREDENTIAL_RECEIPT_FUNCTION}
try {
  if ($env:GOATCITADEL_SECRET_RECEIPT_ACTION -cne 'inspect' -and $env:GOATCITADEL_SECRET_RECEIPT_ACTION -cne 'remove') { throw 'Invalid receipt action.' }
  [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
  $vault = [Windows.Security.Credentials.PasswordVault]::new()
  Invoke-GoatCredentialWriteReceipt $vault $env:GOATCITADEL_SECRET_SERVICE $env:GOATCITADEL_SECRET_ACCOUNT $env:GOATCITADEL_SECRET_WRITE_ID ($env:GOATCITADEL_SECRET_RECEIPT_ACTION -ceq 'remove')
} catch { [Console]::Error.WriteLine('Windows credential receipt is unavailable.'); exit 1 }
`;
