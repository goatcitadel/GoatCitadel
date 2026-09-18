#Requires -Version 5.1
<#
.SYNOPSIS
  Observe the pinned GOATBOX broker's target checks during one broker start.
.DESCRIPTION
  Default is a read-only preflight. -StartOnce starts only the installed broker
  once, records SCM transitions and process/token inspection for twelve seconds,
  and saves a report. Queries run as the administrator observer, not the broker.
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

namespace GoatCitadel.BrokerTargetDiagnostic {
  public sealed class LogonGroup {
    public string sid;
    public uint attributes;
  }
  public sealed class Observation {
    public string serviceName, imagePath, createdUtc, processOwnerSid;
    public string tokenUserSid, tokenDefaultOwnerSid, tokenObjectOwnerSid;
    public string processSddl, tokenSddl;
    public uint processId, sessionId, scmStateAtCapture, scmPidAtCapture;
    public bool scmPidDocumentedValid;
    public bool processQueryAndSynchronize, tokenQuery;
    public bool? aliveBefore, aliveAfter, tokenMatchesSignerContract;
    public uint? tokenType, tokenSession, tokenAppContainer;
    public bool? tokenRestricted;
    public LogonGroup[] tokenLogonGroups;
    public LogonGroup[] tokenServiceGroups;
    public Privilege[] tokenPrivileges;
    public readonly List<string> errors = new List<string>();
  }
  public sealed class Privilege {
    public uint low, high, attributes;
    public bool isChangeNotify;
  }
  public sealed class Status {
    public string name;
    public uint type, state, processId, flags, win32ExitCode, serviceExitCode, checkpoint, waitHint;
    public long elapsedMilliseconds;
    public bool statusAcceptedByBroker;
  }
  public sealed class Report {
    public string startedUtc;
    public string captureMethod = "bounded SCM transitions; signer inspection only in RUNNING";
    public string observerContext = "administrator; query results do not prove access from the broker token";
    public LogonGroup[] observerLogonGroups;
    public int[] servicePollCounts;
    public bool startRequested, startReturnedSuccess;
    public int startWindowsError;
    public Observation[] observations;
    public Status[] initialServices;
    public Status[][] transitions;
    public Status[] finalServices;
    public readonly List<string> errors = new List<string>();
  }
  public static class Reader {
    const string Signer = "GoatCitadelRemoteWorkerProvisioner";
    const string Broker = "GoatCitadelRemoteWorkerProvisionerAvailability";
    const string Bin = @"C:\ProgramData\GoatCitadel\RemoteWorkerProvisioner\bin\";
    const uint QueryProcess = 0x1000, ReadControl = 0x20000, Synchronize = 0x100000;
    const string SignerSid = "S-1-5-80-1765223994-2719708455-3112291649-2938929260-976374647";
    static readonly string[] Names = { Signer, Broker };
    static readonly string[] Images = { Signer + ".exe", Broker + ".exe", Signer + "Client.exe" };
    static readonly string[] Hashes = {
      "b3b056ef523b57bce4e6f3aec20ceefcd69e524961bc0d1167c1184fa6235381",
      "48402f8212e1e0a57d1d36ff546ab781b1ed0731a89470d6628e3c5fec0196b0",
      "6f7309533bf1034c537e9e4c50a19c31d07354490092e8b97d9a29ba3af05948"
    };
    [StructLayout(LayoutKind.Sequential)] struct ServiceStatus {
      public uint type, state, controls, win32Exit, serviceExit, checkpoint, waitHint, pid, flags;
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
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool IsTokenRestricted(IntPtr token);
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint low, high; }
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool LookupPrivilegeValueW(string system, string name, out Luid luid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, uint capacity, uint flags);
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
    static RawSecurityDescriptor ObjectSecurity(IntPtr handle) {
      byte[] bytes = new byte[8192]; uint needed;
      if (!GetKernelObjectSecurity(handle, 5, bytes, (uint)bytes.Length, out needed)) throw Error("Read object owner and DACL");
      if (needed < 20 || needed > bytes.Length) throw new InvalidDataException("Owner descriptor length invalid.");
      var descriptor = new RawSecurityDescriptor(bytes, 0);
      if (descriptor.Owner == null) throw new InvalidDataException("Owner absent.");
      return descriptor;
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
    static LogonGroup[] TokenGroups(IntPtr token, bool logons) {
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
          IntPtr sid = Marshal.ReadIntPtr(record);
          long offset = sid.ToInt64() - buffer.ToInt64();
          if (offset < first + count * stride || offset > needed - 8 || Marshal.ReadByte(sid) != 1 ||
              Marshal.ReadByte(sid, 1) > 15 || offset + 8 + 4 * Marshal.ReadByte(sid, 1) > needed)
            throw new InvalidDataException("Token group SID bounds invalid.");
          string value = new SecurityIdentifier(sid).Value;
          bool selected = logons ? (attributes & 0xc0000000U) != 0 :
            value == "S-1-5-6" || value.StartsWith("S-1-5-80-", StringComparison.Ordinal);
          if (!selected) continue;
          groups.Add(new LogonGroup { sid=value, attributes=attributes });
        }
        return groups.ToArray();
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    static uint TokenScalar(IntPtr token, int kind) {
      IntPtr buffer = Marshal.AllocHGlobal(4);
      try {
        uint needed;
        if (!GetTokenInformation(token, kind, buffer, 4, out needed)) throw Error("Read token scalar " + kind);
        if (needed != 4) throw new InvalidDataException("Invalid token scalar length.");
        return unchecked((uint)Marshal.ReadInt32(buffer));
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    static Privilege[] TokenPrivileges(IntPtr token) {
      IntPtr buffer = Marshal.AllocHGlobal(8192);
      try {
        uint needed;
        if (!GetTokenInformation(token, 3, buffer, 8192, out needed)) throw Error("Read token privileges");
        if (needed < 4 || needed > 8192) throw new InvalidDataException("Invalid token privilege length.");
        uint count = unchecked((uint)Marshal.ReadInt32(buffer));
        if (count > (needed - 4) / 12) throw new InvalidDataException("Invalid token privilege count.");
        Luid changeNotify;
        if (!LookupPrivilegeValueW(null, "SeChangeNotifyPrivilege", out changeNotify)) throw Error("Resolve change-notify privilege");
        var result = new List<Privilege>();
        for (int i=0; i<count; ++i) {
          IntPtr record = IntPtr.Add(buffer, 4 + i * 12);
          uint low = unchecked((uint)Marshal.ReadInt32(record));
          uint high = unchecked((uint)Marshal.ReadInt32(record, 4));
          result.Add(new Privilege { low=low, high=high,
            attributes=unchecked((uint)Marshal.ReadInt32(record, 8)),
            isChangeNotify=low == changeNotify.low && high == changeNotify.high });
        }
        return result.ToArray();
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    public static bool TokenMatchesSigner(Observation item) {
      if (!item.tokenQuery || item.tokenUserSid != "S-1-5-18" || item.tokenType != 1 ||
          item.tokenSession != 0 || item.tokenAppContainer != 0 || item.tokenRestricted != false ||
          item.tokenServiceGroups == null || item.tokenPrivileges == null) return false;
      int serviceCount=0, logonCount=0;
      foreach (var group in item.tokenServiceGroups) {
        if (group.sid == SignerSid) {
          ++serviceCount;
          if ((group.attributes & 12) != 12 || (group.attributes & 16) != 0) return false;
        }
        if (group.sid == "S-1-5-6" && (group.attributes & 4) != 0 && (group.attributes & 16) == 0) ++logonCount;
      }
      return serviceCount == 1 && logonCount == 1 && item.tokenPrivileges.Length == 1 &&
        item.tokenPrivileges[0].isChangeNotify && (item.tokenPrivileges[0].attributes & 2) != 0 &&
        (item.tokenPrivileges[0].attributes & 4) == 0;
    }
    static void ReadOwners(IntPtr process, Observation item) {
      IntPtr securityProcess = OpenProcess(QueryProcess | ReadControl, false, item.processId);
      if (securityProcess == IntPtr.Zero) item.errors.Add("processSecurity: " + ErrorText(Error("Open process with READ_CONTROL")));
      else try {
        var security = ObjectSecurity(securityProcess);
        item.processOwnerSid = security.Owner.Value;
        item.processSddl = security.GetSddlForm(AccessControlSections.Owner | AccessControlSections.Access);
      } catch (Exception ex) { item.errors.Add("processSecurity: " + ErrorText(ex)); }
      finally { CloseHandle(securityProcess); }
      IntPtr token;
      if (!OpenProcessToken(process, 8 | ReadControl, out token)) {
        item.errors.Add("tokenObjectOwner: " + ErrorText(Error("Open token with READ_CONTROL")));
        if (!OpenProcessToken(process, 8, out token)) {
          item.errors.Add("tokenIdentity: " + ErrorText(Error("Open token with TOKEN_QUERY"))); return;
        }
      } else {
        try {
          var security = ObjectSecurity(token);
          item.tokenObjectOwnerSid = security.Owner.Value;
          item.tokenSddl = security.GetSddlForm(AccessControlSections.Owner | AccessControlSections.Access);
        }
        catch (Exception ex) { item.errors.Add("tokenObjectOwner: " + ErrorText(ex)); }
      }
      try {
        item.tokenQuery = true;
        try { item.tokenUserSid = TokenSid(token, 1); }
        catch (Exception ex) { item.errors.Add("tokenUser: " + ErrorText(ex)); }
        try { item.tokenDefaultOwnerSid = TokenSid(token, 4); }
        catch (Exception ex) { item.errors.Add("tokenDefaultOwner: " + ErrorText(ex)); }
        try { item.tokenLogonGroups = TokenGroups(token, true); }
        catch (Exception ex) { item.errors.Add("tokenLogonGroups: " + ErrorText(ex)); }
        try {
          item.tokenType = TokenScalar(token, 8);
          item.tokenSession = TokenScalar(token, 12);
          item.tokenAppContainer = TokenScalar(token, 29);
          SetLastError(0);
          bool restricted = IsTokenRestricted(token);
          if (!restricted && Marshal.GetLastWin32Error() != 0) throw Error("Read token restricting-SID status");
          item.tokenRestricted = restricted;
          item.tokenServiceGroups = TokenGroups(token, false);
          item.tokenPrivileges = TokenPrivileges(token);
          item.tokenMatchesSignerContract = TokenMatchesSigner(item);
        } catch (Exception ex) { item.errors.Add("tokenContract: " + ErrorText(ex)); }
      } finally { CloseHandle(token); }
    }
    static ServiceStatus Query(IntPtr service) {
      ServiceStatus status; uint needed;
      if (!QueryServiceStatusEx(service, 0, out status, Marshal.SizeOf(typeof(ServiceStatus)), out needed))
        throw Error("Query fixed service status");
      return status;
    }
    // Mirrors StatusMetadataIsExact and ClassifyAvailabilityAction for this
    // diagnostic only. It is not an authorization check or full identity proof.
    public static bool StatusAccepted(Status value, bool signer) {
      bool neverStarted = signer && value.state == 1 && value.processId == 0 && value.win32ExitCode == 1077;
      if (value.type != 16 || value.flags != 0 || (value.win32ExitCode != 0 && !neverStarted) || value.serviceExitCode != 0) return false;
      if (value.state == 2 || value.state == 3) {
        if (signer && value.state == 2 && value.checkpoint == 0 && value.waitHint == 2000) return true;
        return value.checkpoint != 0 && value.waitHint != 0 && value.waitHint <= 30000;
      }
      if (value.checkpoint != 0 || value.waitHint != 0) return false;
      return value.state == 1 ? value.processId == 0 : value.state == 4 && value.processId != 0;
    }
    static Status Snapshot(ServiceStatus value, string name, long elapsed) {
      var result = new Status { name=name, type=value.type, state=value.state,
        processId=value.pid, flags=value.flags, win32ExitCode=value.win32Exit,
        serviceExitCode=value.serviceExit, checkpoint=value.checkpoint,
        waitHint=value.waitHint, elapsedMilliseconds=elapsed };
      result.statusAcceptedByBroker = StatusAccepted(result, name == Signer);
      return result;
    }
    static bool SameStatus(Status left, Status right) {
      return left != null && left.type == right.type && left.state == right.state &&
        left.processId == right.processId && left.flags == right.flags &&
        left.win32ExitCode == right.win32ExitCode && left.serviceExitCode == right.serviceExitCode &&
        left.checkpoint == right.checkpoint && left.waitHint == right.waitHint;
    }
    static Status AssertInitialConfig(IntPtr service, string name) {
      var status = Query(service);
      var initial = Snapshot(status, name, 0);
      if (name == Broker && (status.type != 16 || status.state != 1 || status.pid != 0))
        throw new InvalidOperationException("The broker must already be stopped with no PID.");
      if (name == Signer && (!initial.statusAcceptedByBroker || (status.state != 1 && status.state != 4)))
        throw new InvalidOperationException("Signer must be healthy and stopped or RUNNING. Current state=" +
          status.state + ", win32Exit=" + status.win32Exit + ", serviceExit=" + status.serviceExit + ". Preserve the installation.");
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
      return initial;
    }
    static Observation Capture(uint pid, string name, IntPtr service, long after) {
      IntPtr process = OpenProcess(QueryProcess | Synchronize, false, pid);
      int queryOpenError = process == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
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
        item.processQueryAndSynchronize = queryOpenError == 0;
        if (item.processQueryAndSynchronize) item.aliveBefore = WaitForSingleObject(process, 0) == 258;
        var status = Query(service);
        item.scmStateAtCapture = status.state;
        item.scmPidAtCapture = status.pid;
        // START_PENDING and STOP_PENDING PIDs are not guaranteed by the SCM API.
        item.scmPidDocumentedValid = status.pid == pid &&
          (status.state == 4 || status.state == 5 || status.state == 6 || status.state == 7);
        if (queryOpenError != 0) item.errors.Add("Process QUERY_LIMITED_INFORMATION | SYNCHRONIZE unavailable (Win32 " + queryOpenError + ")");
        ReadOwners(process, item);
        if (item.processQueryAndSynchronize) item.aliveAfter = WaitForSingleObject(process, 0) == 258;
        var finalStatus = Query(service);
        item.scmPidDocumentedValid = item.scmPidDocumentedValid && finalStatus.state == 4 && finalStatus.pid == pid;
        return item;
      } finally { CloseHandle(process); }
    }
    static void VerifyHeldImagePath(FileStream file, string expectedPath) {
      if (file.Length <= 0 || file.Length > 67108864) throw new InvalidDataException("Installed image size outside bound.");
      var finalPath = new StringBuilder(32768);
      uint finalLength = GetFinalPathNameByHandleW(file.SafeFileHandle.DangerousGetHandle(), finalPath, (uint)finalPath.Capacity, 0);
      if (finalLength == 0 || finalLength >= finalPath.Capacity ||
          !String.Equals(finalPath.ToString(), @"\\?\" + expectedPath, StringComparison.OrdinalIgnoreCase))
        throw new InvalidDataException("Installed image path is aliased or unavailable.");
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
          VerifyHeldImagePath(file, Bin + Images[i]);
          using (var sha = SHA256.Create()) {
            string actual = BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
            if (actual != Hashes[i]) throw new InvalidOperationException("Installed image hash mismatch: " + Images[i]);
          }
        }
        manager = OpenSCManagerW(null, null, 1);
        if (manager == IntPtr.Zero) throw Error("Open local SCM");
        result.initialServices = new Status[Names.Length];
        for (int i=0; i<Names.Length; ++i) {
          services[i] = OpenServiceW(manager, Names[i], (uint)(5 | (startOnce && i == 1 ? 16 : 0)));
          if (services[i] == IntPtr.Zero) throw Error("Open fixed service " + Names[i]);
          result.initialServices[i] = AssertInitialConfig(services[i], Names[i]);
        }
        if (!startOnce) return result;
        // Warm the security descriptor/token readers before either short-lived
        // service exists. Compile Capture before the observation window too.
        result.observerLogonGroups = SelfTest().tokenLogonGroups;
        long after = DateTime.UtcNow.ToFileTimeUtc();
        var found = new Observation[Names.Length];
        var pollCounts = new int[Names.Length];
        var observerErrors = new List<string>[Names.Length];
        var transitions = new List<Status>[Names.Length];
        var warmErrors = new Exception[Names.Length];
        var watchers = new List<Thread>();
        using (var ready = new CountdownEvent(Names.Length)) {
          try {
            for (int i=0; i<Names.Length; ++i) {
              int index = i;
              observerErrors[index] = new List<string>();
              transitions[index] = new List<Status>();
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
                    if (pollCounts[index] >= 5000) { Thread.Sleep(25); continue; }
                    ++pollCounts[index];
                    var status = Query(services[index]);
                    var snapshot = Snapshot(status, Names[index], timer.ElapsedMilliseconds);
                    var history = transitions[index];
                    if (history.Count < 64 && (history.Count == 0 || !SameStatus(history[history.Count-1], snapshot))) history.Add(snapshot);
                    if (found[index] == null && status.pid != 0 && (index == 1 || status.state == 4)) {
                      // An already RUNNING healthy signer is allowed: no need to
                      // stop it merely to obtain a newer creation timestamp.
                      long minimumCreation = result.initialServices[index].state == 4 ? 0 : after;
                      try { found[index] = Capture(status.pid, Names[index], services[index], minimumCreation); }
                      catch (Exception ex) {
                        string message = ErrorText(ex);
                        if (seen.Count < 12 && seen.Add(message)) observerErrors[index].Add(message);
                      }
                    }
                    Thread.Sleep(5);
                  }
                } catch (Exception ex) { observerErrors[index].Add(ErrorText(ex)); }
              });
              watcher.IsBackground = true;
              watcher.Start();
              watchers.Add(watcher);
            }
            ready.Wait();
            foreach (var error in warmErrors) if (error != null) throw error;
            // Repeat the fixed service checks with retained handles immediately
            // before the only mutation this diagnostic can issue.
            for (int i=0; i<Names.Length; ++i) AssertInitialConfig(services[i], Names[i]);
            result.startRequested = true;
            result.startReturnedSuccess = StartServiceW(services[1], 0, IntPtr.Zero);
            if (!result.startReturnedSuccess) result.startWindowsError = Marshal.GetLastWin32Error();
          } finally { foreach (var watcher in watchers) watcher.Join(); }
        }
        result.servicePollCounts = pollCounts;
        result.transitions = new Status[Names.Length][];
        var items = new List<Observation>();
        for (int i=0; i<Names.Length; ++i) {
          result.transitions[i] = transitions[i].ToArray();
          if (found[i] != null) items.Add(found[i]);
          foreach (var error in observerErrors[i]) result.errors.Add(Names[i] + ": " + error);
        }
        result.observations = items.ToArray();
        var states = new List<Status>();
        for (int i=0; i<Names.Length; ++i) {
          try {
            var status = Query(services[i]);
            states.Add(Snapshot(status, Names[i], 12000));
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
      IntPtr retained = OpenProcess(QueryProcess | Synchronize, false, item.processId);
      if (retained == IntPtr.Zero) throw Error("Self-test process query and synchronize");
      try {
        item.processQueryAndSynchronize = true;
        item.aliveBefore = WaitForSingleObject(retained, 0) == 258;
        item.aliveAfter = WaitForSingleObject(retained, 0) == 258;
      } finally { CloseHandle(retained); }
      ReadOwners(GetCurrentProcess(), item);
      var path = new StringBuilder(32768); uint length = (uint)path.Capacity;
      long created, exited, kernel, user;
      if (!QueryFullProcessImageNameW(GetCurrentProcess(), 0, path, ref length) ||
          !GetProcessTimes(GetCurrentProcess(), out created, out exited, out kernel, out user) ||
          !ProcessIdToSessionId(item.processId, out item.sessionId)) throw Error("Self-test process metadata");
      item.imagePath = path.ToString();
      item.createdUtc = DateTime.FromFileTimeUtc(created).ToString("o");
      using (var ownImage = new FileStream(item.imagePath, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        VerifyHeldImagePath(ownImage, item.imagePath);
        bool mismatchRefused = false;
        try { VerifyHeldImagePath(ownImage, item.imagePath + ".wrong"); }
        catch (InvalidDataException) { mismatchRefused = true; }
        if (!mismatchRefused) throw new InvalidOperationException("Image path mismatch was accepted.");
      }
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
  [GoatCitadel.BrokerTargetDiagnostic.Reader]::SelfTest() | ConvertTo-Json -Depth 5
  return
}

Write-Host 'Verifying the installed self-image-fix binaries and current service configurations...'
if (-not $StartOnce) {
  [GoatCitadel.BrokerTargetDiagnostic.Reader]::Run($false) | ConvertTo-Json -Depth 6
  Write-Host 'Read-only diagnostic preflight passed. No service started.'
  return
}
$evidenceRoot = 'C:\worker-evidence'
if (-not (Test-Path -LiteralPath $evidenceRoot -PathType Container)) {
  throw 'Expected C:\worker-evidence to exist. Stop and preserve the installation.'
}
$output = Join-Path $evidenceRoot ('broker-target-observation-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.json')
$file = New-Object IO.FileStream($output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
try {
  Write-Host 'Starting the verified broker once; recording status transitions and signer inspection for 12 seconds...'
  $report = [GoatCitadel.BrokerTargetDiagnostic.Reader]::Run($true)
  $json = $report | ConvertTo-Json -Depth 6
  $bytes = [Text.Encoding]::UTF8.GetBytes($json + [Environment]::NewLine)
  $file.Write($bytes, 0, $bytes.Length)
  $file.Flush()
  Write-Output $json
} finally { $file.Dispose() }
Write-Host ('Evidence saved: ' + $output)
Write-Host 'Paste this report back. Do not reinstall or repeat the startup attempt.'
