import { execFile, type ChildProcess } from "node:child_process";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildScrubbedSpawnEnv } from "@goatcitadel/contracts";

const execFileAsync = promisify(execFile);
export interface BackgroundProcessIdentity {
  version: "background-process.identity.v1";
  platform: "win32";
  host: string;
  pid: number;
  creationFileTime: string;
  sessionId: string;
  turnId: string;
}
export type RecoveredProcessCleanupOutcome =
  | "terminated"
  | "termination_pending"
  | "missing"
  | "identity_mismatch"
  | "unavailable"
  | "unsupported";

/** Capture while the original ChildProcess handle is still live. The retained
 * result is diagnostic until the exact settled child owner asks for cleanup. */
export async function captureBackgroundProcessIdentity(
  child: ChildProcess,
  owner: { sessionId: string; turnId?: string },
): Promise<BackgroundProcessIdentity | undefined> {
  if (
    process.platform !== "win32" ||
    !owner.sessionId.trim() ||
    !owner.turnId?.trim() ||
    !validPid(child.pid) ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return undefined;
  const observed = await windowsProcessIdentityOperation(child.pid);
  if (!observed.startsWith("running:") || child.exitCode !== null || child.signalCode !== null) return undefined;
  const creationFileTime = observed.slice("running:".length);
  if (!/^[1-9][0-9]{10,19}$/u.test(creationFileTime)) return undefined;
  return {
    version: "background-process.identity.v1",
    platform: "win32",
    host: hostname(),
    pid: child.pid,
    creationFileTime,
    sessionId: owner.sessionId,
    turnId: owner.turnId,
  };
}

export function readBackgroundProcessIdentity(
  value: unknown,
  owner: { sessionId: string; turnId: string },
): BackgroundProcessIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(",") !== "creationFileTime,host,pid,platform,sessionId,turnId,version" ||
    input.version !== "background-process.identity.v1" ||
    input.platform !== "win32" ||
    !validPid(input.pid) ||
    typeof input.host !== "string" ||
    !input.host ||
    input.host.length > 256 ||
    typeof input.creationFileTime !== "string" ||
    !/^[1-9][0-9]{10,19}$/u.test(input.creationFileTime) ||
    input.sessionId !== owner.sessionId ||
    input.turnId !== owner.turnId ||
    !owner.sessionId.trim() ||
    !owner.turnId.trim()
  )
    return undefined;
  return input as unknown as BackgroundProcessIdentity;
}

/** Query and terminate the SAME native handle. Never fall back to taskkill or
 * process.kill after a restart: a PID alone cannot establish ownership. This
 * terminates the recorded process only; it does not certify descendant cleanup. */
export async function cleanupRecoveredBackgroundProcess(
  value: unknown,
  owner: { sessionId: string; turnId: string },
): Promise<RecoveredProcessCleanupOutcome> {
  const identity = readBackgroundProcessIdentity(value, owner);
  if (!identity || identity.host !== hostname() || identity.pid === process.pid) return "identity_mismatch";
  if (process.platform !== "win32") return "unsupported";
  const result = await windowsProcessIdentityOperation(identity.pid, identity.creationFileTime);
  return ["terminated", "termination_pending", "missing", "identity_mismatch"].includes(result)
    ? (result as RecoveredProcessCleanupOutcome)
    : "unavailable";
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 4 && (value as number) <= 0xffffffff;
}

async function windowsProcessIdentityOperation(pid: number, expectedCreation?: string): Promise<string> {
  if (!validPid(pid) || (expectedCreation !== undefined && !/^[1-9][0-9]{10,19}$/u.test(expectedCreation)))
    return "unavailable";
  // Capturing a live child's creation time needs no dynamic C# compilation.
  // Cleanup still compares and terminates through the same native handle below.
  // No shell command, user source, command line, or secret is interpolated.
  const script =
    expectedCreation === undefined
      ? `
$ErrorActionPreference = 'Stop'
$ownedProcess = [System.Diagnostics.Process]::GetProcessById(${pid})
try {
  if ($ownedProcess.HasExited) { 'missing' }
  else {
    $created = $ownedProcess.StartTime.ToFileTimeUtc()
    if ($ownedProcess.HasExited) { 'missing' }
    else { 'running:' + $created.ToString([System.Globalization.CultureInfo]::InvariantCulture) }
  }
} finally {
  $ownedProcess.Dispose()
}
`
      : `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class GCBackgroundProcessIdentity {
  [DllImport("kernel32.dll", SetLastError=true)] static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(SafeProcessHandle handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(SafeProcessHandle handle, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);
  public static string Run(uint pid, string expected) {
    using (SafeProcessHandle handle = OpenProcess(expected.Length == 0 ? 0x101000u : 0x101001u, false, pid)) {
      if (handle.IsInvalid) return Marshal.GetLastWin32Error() == 87 ? "missing" : "unavailable";
      if (WaitForSingleObject(handle, 0) == 0) return "missing";
      long created, exited, kernel, user;
      if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) return "unavailable";
      string identity = created.ToString(System.Globalization.CultureInfo.InvariantCulture);
      if (expected.Length == 0) return "running:" + identity;
      if (!String.Equals(identity, expected, StringComparison.Ordinal)) return "identity_mismatch";
      if (!TerminateProcess(handle, 1)) return WaitForSingleObject(handle, 0) == 0 ? "missing" : "unavailable";
      return WaitForSingleObject(handle, 3000) == 0 ? "terminated" : "termination_pending";
    }
  }
}
'@
[GCBackgroundProcessIdentity]::Run([uint32]${pid}, '${expectedCreation ?? ""}')
`;
  try {
    const executable = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const result = await execFileAsync(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 16_384,
        encoding: "utf8",
        env: buildScrubbedSpawnEnv(process.env),
      },
    );
    return result.stdout.trim();
  } catch {
    return "unavailable";
  }
}
