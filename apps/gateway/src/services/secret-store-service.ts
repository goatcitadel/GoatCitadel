import { spawnSync } from "node:child_process";
import { GoatError } from "@goatcitadel/contracts";

const SECRET_SERVICE = "goatcitadel";

export type SecretSource = "none" | "keychain";

export interface ProviderSecretStatus {
  providerId: string;
  hasSecret: boolean;
  source: SecretSource;
}

export class SecretStoreUnavailableError extends GoatError {
  readonly code = "SECRET_STORE_UNAVAILABLE" as const;
  readonly httpStatus = 503;
  public constructor(message: string) {
    super(message);
  }
}

export class SecretStoreService {
  public isAvailable(): boolean {
    if (process.platform === "win32") {
      return hasCommand("powershell");
    }
    if (process.platform === "darwin") {
      return hasCommand("security");
    }
    return hasCommand("secret-tool");
  }

  public setProviderApiKey(providerId: string, apiKey: string): void {
    assertProviderId(providerId);
    if (!apiKey.trim()) {
      throw new Error("apiKey must not be empty");
    }
    this.assertAvailable();
    const account = providerAccount(providerId);
    if (process.platform === "win32") {
      this.setWindowsCredential(account, apiKey);
      return;
    }
    if (process.platform === "darwin") {
      this.setMacCredential(account, apiKey);
      return;
    }
    this.setLinuxCredential(account, apiKey);
  }

  public getProviderApiKey(providerId: string): string | undefined {
    assertProviderId(providerId);
    this.assertAvailable();
    const account = providerAccount(providerId);
    if (process.platform === "win32") {
      return this.getWindowsCredential(account);
    }
    if (process.platform === "darwin") {
      return this.getMacCredential(account);
    }
    return this.getLinuxCredential(account);
  }

  public deleteProviderApiKey(providerId: string): void {
    assertProviderId(providerId);
    this.assertAvailable();
    const account = providerAccount(providerId);
    if (process.platform === "win32") {
      this.deleteWindowsCredential(account);
      return;
    }
    if (process.platform === "darwin") {
      this.deleteMacCredential(account);
      return;
    }
    this.deleteLinuxCredential(account);
  }

  public status(providerId: string): ProviderSecretStatus {
    assertProviderId(providerId);
    try {
      const value = this.getProviderApiKey(providerId);
      if (value && value.trim()) {
        return { providerId, hasSecret: true, source: "keychain" };
      }
      return { providerId, hasSecret: false, source: "none" };
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        return { providerId, hasSecret: false, source: "none" };
      }
      return { providerId, hasSecret: false, source: "none" };
    }
  }

  private assertAvailable(): void {
    if (!this.isAvailable()) {
      throw new SecretStoreUnavailableError("OS keychain backend is unavailable on this host");
    }
  }

  private setWindowsCredential(account: string, secret: string): void {
    const script = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$vault = New-Object Windows.Security.Credentials.PasswordVault
try { $existing = $vault.Retrieve($env:GOATCITADEL_SECRET_SERVICE, $env:GOATCITADEL_SECRET_ACCOUNT); $vault.Remove($existing) } catch {}
$credential = New-Object Windows.Security.Credentials.PasswordCredential($env:GOATCITADEL_SECRET_SERVICE, $env:GOATCITADEL_SECRET_ACCOUNT, $env:GOATCITADEL_SECRET_VALUE)
$vault.Add($credential)
Write-Output "ok"
`;
    runCommand("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      GOATCITADEL_SECRET_SERVICE: SECRET_SERVICE,
      GOATCITADEL_SECRET_ACCOUNT: account,
      GOATCITADEL_SECRET_VALUE: secret,
    });
  }

  private getWindowsCredential(account: string): string | undefined {
    const script = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$vault = New-Object Windows.Security.Credentials.PasswordVault
try {
  $credential = $vault.Retrieve($env:GOATCITADEL_SECRET_SERVICE, $env:GOATCITADEL_SECRET_ACCOUNT)
  $credential.RetrievePassword()
  Write-Output $credential.Password
} catch {
  exit 3
}
`;
    const result = runCommand("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      GOATCITADEL_SECRET_SERVICE: SECRET_SERVICE,
      GOATCITADEL_SECRET_ACCOUNT: account,
    }, { allowExitCodes: [3] });
    if (result.status === 3) {
      return undefined;
    }
    const value = result.stdout.trim();
    return value || undefined;
  }

  private deleteWindowsCredential(account: string): void {
    const script = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$vault = New-Object Windows.Security.Credentials.PasswordVault
try {
  $credential = $vault.Retrieve($env:GOATCITADEL_SECRET_SERVICE, $env:GOATCITADEL_SECRET_ACCOUNT)
  $vault.Remove($credential)
} catch {}
Write-Output "ok"
`;
    runCommand("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      GOATCITADEL_SECRET_SERVICE: SECRET_SERVICE,
      GOATCITADEL_SECRET_ACCOUNT: account,
    });
  }

  private setMacCredential(account: string, secret: string): void {
    runCommand("security", [
      "add-generic-password",
      "-a",
      account,
      "-s",
      SECRET_SERVICE,
      "-w",
      secret,
      "-U",
    ]);
  }

  private getMacCredential(account: string): string | undefined {
    const result = runCommand("security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      SECRET_SERVICE,
      "-w",
    ], undefined, { allowExitCodes: [44] });
    if (result.status === 44) {
      return undefined;
    }
    const value = result.stdout.trim();
    return value || undefined;
  }

  private deleteMacCredential(account: string): void {
    runCommand("security", [
      "delete-generic-password",
      "-a",
      account,
      "-s",
      SECRET_SERVICE,
    ], undefined, { allowExitCodes: [44] });
  }

  private setLinuxCredential(account: string, secret: string): void {
    runCommand("secret-tool", [
      "store",
      "--label",
      "GoatCitadel Provider Secret",
      "service",
      SECRET_SERVICE,
      "account",
      account,
    ], undefined, { stdin: secret });
  }

  private getLinuxCredential(account: string): string | undefined {
    const result = runCommand("secret-tool", [
      "lookup",
      "service",
      SECRET_SERVICE,
      "account",
      account,
    ], undefined, { allowExitCodes: [1] });
    if (result.status === 1) {
      return undefined;
    }
    const value = result.stdout.trim();
    return value || undefined;
  }

  private deleteLinuxCredential(account: string): void {
    runCommand("secret-tool", [
      "clear",
      "service",
      SECRET_SERVICE,
      "account",
      account,
    ], undefined, { allowExitCodes: [1] });
  }
}

function providerAccount(providerId: string): string {
  return `provider:${providerId.trim().toLowerCase()}`;
}

function assertProviderId(providerId: string): void {
  if (!providerId.trim()) {
    throw new Error("providerId is required");
  }
}

function hasCommand(command: string): boolean {
  const whichCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(whichCommand, [command], { stdio: "ignore" });
  return result.status === 0;
}

interface RunOptions {
  allowExitCodes?: number[];
  stdin?: string;
}

function runCommand(
  command: string,
  args: string[],
  envOverrides?: Record<string, string>,
  options: RunOptions = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(envOverrides ?? {}),
    },
    input: options.stdin,
  });
  const status = result.status ?? 1;
  const allowed = new Set([0, ...(options.allowExitCodes ?? [])]);
  if (!allowed.has(status)) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    const details = stderr || stdout || `exit code ${status}`;
    throw new Error(`${command} failed: ${details}`);
  }
  return {
    status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
