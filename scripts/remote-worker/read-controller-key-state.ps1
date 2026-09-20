#Requires -Version 5.1
# Read-only: enumerate public key names, attempt to open the exact controller
# key, and read directory ACLs. Never creates, signs, exports or deletes a key.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ([Environment]::MachineName -cne 'GOATBOX' -or $env:COMPUTERNAME -cne 'GOATBOX') { throw 'GOATBOX only.' }
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator PowerShell required.' }
$source=@'
using System;
using System.Runtime.InteropServices;
namespace GoatCitadel.Diagnostics {
  public sealed class ControllerKeyObservation {
    public string ProviderStatus;
    public string EnumerationStatus;
    public bool EnumerationComplete;
    public bool ExactNameObserved;
    public string OpenStatus;
  }
  public static class ControllerKeyReader {
    [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)]
    private static extern int NCryptOpenStorageProvider(out IntPtr provider, string name, uint flags);
    [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)]
    private static extern int NCryptEnumKeys(IntPtr provider, string scope, out IntPtr name, ref IntPtr state, uint flags);
    [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)]
    private static extern int NCryptOpenKey(IntPtr provider, out IntPtr key, string name, uint legacy, uint flags);
    [DllImport("ncrypt.dll")]
    private static extern int NCryptFreeBuffer(IntPtr buffer);
    [DllImport("ncrypt.dll")]
    private static extern int NCryptFreeObject(IntPtr handle);
    private static string Hex(int status) { return "0x"+unchecked((uint)status).ToString("x8"); }
    public static ControllerKeyObservation Read() {
      var result=new ControllerKeyObservation();
      IntPtr provider=IntPtr.Zero, state=IntPtr.Zero, key=IntPtr.Zero;
      const string expected="GoatCitadel.CellController.Attestation.v1";
      try {
        int status=NCryptOpenStorageProvider(out provider,"Microsoft Software Key Storage Provider",0);
        result.ProviderStatus=Hex(status);
        if(status!=0) return result;
        for(int index=0;index<10000;index++) {
          IntPtr name=IntPtr.Zero;
          try {
            status=NCryptEnumKeys(provider,null,out name,ref state,0x20|0x40);
            result.EnumerationStatus=Hex(status);
            if(unchecked((uint)status)==0x8009002a) { result.EnumerationComplete=true; break; }
            if(status!=0) break;
            if(name==IntPtr.Zero) { result.EnumerationStatus="invalid_name_pointer"; break; }
            // NCryptKeyName starts with pszName. Discard every other key name.
            string value=Marshal.PtrToStringUni(Marshal.ReadIntPtr(name));
            if(String.Equals(value,expected,StringComparison.Ordinal)) result.ExactNameObserved=true;
            if(index==9999) result.EnumerationStatus="bounded_scan_limit";
          } finally { if(name!=IntPtr.Zero) NCryptFreeBuffer(name); }
        }
        result.OpenStatus=Hex(NCryptOpenKey(provider,out key,expected,0,0x20|0x40));
        return result;
      } finally {
        if(key!=IntPtr.Zero) NCryptFreeObject(key);
        if(state!=IntPtr.Zero) NCryptFreeBuffer(state);
        if(provider!=IntPtr.Zero) NCryptFreeObject(provider);
      }
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$directories=foreach ($path in @('C:\ProgramData\Microsoft','C:\ProgramData\Microsoft\Crypto',
    'C:\ProgramData\Microsoft\Crypto\Keys','C:\ProgramData\Microsoft\Crypto\SystemKeys')) {
  try {
    $item=Get-Item -LiteralPath $path -Force
    [pscustomobject]@{Path=$path;Attributes=[string]$item.Attributes;Sddl=(Get-Acl -LiteralPath $path).Sddl;Error=$null}
  } catch { [pscustomobject]@{Path=$path;Attributes=$null;Sddl=$null;Error=$_.Exception.Message} }
}
[ordered]@{
  schemaVersion='goatcitadel.controller-key-observation.v1'
  computerName=$env:COMPUTERNAME
  key=[GoatCitadel.Diagnostics.ControllerKeyReader]::Read()
  directories=@($directories)
  keyCreationAttempted=$false
  privateKeyContentsRead=$false
} | ConvertTo-Json -Depth 5
