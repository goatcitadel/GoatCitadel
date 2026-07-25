import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const OWNER_SID = /^S-\d+(?:-\d+)+$/u;
const MAX_PATH_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const IDLE_SHUTDOWN_MS = 100;

export type ExternalSourceWindowsSecurityErrorCode =
  | "cancelled"
  | "command_failed"
  | "invalid_path"
  | "invalid_response";

export class ExternalSourceWindowsSecurityError extends Error {
  public constructor(public readonly code: ExternalSourceWindowsSecurityErrorCode) {
    super("External source Windows security operation failed.");
    this.name = "ExternalSourceWindowsSecurityError";
  }
}

export type ExternalSourceWindowsAclKind = "directory" | "file";

export interface ExternalSourceWindowsAclResult {
  ownerSid: string;
}

export interface ExternalSourceWindowsSecurityPort {
  inspectReparsePoint(absolutePath: string, signal: AbortSignal): Promise<boolean>;
  applyOwnerOnlyAcl(
    absolutePath: string,
    kind: ExternalSourceWindowsAclKind,
    signal: AbortSignal,
  ): Promise<ExternalSourceWindowsAclResult>;
}

export interface ExternalSourceWindowsSecurityProtocol {
  request(
    operation: "acl" | "attributes",
    absolutePath: string,
    kind: ExternalSourceWindowsAclKind,
    signal: AbortSignal,
  ): Promise<string>;
}

/**
 * Windows path security that delegates only the missing native primitives to a
 * static PowerShell worker. Paths are UTF-8/base64 protocol data written on
 * stdin; they are never interpolated into command text or a shell command.
 */
export class NodeExternalSourceWindowsSecurity implements ExternalSourceWindowsSecurityPort {
  public constructor(
    private readonly protocol: ExternalSourceWindowsSecurityProtocol = new PowerShellWindowsSecurityProtocol(),
  ) {}

  public async inspectReparsePoint(absolutePath: string, signal: AbortSignal): Promise<boolean> {
    assertRequest(absolutePath, signal);
    const response = await this.safeRequest("attributes", absolutePath, "file", signal);
    if (!/^(?:0|[1-9]\d{0,15})$/u.test(response)) {
      throw new ExternalSourceWindowsSecurityError("invalid_response");
    }
    const attributes = Number(response);
    if (!Number.isSafeInteger(attributes) || attributes < 0) {
      throw new ExternalSourceWindowsSecurityError("invalid_response");
    }
    return (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0;
  }

  public async applyOwnerOnlyAcl(
    absolutePath: string,
    kind: ExternalSourceWindowsAclKind,
    signal: AbortSignal,
  ): Promise<ExternalSourceWindowsAclResult> {
    assertRequest(absolutePath, signal);
    if (kind !== "directory" && kind !== "file") {
      throw new ExternalSourceWindowsSecurityError("invalid_response");
    }
    const ownerSid = await this.safeRequest("acl", absolutePath, kind, signal);
    if (!OWNER_SID.test(ownerSid)) {
      throw new ExternalSourceWindowsSecurityError("invalid_response");
    }
    return { ownerSid };
  }

  private async safeRequest(
    operation: "acl" | "attributes",
    absolutePath: string,
    kind: ExternalSourceWindowsAclKind,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const response = await this.protocol.request(operation, absolutePath, kind, signal);
      if (signal.aborted) throw new ExternalSourceWindowsSecurityError("cancelled");
      return response;
    } catch (error) {
      if (error instanceof ExternalSourceWindowsSecurityError) throw error;
      if (signal.aborted) throw new ExternalSourceWindowsSecurityError("cancelled");
      throw new ExternalSourceWindowsSecurityError("command_failed");
    }
  }
}

interface PendingRequest {
  resolve(value: string): void;
  reject(error: ExternalSourceWindowsSecurityError): void;
  signal: AbortSignal;
  abortHandler: () => void;
  timeout: ReturnType<typeof setTimeout>;
}

