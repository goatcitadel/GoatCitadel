import fs from "node:fs/promises";
import path from "node:path";
import type { CodeModeSandboxConfig } from "../../config.js";
import {
  assertLaunchable,
  buildCommonProbeChecks,
  buildSandboxMetadata,
  rejectUnsafeProfilePath,
  type CodeModeHostSandboxAdapter,
  type CodeModeSandboxAdapterDependencies,
  type CodeModeSandboxLaunchInput,
  type CodeModeSandboxLaunchSpec,
} from "./types.js";

export class WindowsAppContainerSandboxAdapter implements CodeModeHostSandboxAdapter {
  public readonly adapterId = "windows-appcontainer";
  public readonly platform = "win32" as const;

  public constructor(private readonly dependencies: CodeModeSandboxAdapterDependencies) {}

  public probe(config: CodeModeSandboxConfig) {
    const checks = buildCommonProbeChecks(config);
    checks.checksPassed.push("win32_adapter_present");

    const powershellPath = this.resolvePowerShell();
    if (powershellPath) {
      checks.checksPassed.push("win32_powershell_present");
    } else {
      checks.checksFailed.push("win32_powershell_missing");
    }

    if (isAppContainerCapable(this.dependencies.osRelease)) {
      checks.checksPassed.push("win32_appcontainer_prerequisites_available");
      checks.checksFailed.push(
        "win32_node_ipc_not_preserved",
        "network_isolation_not_enforced",
        "temp_workspace_not_enforced",
        "privilege_reduction_not_enforced",
        "windows_job_limits_not_enforced",
      );
    } else {
      checks.checksFailed.push("win32_appcontainer_os_unsupported");
    }

    return buildSandboxMetadata({
      platform: this.platform,
      config,
      checksPassed: checks.checksPassed,
      checksFailed: checks.checksFailed,
    });
  }

  public async prepareLaunch(input: CodeModeSandboxLaunchInput): Promise<CodeModeSandboxLaunchSpec> {
    const powershellPath = this.resolvePowerShell();
    assertLaunchable(
      buildSandboxMetadata({
        platform: this.platform,
        config: {
          mode: "best_effort_host",
          required: true,
          bestEffortHostEnabled: Boolean(powershellPath) && isAppContainerCapable(this.dependencies.osRelease),
        },
        checksPassed:
          powershellPath && isAppContainerCapable(this.dependencies.osRelease)
            ? ["win32_powershell_present", "win32_appcontainer_prerequisites_available"]
            : [],
        checksFailed: [
          ...(powershellPath ? [] : ["win32_powershell_missing"]),
          ...(isAppContainerCapable(this.dependencies.osRelease) ? [] : ["win32_appcontainer_os_unsupported"]),
          ...(isAppContainerCapable(this.dependencies.osRelease)
            ? [
                "win32_node_ipc_not_preserved",
                "network_isolation_not_enforced",
                "temp_workspace_not_enforced",
                "privilege_reduction_not_enforced",
                "windows_job_limits_not_enforced",
              ]
            : []),
        ],
      }),
    );
    const launchPowerShellPath = powershellPath as string;

    await fs.mkdir(input.runTempRoot, { recursive: true });
    const launcherPath = path.join(input.runTempRoot, "code-mode-appcontainer-launcher.ps1");
    await fs.writeFile(launcherPath, buildPowerShellLauncher(input), "utf8");

    return {
      transport: "node_ipc",
      executable: launchPowerShellPath,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcherPath],
      cwd: input.runTempRoot,
      env: input.env,
      shell: false,
      enforcedWorkspaceRoot: input.runTempRoot,
      generatedArtifacts: [launcherPath],
      advisoryUnsandboxed: false,
    };
  }

  private resolvePowerShell(): string | undefined {
    return (
      this.dependencies.resolveCommand("powershell.exe", this.platform) ??
      this.dependencies.resolveCommand("pwsh.exe", this.platform)
    );
  }
}

function isAppContainerCapable(osRelease: string): boolean {
  const [majorText, minorText] = osRelease.split(".");
  const major = Number(majorText);
  const minor = Number(minorText ?? "0");
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return false;
  }
  return major > 6 || (major === 6 && minor >= 2);
}

