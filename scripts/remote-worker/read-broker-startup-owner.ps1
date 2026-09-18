#Requires -Version 5.1
<#
.SYNOPSIS
  Observe the owners of the pinned GOATBOX broker and signer during one start.
.DESCRIPTION
  Default is a read-only preflight. -StartOnce starts only the installed broker
  once, observes process/token owner SIDs for twelve seconds, and saves a report.
  No install, removal, ACL/owner/privilege changes, process-memory reads, service
  stops, or disk/volume operations. -SelfTest only inspects the caller process.
#>
[CmdletBinding(DefaultParameterSetName='Observe')]
param(
  [Parameter(ParameterSetName='Observe')][switch]$StartOnce,
  [Parameter(Mandatory=$true, ParameterSetName='SelfTest')][switch]$SelfTest
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $SelfTest) {
  if ($env:COMPUTERNAME -cne 'GOATBOX') { throw 'Run this diagnostic on GOATBOX only.' }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw 'Use Administrator PowerShell on GOATBOX.'
    }
  } finally { $identity.Dispose() }
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace GoatCitadel.BrokerOwnerDiagnostic {
  public sealed class LogonGroup {
    public string sid;
    public uint attributes;
  }
  public sealed class Observation {
    public string serviceName, imagePath, createdUtc, processOwnerSid;
    public string tokenUserSid, tokenDefaultOwnerSid, tokenObjectOwnerSid;
    public uint processId, sessionId, scmStateAtCapture, scmPidAtCapture;
    public bool scmPidDocumentedValid;
    public LogonGroup[] tokenLogonGroups;
    public readonly List<string> errors = new List<string>();
  }
  public sealed class Status {
    public string name;
    public uint state, processId, win32ExitCode, serviceExitCode;
  }
  public sealed class Report {
    public string startedUtc;
    public string captureMethod = "dedicated SCM PID observers; warmed owner reads";
    public LogonGroup[] observerLogonGroups;
    public int[] servicePollCounts;
    public bool startRequested, startReturnedSuccess;
    public int startWindowsError;
    public Observation[] observations;
    public Status[] finalServices;
    public readonly List<string> errors = new List<string>();
  }
  public static class Reader {
    const string Signer = "GoatCitadelRemoteWorkerProvisioner";
    const string Broker = "GoatCitadelRemoteWorkerProvisionerAvailability";
    const string Bin = @"C:\ProgramData\GoatCitadel\RemoteWorkerProvisioner\bin\";
    const uint QueryProcess = 0x1000, ReadControl = 0x20000;
    static readonly string[] Names = { Signer, Broker };
    static readonly string[] Images = { Signer + ".exe", Broker + ".exe", Signer + "Client.exe" };
    static readonly string[] Hashes = {
      "709215e72f10386ab4a5a9276c0ec3d664b61235931629a05d03827063e78074",
      "69092a07ac0b447bee7a91140844396a200353e332820b334309743102cad0e9",
      "6d0c6d53272c1564b70906193be452358af0f30a81788d469599b125735c9469"
    };
    [StructLayout(LayoutKind.Sequential)] struct ServiceStatus {
      public uint type, state, controls, win32Exit, serviceExit, checkpoint, waitHint, pid, flags;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
      public uint size, usage, pid; public UIntPtr heap;
      public uint module, threads, parent; public int priority; public uint flags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
    }
    [StructLayout(LayoutKind.Sequential)] struct ServiceConfig {
      public uint type, startType, errorControl;
      public IntPtr binaryPath, loadGroup; public uint tag;
      public IntPtr dependencies, account, display;
    }
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr OpenSCManagerW(string machine, string database, uint access);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool QueryServiceStatusEx(IntPtr service, int level, out ServiceStatus status, int length, out uint needed);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool QueryServiceConfigW(IntPtr service, IntPtr config, uint length, out uint needed);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool StartServiceW(IntPtr service, uint count, IntPtr arguments);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool GetKernelObjectSecurity(IntPtr handle, uint info, byte[] descriptor, uint length, out uint needed);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, uint length, out uint needed);

    static Exception Error(string operation) {
      return new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static string ErrorText(Exception ex) {
      var native = ex as Win32Exception;
      return ex.Message + (native == null ? "" : " (Win32 " + native.NativeErrorCode + ")");
    }
    static string ObjectOwner(IntPtr handle) {
      byte[] bytes = new byte[8192]; uint needed;
      if (!GetKernelObjectSecurity(handle, 1, bytes, (uint)bytes.Length, out needed)) throw Error("Read object owner");
      if (needed < 20 || needed > bytes.Length) throw new InvalidDataException("Owner descriptor length invalid.");
      var descriptor = new RawSecurityDescriptor(bytes, 0);
      if (descriptor.Owner == null) throw new InvalidDataException("Owner absent.");
      return descriptor.Owner.Value;
    }
    static string TokenSid(IntPtr token, int kind) {
      IntPtr buffer = Marshal.AllocHGlobal(256);
      try {
        uint needed;
        if (!GetTokenInformation(token, kind, buffer, 256, out needed)) throw Error("Read token identity " + kind);
        if (needed < IntPtr.Size || needed > 256) throw new InvalidDataException("Token identity length invalid.");
        IntPtr sid = Marshal.ReadIntPtr(buffer);
        long offset = sid.ToInt64() - buffer.ToInt64();
        if (offset < IntPtr.Size || offset > needed - 8) throw new InvalidDataException("Token SID pointer outside result.");
        int count = Marshal.ReadByte(sid, 1);
        if (Marshal.ReadByte(sid) != 1 || count > 15 || offset + 8 + count * 4 > needed)
          throw new InvalidDataException("Token SID length invalid.");
        return new SecurityIdentifier(sid).Value;
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    static LogonGroup[] TokenLogonGroups(IntPtr token) {
      IntPtr buffer = Marshal.AllocHGlobal(8192);
      try {
        uint needed;
        if (!GetTokenInformation(token, 2, buffer, 8192, out needed)) throw Error("Read token logon groups");
        int first = IntPtr.Size, stride = IntPtr.Size == 8 ? 16 : 8;
        if (needed < first || needed > 8192) throw new InvalidDataException("Token group length invalid.");
        uint count = unchecked((uint)Marshal.ReadInt32(buffer));
        if (count > (needed - first) / stride) throw new InvalidDataException("Token group count invalid.");
        var groups = new List<LogonGroup>();
        for (int i=0; i<count; ++i) {
          IntPtr record = IntPtr.Add(buffer, first + i * stride);
          uint attributes = unchecked((uint)Marshal.ReadInt32(record, IntPtr.Size));
          if ((attributes & 0xc0000000U) != 0xc0000000U) continue;
          IntPtr sid = Marshal.ReadIntPtr(record);
          long offset = sid.ToInt64() - buffer.ToInt64();
          if (offset < first + count * stride || offset > needed - 20 ||
              Marshal.ReadByte(sid) != 1 || Marshal.ReadByte(sid, 1) != 3)
            throw new InvalidDataException("Logon group SID bounds invalid.");
          string value = new SecurityIdentifier(sid).Value;
          if (!value.StartsWith("S-1-5-5-", StringComparison.Ordinal))
            throw new InvalidDataException("Unexpected logon group SID form.");
          groups.Add(new LogonGroup { sid=value, attributes=attributes });
        }
        return groups.ToArray();
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    static void ReadOwners(IntPtr process, Observation item) {
      try { item.processOwnerSid = ObjectOwner(process); }
      catch (Exception ex) { item.errors.Add("processOwner: " + ErrorText(ex)); }
      IntPtr token;
      if (!OpenProcessToken(process, 8 | ReadControl, out token)) {
        item.errors.Add("tokenObjectOwner: " + ErrorText(Error("Open token with READ_CONTROL")));
        if (!OpenProcessToken(process, 8, out token)) {
          item.errors.Add("tokenIdentity: " + ErrorText(Error("Open token with TOKEN_QUERY"))); return;
        }
      } else {
        try { item.tokenObjectOwnerSid = ObjectOwner(token); }
        catch (Exception ex) { item.errors.Add("tokenObjectOwner: " + ErrorText(ex)); }
      }
      try {
        try { item.tokenUserSid = TokenSid(token, 1); }
        catch (Exception ex) { item.errors.Add("tokenUser: " + ErrorText(ex)); }
        try { item.tokenDefaultOwnerSid = TokenSid(token, 4); }
        catch (Exception ex) { item.errors.Add("tokenDefaultOwner: " + ErrorText(ex)); }
        try { item.tokenLogonGroups = TokenLogonGroups(token); }
        catch (Exception ex) { item.errors.Add("tokenLogonGroups: " + ErrorText(ex)); }
      } finally { CloseHandle(token); }
    }
    static ServiceStatus Query(IntPtr service) {
      ServiceStatus status; uint needed;
      if (!QueryServiceStatusEx(service, 0, out status, Marshal.SizeOf(typeof(ServiceStatus)), out needed))
        throw Error("Query fixed service status");
      return status;
    }
    static void AssertStoppedConfig(IntPtr service, string name) {
      var status = Query(service);
      if (status.type != 16 || status.state != 1 || status.pid != 0)
        throw new InvalidOperationException(name + " must already be stopped with no PID.");
      IntPtr bytes = Marshal.AllocHGlobal(8192);
      try {
        uint needed;
        if (!QueryServiceConfigW(service, bytes, 8192, out needed)) throw Error("Read fixed service configuration");
        var config = (ServiceConfig)Marshal.PtrToStructure(bytes, typeof(ServiceConfig));
        if (config.type != 16 || config.startType != 3 || config.errorControl != 1 ||
            Marshal.PtrToStringUni(config.binaryPath) != "\"" + Bin + name + ".exe\"" ||
            Marshal.PtrToStringUni(config.account) != "LocalSystem")
          throw new InvalidOperationException("Unexpected configuration for " + name);
      } finally { Marshal.FreeHGlobal(bytes); }
    }
    static Observation Capture(uint pid, string name, IntPtr service, long after) {
      IntPtr process = OpenProcess(QueryProcess | ReadControl, false, pid);
      int ownerOpenError = process == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
      if (process == IntPtr.Zero) process = OpenProcess(QueryProcess, false, pid);
      if (process == IntPtr.Zero) throw Error("Open matching process " + pid);
      try {
        var path = new StringBuilder(32768); uint length = (uint)path.Capacity;
        if (!QueryFullProcessImageNameW(process, 0, path, ref length)) throw Error("Read process image path");
        if (!String.Equals(path.ToString(), Bin + name + ".exe", StringComparison.OrdinalIgnoreCase)) return null;
        long created, exited, kernel, user; uint session;
        if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) throw Error("Read process creation time");
        if (created < after) return null;
        if (!ProcessIdToSessionId(pid, out session)) throw Error("Read process session");
        if (session != 0) return null;
        var item = new Observation { serviceName=name, processId=pid, imagePath=path.ToString(),
          createdUtc=DateTime.FromFileTimeUtc(created).ToString("o"), sessionId=session };
        var status = Query(service);
        item.scmStateAtCapture = status.state;
        item.scmPidAtCapture = status.pid;
        // START_PENDING and STOP_PENDING PIDs are not guaranteed by the SCM API.
        item.scmPidDocumentedValid = status.pid == pid &&
          (status.state == 4 || status.state == 5 || status.state == 6 || status.state == 7);
        if (ownerOpenError != 0) item.errors.Add("Process READ_CONTROL unavailable (Win32 " + ownerOpenError + ")");
        ReadOwners(process, item);
        return item;
      } finally { CloseHandle(process); }
    }
    public static Report Run(bool startOnce) {
      if (Environment.MachineName != "GOATBOX") throw new InvalidOperationException("GOATBOX only.");
      var result = new Report { startedUtc=DateTime.UtcNow.ToString("o") };
      var files = new List<FileStream>();
      IntPtr manager = IntPtr.Zero;
      IntPtr[] services = { IntPtr.Zero, IntPtr.Zero };
      try {
        for (int i=0; i<Images.Length; ++i) {
          // Retain read-only image handles to prevent replacement during observation.
          var file = new FileStream(Bin + Images[i], FileMode.Open, FileAccess.Read, FileShare.Read);
          files.Add(file);
          using (var sha = SHA256.Create()) {
            string actual = BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
            if (actual != Hashes[i]) throw new InvalidOperationException("Installed image hash mismatch: " + Images[i]);
          }
        }
        manager = OpenSCManagerW(null, null, 1);
        if (manager == IntPtr.Zero) throw Error("Open local SCM");
        for (int i=0; i<Names.Length; ++i) {
          services[i] = OpenServiceW(manager, Names[i], (uint)(5 | (startOnce && i == 1 ? 16 : 0)));
          if (services[i] == IntPtr.Zero) throw Error("Open fixed service " + Names[i]);
          AssertStoppedConfig(services[i], Names[i]);
        }
        if (!startOnce) return result;
        // Warm the security descriptor/token readers before either short-lived
        // service exists. Compile Capture before the observation window too.
        result.observerLogonGroups = SelfTest().tokenLogonGroups;
        long after = DateTime.UtcNow.ToFileTimeUtc();
        var found = new Observation[Names.Length];
        var pollCounts = new int[Names.Length];
        var observerErrors = new List<string>[Names.Length];
        var warmErrors = new Exception[Names.Length];
        var watchers = new List<Thread>();
        using (var ready = new CountdownEvent(Names.Length)) {
          try {
            for (int i=0; i<Names.Length; ++i) {
              int index = i;
              observerErrors[index] = new List<string>();
              var watcher = new Thread(delegate() {
                try { Query(services[index]); }
                catch (Exception ex) { warmErrors[index] = ex; }
                finally { ready.Signal(); }
                if (warmErrors[index] != null) return;
                try {
                  var timer = Stopwatch.StartNew();
                  var seen = new HashSet<string>();
                  // Each service has its own observer. Reading the broker's
                  // token cannot delay discovery of the signer's process.
                  while (timer.ElapsedMilliseconds < 12000) {
                    if (found[index] != null || pollCounts[index] >= 40000) { Thread.Sleep(25); continue; }
                    ++pollCounts[index];
                    var status = Query(services[index]);
                    if (status.pid != 0) {
                      try { found[index] = Capture(status.pid, Names[index], services[index], after); }
                      catch (Exception ex) {
                        string message = ErrorText(ex);
                        if (seen.Count < 12 && seen.Add(message)) observerErrors[index].Add(message);
                      }
                    }
                    // Yield without a timer tick delay in the discovery path.
                    Thread.Yield();
                  }
                } catch (Exception ex) { observerErrors[index].Add(ErrorText(ex)); }
              });
              watcher.IsBackground = true;
              watcher.Start();
              watchers.Add(watcher);
            }
            ready.Wait();
            foreach (var error in warmErrors) if (error != null) throw error;
            result.startRequested = true;
            result.startReturnedSuccess = StartServiceW(services[1], 0, IntPtr.Zero);
            if (!result.startReturnedSuccess) result.startWindowsError = Marshal.GetLastWin32Error();
          } finally { foreach (var watcher in watchers) watcher.Join(); }
        }
        result.servicePollCounts = pollCounts;
        var items = new List<Observation>();
        for (int i=0; i<Names.Length; ++i) {
          if (found[i] != null) items.Add(found[i]);
          foreach (var error in observerErrors[i]) result.errors.Add(Names[i] + ": " + error);
        }
        result.observations = items.ToArray();
        var states = new List<Status>();
        for (int i=0; i<Names.Length; ++i) {
          try {
            var status = Query(services[i]);
            states.Add(new Status { name=Names[i], state=status.state, processId=status.pid,
              win32ExitCode=status.win32Exit, serviceExitCode=status.serviceExit });
          } catch (Exception ex) { result.errors.Add(Names[i] + ": " + ErrorText(ex)); }
          if (found[i] == null) result.errors.Add("No process sample captured for " + Names[i]);
        }
        result.finalServices = states.ToArray();
        return result;
      } finally {
        foreach (var service in services) if (service != IntPtr.Zero) CloseServiceHandle(service);
        if (manager != IntPtr.Zero) CloseServiceHandle(manager);
        foreach (var file in files) file.Dispose();
      }
    }
    public static Observation SelfTest() {
      RuntimeHelpers.PrepareMethod(typeof(Reader).GetMethod("Capture", BindingFlags.Static | BindingFlags.NonPublic).MethodHandle);
      var item = new Observation { serviceName="self-test only", processId=GetCurrentProcessId() };
      ReadOwners(GetCurrentProcess(), item);
      var path = new StringBuilder(32768); uint length = (uint)path.Capacity;
      long created, exited, kernel, user;
      if (!QueryFullProcessImageNameW(GetCurrentProcess(), 0, path, ref length) ||
          !GetProcessTimes(GetCurrentProcess(), out created, out exited, out kernel, out user) ||
          !ProcessIdToSessionId(item.processId, out item.sessionId)) throw Error("Self-test process metadata");
      item.imagePath = path.ToString();
      item.createdUtc = DateTime.FromFileTimeUtc(created).ToString("o");
      IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
      if (snapshot == new IntPtr(-1)) throw Error("Self-test process snapshot");
      bool found = false;
      try {
        var entry = new ProcessEntry { size=(uint)Marshal.SizeOf(typeof(ProcessEntry)) };
        if (Process32FirstW(snapshot, ref entry)) do {
          if (entry.pid == item.processId && String.Equals(entry.exe, Path.GetFileName(item.imagePath), StringComparison.OrdinalIgnoreCase)) found = true;
        } while (Process32NextW(snapshot, ref entry));
      } finally { CloseHandle(snapshot); }
      if (!found) throw new InvalidOperationException("Self-test could not locate its own process snapshot.");
      using (var identity = WindowsIdentity.GetCurrent()) {
        if (item.tokenUserSid != identity.User.Value || item.processOwnerSid == null ||
            item.tokenDefaultOwnerSid == null || item.tokenObjectOwnerSid == null || item.errors.Count != 0)
          throw new InvalidOperationException("Read-only self-test failed: " + String.Join("; ", item.errors));
      }
      return item;
    }
  }
}
'@

if ($SelfTest) {
  [GoatCitadel.BrokerOwnerDiagnostic.Reader]::SelfTest() | ConvertTo-Json -Depth 5
  return
}

Write-Host 'Verifying the installed service-owner-fix images and stopped service configurations...'
if (-not $StartOnce) {
  $null = [GoatCitadel.BrokerOwnerDiagnostic.Reader]::Run($false)
  Write-Host 'Read-only diagnostic preflight passed. No service started.'
  return
}
$evidenceRoot = 'C:\worker-evidence'
if (-not (Test-Path -LiteralPath $evidenceRoot -PathType Container)) {
  throw 'Expected C:\worker-evidence to exist. Stop and preserve the installation.'
}
$output = Join-Path $evidenceRoot ('broker-owner-observation-v2-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.json')
$file = New-Object IO.FileStream($output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
try {
  Write-Host 'Warming owner readers, then starting the broker once with two dedicated observers...'
  $report = [GoatCitadel.BrokerOwnerDiagnostic.Reader]::Run($true)
  $json = $report | ConvertTo-Json -Depth 6
  $bytes = [Text.Encoding]::UTF8.GetBytes($json + [Environment]::NewLine)
  $file.Write($bytes, 0, $bytes.Length)
  $file.Flush()
  Write-Output $json
} finally { $file.Dispose() }
Write-Host ('Evidence saved: ' + $output)
Write-Host 'Paste this report back. Do not reinstall or repeat the startup attempt.'