class PowerShellWindowsSecurityProtocol implements ExternalSourceWindowsSecurityProtocol {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextRequestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private stdoutBuffer = "";
  private stderrBytes = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  public async request(
    operation: "acl" | "attributes",
    absolutePath: string,
    kind: ExternalSourceWindowsAclKind,
    signal: AbortSignal,
  ): Promise<string> {
    if (process.platform !== "win32") {
      throw new ExternalSourceWindowsSecurityError("command_failed");
    }
    if (signal.aborted) throw new ExternalSourceWindowsSecurityError("cancelled");
    const child = this.ensureChild();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const requestId = String((this.nextRequestId += 1));
    const encodedPath = Buffer.from(absolutePath, "utf8").toString("base64");
    const line = `${requestId}|${operation}|${kind}|${encodedPath}\n`;

    return new Promise<string>((resolve, reject) => {
      const abortHandler = () => {
        this.failWorker(new ExternalSourceWindowsSecurityError("cancelled"));
      };
      const timeout = setTimeout(() => {
        this.failWorker(new ExternalSourceWindowsSecurityError("command_failed"));
      }, REQUEST_TIMEOUT_MS);
      timeout.unref();
      this.pending.set(requestId, { resolve, reject, signal, abortHandler, timeout });
      signal.addEventListener("abort", abortHandler, { once: true });
      child.stdin.write(line, "utf8", (error) => {
        if (error && this.child === child) {
          this.failWorker(new ExternalSourceWindowsSecurityError("command_failed"));
        }
      });
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    this.stdoutBuffer = "";
    this.stderrBytes = 0;
    const child = spawn(
      windowsPowerShellExecutable(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_SECURITY_SCRIPT_ENCODED],
      {
        env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: "1" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child === child) this.handleStdout(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      this.stderrBytes += chunk.byteLength;
      if (this.stderrBytes > 64 * 1024) {
        this.failWorker(new ExternalSourceWindowsSecurityError("command_failed"));
      }
    });
    child.once("error", () => {
      if (this.child === child) {
        this.failWorker(new ExternalSourceWindowsSecurityError("command_failed"));
      }
    });
    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.pending.size > 0) {
        this.rejectPending(new ExternalSourceWindowsSecurityError("command_failed"));
      }
    });
    return child;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > 128 * 1024) {
      this.failWorker(new ExternalSourceWindowsSecurityError("invalid_response"));
      return;
    }
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer
        .slice(0, newline)
        .replace(/\r$/u, "")
        .replace(/^\uFEFF/u, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.handleResponseLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleResponseLine(line: string): void {
    const match = /^(\d+)\|(OK|ERR)\|([^\r\n|]*)$/u.exec(line);
    if (!match?.[1] || !match[2]) {
      this.failWorker(new ExternalSourceWindowsSecurityError("invalid_response"));
      return;
    }
    const pending = this.pending.get(match[1]);
    if (!pending) {
      this.failWorker(new ExternalSourceWindowsSecurityError("invalid_response"));
      return;
    }
    this.pending.delete(match[1]);
    clearTimeout(pending.timeout);
    pending.signal.removeEventListener("abort", pending.abortHandler);
    if (match[2] === "ERR") {
      pending.reject(new ExternalSourceWindowsSecurityError("command_failed"));
    } else {
      pending.resolve(match[3] ?? "");
    }
    this.scheduleIdleShutdown();
  }

  private scheduleIdleShutdown(): void {
    if (this.pending.size > 0 || !this.child) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.pending.size === 0) this.stopChild();
    }, IDLE_SHUTDOWN_MS);
    this.idleTimer.unref();
  }

  private failWorker(error: ExternalSourceWindowsSecurityError): void {
    this.stopChild();
    this.rejectPending(error);
  }

  private rejectPending(error: ExternalSourceWindowsSecurityError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.signal.removeEventListener("abort", pending.abortHandler);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private stopChild(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin.destroy();
    child.kill();
  }
}