function buildPowerShellLauncher(input: CodeModeSandboxLaunchInput): string {
  rejectUnsafeProfilePath(input.runTempRoot);
  rejectUnsafeProfilePath(input.nodePath);
  rejectUnsafeProfilePath(input.harnessPath);
  const profileName = `GoatCitadel.CodeMode.${input.runId.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
  return String.raw`$ErrorActionPreference = 'Stop'
$profileName = ${quotePowerShell(profileName)}
$displayName = 'GoatCitadel Code Mode'
$workspace = ${quotePowerShell(input.runTempRoot)}
$nodePath = ${quotePowerShell(input.nodePath)}
$harnessPath = ${quotePowerShell(input.harnessPath)}
$arguments = @(${quotePowerShell(`--max-old-space-size=${input.heapMb}`)}, $harnessPath)

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

public static class GoatCitadelAppContainerLauncher {
  private const int EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  private const int PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
  private const int JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
  private const int JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const int JobObjectExtendedLimitInformation = 9;
  private const uint INFINITE = 0xFFFFFFFF;

  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern int CreateAppContainerProfile(string pszAppContainerName, string pszDisplayName, string pszDescription, IntPtr pCapabilities, int dwCapabilityCount, out IntPtr ppSidAppContainerSid);

  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern int DeriveAppContainerSidFromAppContainerName(string pszAppContainerName, out IntPtr ppSidAppContainerSid);

  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern int DeleteAppContainerProfile(string pszAppContainerName);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern IntPtr FreeSid(IntPtr pSid);

  [DllImport("kernel32.dll")]
  private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr hObject);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcessW(string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, int dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr hProcess, out int lpExitCode);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct SECURITY_CAPABILITIES {
    public IntPtr AppContainerSid;
    public IntPtr Capabilities;
    public int CapabilityCount;
    public int Reserved;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public int LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public int ActiveProcessLimit;
    public long Affinity;
    public int PriorityClass;
    public int SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  public static int Launch(string profileName, string displayName, string workspace, string nodePath, string[] arguments) {
    IntPtr sid;
    int result = CreateAppContainerProfile(profileName, displayName, "GoatCitadel Code Mode temporary sandbox", IntPtr.Zero, 0, out sid);
    if (result != 0) {
      result = DeriveAppContainerSidFromAppContainerName(profileName, out sid);
      if (result != 0) {
        throw new InvalidOperationException("Unable to create or derive AppContainer profile: " + result);
      }
    }

    try {
      GrantWorkspaceAccess(workspace, sid);

      SECURITY_CAPABILITIES securityCapabilities = new SECURITY_CAPABILITIES();
      securityCapabilities.AppContainerSid = sid;
      securityCapabilities.Capabilities = IntPtr.Zero;
      securityCapabilities.CapabilityCount = 0;

      STARTUPINFOEX startupInfo = new STARTUPINFOEX();
      startupInfo.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      IntPtr attributeListSize = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
      startupInfo.lpAttributeList = Marshal.AllocHGlobal(attributeListSize);
      if (!InitializeProcThreadAttributeList(startupInfo.lpAttributeList, 1, 0, ref attributeListSize)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList failed.");
      }

      IntPtr capabilitiesPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
      Marshal.StructureToPtr(securityCapabilities, capabilitiesPtr, false);
      if (!UpdateProcThreadAttribute(startupInfo.lpAttributeList, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capabilitiesPtr, new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))), IntPtr.Zero, IntPtr.Zero)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute failed.");
      }

      PROCESS_INFORMATION processInfo;
      string commandLine = BuildCommandLine(nodePath, arguments);
      bool started = CreateProcessW(nodePath, commandLine, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, workspace, ref startupInfo, out processInfo);
      if (!started) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed.");
      }

      IntPtr job = CreateJobObject(IntPtr.Zero, null);
      if (job != IntPtr.Zero) {
        ApplyJobLimits(job);
        AssignProcessToJobObject(job, processInfo.hProcess);
      }
      WaitForSingleObject(processInfo.hProcess, INFINITE);
      int exitCode;
      if (!GetExitCodeProcess(processInfo.hProcess, out exitCode)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed.");
      }
      CloseHandle(processInfo.hThread);
      CloseHandle(processInfo.hProcess);
      if (job != IntPtr.Zero) {
        CloseHandle(job);
      }
      DeleteProcThreadAttributeList(startupInfo.lpAttributeList);
      Marshal.FreeHGlobal(startupInfo.lpAttributeList);
      Marshal.FreeHGlobal(capabilitiesPtr);
      return exitCode;
    } finally {
      if (sid != IntPtr.Zero) {
        FreeSid(sid);
      }
      DeleteAppContainerProfile(profileName);
    }
  }

  private static void GrantWorkspaceAccess(string workspace, IntPtr sid) {
    var security = System.IO.Directory.GetAccessControl(workspace);
    var account = new SecurityIdentifier(sid);
    security.AddAccessRule(new FileSystemAccessRule(account, FileSystemRights.Modify | FileSystemRights.Synchronize, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    System.IO.Directory.SetAccessControl(workspace, security);
  }

  private static void ApplyJobLimits(IntPtr job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    IntPtr limitsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
    try {
      Marshal.StructureToPtr(limits, limitsPtr, false);
      SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsPtr, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
    } finally {
      Marshal.FreeHGlobal(limitsPtr);
    }
  }

  private static string BuildCommandLine(string executable, string[] arguments) {
    StringBuilder builder = new StringBuilder();
    builder.Append(QuoteCommandLineArgument(executable));
    foreach (string argument in arguments) {
      builder.Append(' ');
      builder.Append(QuoteCommandLineArgument(argument));
    }
    return builder.ToString();
  }

  private static string QuoteCommandLineArgument(string value) {
    if (value.Length == 0) {
      return "\"\"";
    }
    StringBuilder builder = new StringBuilder();
    builder.Append('"');
    int backslashes = 0;
    foreach (char character in value) {
      if (character == '\\') {
        backslashes++;
        continue;
      }
      if (character == '"') {
        builder.Append('\\', backslashes * 2 + 1);
        builder.Append('"');
        backslashes = 0;
        continue;
      }
      builder.Append('\\', backslashes);
      builder.Append(character);
      backslashes = 0;
    }
    builder.Append('\\', backslashes * 2);
    builder.Append('"');
    return builder.ToString();
  }
}
"@

exit [GoatCitadelAppContainerLauncher]::Launch($profileName, $displayName, $workspace, $nodePath, $arguments)
`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
