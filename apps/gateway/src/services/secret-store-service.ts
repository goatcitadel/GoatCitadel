import { spawnSync } from "node:child_process";
import { GoatError } from "@goatcitadel/contracts";

const SECRET_SERVICE = "goatcitadel";
const DISABLE_SECRET_STORE_ENV = "GOATCITADEL_DISABLE_SECRET_STORE";

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

export function isSecretStoreUnavailableLikeError(error: unknown): boolean {
  if (error instanceof SecretStoreUnavailableError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return [
    /secure keychain is unavailable/i,
    /secret store unavailable/i,
    /passwordvault/i,
    /windows\.security\.credentials/i,
    /system\.runtime\.windowsruntime/i,
  ].some((pattern) => pattern.test(error.message));
}

export class SecretStoreService {
  public isAvailable(): boolean {
    if (isSecretStoreExplicitlyDisabled()) {
      return false;
    }
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
    this.setSecret(providerAccount(providerId), apiKey);
  }

  public getProviderApiKey(providerId: string): string | undefined {
    assertProviderId(providerId);
    return this.getSecret(providerAccount(providerId));
  }

  public deleteProviderApiKey(providerId: string): void {
    assertProviderId(providerId);
    this.deleteSecret(providerAccount(providerId));
  }

  public setSecret(account: string, secret: string): void {
    assertSecretAccount(account);
    if (!secret.trim()) {
      throw new Error("secret must not be empty");
    }
    this.assertAvailable();
    if (process.platform === "win32") {
      this.setWindowsCredential(account, secret);
      return;
    }
    if (process.platform === "darwin") {
      this.setMacCredential(account, secret);
      return;
    }
    this.setLinuxCredential(account, secret);
  }

  public getSecret(account: string): string | undefined {
    assertSecretAccount(account);
    this.assertAvailable();
    if (process.platform === "win32") {
      return this.getWindowsCredential(account);
    }
    if (process.platform === "darwin") {
      return this.getMacCredential(account);
    }
    return this.getLinuxCredential(account);
  }

  public deleteSecret(account: string): void {
    assertSecretAccount(account);
    this.assertAvailable();
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
[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
[Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
$vault = [Windows.Security.Credentials.PasswordVault]::new()
try { $existing = $vault.Retrieve($env:GOATCITADEL_SECRET_SERVICE, $env:GOATCITADEL_SECRET_ACCOUNT); $vault.Remove($existing) } catch {}
$credential = [Windows.Security.Credentials.PasswordCredential]::new($env:GOATCITADEL_SECRET_SERVICE, $env:GOATCITADEL_SECRET_ACCOUNT, $env:GOATCITADEL_SECRET_VALUE)
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
[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
$vault = [Windows.Security.Credentials.PasswordVault]::new()
try {
  $credential = $vault.Retrieve($env:GOATCITADEL_SECRET_SERVICE, $env:GOATCITADEL_SECRET_ACCOUNT)
  $credential.RetrievePassword()
  Write-Output $credential.Password
} catch {
  exit 3
}
`;
    const result = runCommand(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        GOATCITADEL_SECRET_SERVICE: SECRET_SERVICE,
        GOATCITADEL_SECRET_ACCOUNT: account,
      },
      { allowExitCodes: [3] },
    );
    if (result.status === 3) {
      return undefined;
    }
    const value = result.stdout.trim();
    return value || undefined;
  }

  private deleteWindowsCredential(account: string): void {
    const script = `
[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
$vault = [Windows.Security.Credentials.PasswordVault]::new()
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
    runCommand("security", ["add-generic-password", "-a", account, "-s", SECRET_SERVICE, "-w", secret, "-U"]);
  }

  private getMacCredential(account: string): string | undefined {
    const result = runCommand(
      "security",
      ["find-generic-password", "-a", account, "-s", SECRET_SERVICE, "-w"],
      undefined,
      { allowExitCodes: [44] },
    );
    if (result.status === 44) {
      return undefined;
    }
    const value = result.stdout.trim();
    return value || undefined;
  }

  private deleteMacCredential(account: string): void {
    runCommand("security", ["delete-generic-password", "-a", account, "-s", SECRET_SERVICE], undefined, {
      allowExitCodes: [44],
    });
  }

  private setLinuxCredential(account: string, secret: string): void {
    runCommand(
      "secret-tool",
      ["store", "--label", "GoatCitadel Provider Secret", "service", SECRET_SERVICE, "account", account],
      undefined,
      { stdin: secret },
    );
  }

  private getLinuxCredential(account: string): string | undefined {
    const result = runCommand("secret-tool", ["lookup", "service", SECRET_SERVICE, "account", account], undefined, {
      allowExitCodes: [1],
    });
    if (result.status === 1) {
      return undefined;
    }
    const value = result.stdout.trim();
    return value || undefined;
  }

  private deleteLinuxCredential(account: string): void {
    runCommand("secret-tool", ["clear", "service", SECRET_SERVICE, "account", account], undefined, {
      allowExitCodes: [1],
    });
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

function assertSecretAccount(account: string): void {
  if (!account.trim()) {
    throw new Error("secret account is required");
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

function isSecretStoreExplicitlyDisabled(): boolean {
  const raw = process.env[DISABLE_SECRET_STORE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