function assertRequest(absolutePath: string, signal: AbortSignal): void {
  if (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function") {
    throw new TypeError("External source Windows security AbortSignal is required.");
  }
  if (signal.aborted) throw new ExternalSourceWindowsSecurityError("cancelled");
  if (
    typeof absolutePath !== "string" ||
    !path.isAbsolute(absolutePath) ||
    absolutePath.includes("\u0000") ||
    Buffer.byteLength(absolutePath, "utf8") > MAX_PATH_BYTES
  ) {
    throw new ExternalSourceWindowsSecurityError("invalid_path");
  }
}

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot) || systemRoot.startsWith("\\\\")) {
    throw new ExternalSourceWindowsSecurityError("command_failed");
  }
  const normalizedRoot = path.win32.resolve(systemRoot);
  if (normalizedRoot !== systemRoot.replace(/[\\/]+$/u, "")) {
    throw new ExternalSourceWindowsSecurityError("command_failed");
  }
  return path.win32.join(normalizedRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const WINDOWS_SECURITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Write-ProtocolResponse([string]$RequestId, [string]$Status, [string]$Value) {
  [Console]::Out.WriteLine($RequestId + '|' + $Status + '|' + $Value)
  [Console]::Out.Flush()
}

while (($Line = [Console]::In.ReadLine()) -ne $null) {
  $Parts = $Line.Split('|')
  $RequestId = if ($Parts.Length -gt 0) { $Parts[0] } else { '0' }
  try {
    if ($Parts.Length -ne 4 -or $RequestId -notmatch '^\d+$') { throw 'invalid protocol' }
    $Operation = $Parts[1]
    $Kind = $Parts[2]
    $Path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Parts[3]))
    $Attributes = [IO.File]::GetAttributes($Path)

    if ($Operation -eq 'attributes') {
      Write-ProtocolResponse $RequestId 'OK' ([string][int64]$Attributes)
      continue
    }
    if ($Operation -ne 'acl' -or ($Kind -ne 'directory' -and $Kind -ne 'file')) {
      throw 'invalid operation'
    }
    if (($Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'reparse point rejected'
    }

    $Owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($null -eq $Owner) { throw 'owner SID unavailable' }
    $IsDirectory = (($Attributes -band [IO.FileAttributes]::Directory) -ne 0)
    if (($Kind -eq 'directory') -ne $IsDirectory) { throw 'filesystem kind mismatch' }
    $Item = if ($Kind -eq 'directory') { [IO.DirectoryInfo]::new($Path) } else { [IO.FileInfo]::new($Path) }
    $Acl = $Item.GetAccessControl()
    $Acl.SetAccessRuleProtection($true, $false)
    foreach ($ExistingRule in @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
      [void]$Acl.RemoveAccessRuleSpecific($ExistingRule)
    }
    $Inheritance = if ($Kind -eq 'directory') {
      [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
      [Security.AccessControl.InheritanceFlags]::None
    }
    $Rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $Owner,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $Inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$Acl.AddAccessRule($Rule)
    $Acl.SetOwner($Owner)
    $Item.SetAccessControl($Acl)

    $VerifiedItem = if ($Kind -eq 'directory') { [IO.DirectoryInfo]::new($Path) } else { [IO.FileInfo]::new($Path) }
    $Verified = $VerifiedItem.GetAccessControl()
    $VerifiedOwner = $Verified.GetOwner([Security.Principal.SecurityIdentifier])
    $VerifiedRules = @($Verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $Verified.AreAccessRulesProtected -or $VerifiedOwner.Value -ne $Owner.Value -or $VerifiedRules.Count -ne 1) {
      throw 'ACL verification failed'
    }
    $VerifiedRule = $VerifiedRules[0]
    if (
      $VerifiedRule.IsInherited -or
      $VerifiedRule.IdentityReference.Value -ne $Owner.Value -or
      $VerifiedRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      $VerifiedRule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
      $VerifiedRule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
      $VerifiedRule.InheritanceFlags -ne $Inheritance
    ) {
      throw 'ACL rule verification failed'
    }
    $VerifiedAttributes = [IO.File]::GetAttributes($Path)
    if (($VerifiedAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'reparse point rejected after ACL update'
    }
    Write-ProtocolResponse $RequestId 'OK' $Owner.Value
  } catch {
    Write-ProtocolResponse $RequestId 'ERR' ''
  }
}
`;

const WINDOWS_SECURITY_SCRIPT_ENCODED = Buffer.from(WINDOWS_SECURITY_SCRIPT, "utf16le").toString("base64");
