import { execFile, spawnSync, type ExecFileException } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SecretStoreService,
  SecretStoreUnavailableError,
  isSecretStoreUnavailableLikeError,
  resetCommandAvailabilityCache,
  runCommand,
} from "./secret-store-service.js";
import { encodeMcpCredentialReceipt } from "./mcp-credential-receipt.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawnSync: vi.fn(),
}));

const execFileMock = vi.mocked(execFile);
const spawnSyncMock = vi.mocked(spawnSync);
type KeychainReadCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;
type NativeReadCallback = (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => void;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalExecPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
const originalDisableSecretStore = process.env.GOATCITADEL_DISABLE_SECRET_STORE;

beforeEach(() => {
  delete process.env.GOATCITADEL_DISABLE_SECRET_STORE;
  resetCommandAvailabilityCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  execFileMock.mockReset();
  spawnSyncMock.mockReset();
  Object.defineProperty(process, "execPath", originalExecPath);
  Object.defineProperty(process, "arch", originalArch);
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  if (originalDisableSecretStore === undefined) {
    delete process.env.GOATCITADEL_DISABLE_SECRET_STORE;
  } else {
    process.env.GOATCITADEL_DISABLE_SECRET_STORE = originalDisableSecretStore;
  }
});

function enablePackagedNativeRead(): string {
  setPlatform("win32");
  Object.defineProperty(process, "arch", { ...originalArch, value: "x64" });
  Object.defineProperty(process, "execPath", {
    ...originalExecPath, value: fileURLToPath(new URL("../../../runtime/node/node.exe", import.meta.url)),
  });
  const profile = `goatcitadel.desktop.${"a".repeat(64)}.11111111-2222-4333-8444-555555555555`;
  vi.stubEnv("GOATCITADEL_WINDOWS_PROFILE_RESOURCE", profile);
  vi.stubEnv("GOATCITADEL_NATIVE_WINDOWS_CREDENTIAL_READ", "1");
  return profile;
}

describe("SecretStoreService", () => {
  it("reads the selected Windows vault without synchronously starting PowerShell", async () => {
    setPlatform("win32");
    const profile = `goatcitadel.desktop.${"a".repeat(64)}.11111111-2222-4333-8444-555555555555`;
    vi.stubEnv("GOATCITADEL_WINDOWS_PROFILE_RESOURCE", profile);
    vi.stubEnv("GOATCITADEL_AUTH_TOKEN", "fixture-parent-secret");
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never);
    const service = new SecretStoreService();
    const pending = service.getSecretAsync("provider:openai-codex:oauth");
    expect(spawnSyncMock.mock.calls.map(([command]) => command)).toEqual(["where"]);
    const [command, args, options, callback] = execFileMock.mock.calls[0]!;
    expect(command).toBe("powershell");
    expect(args?.at(-1)).toContain("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
    expect(options).toMatchObject({ windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, env: {
      GOATCITADEL_SECRET_SERVICE: profile, GOATCITADEL_SECRET_ACCOUNT: "provider:openai-codex:oauth",
    } });
    expect(JSON.stringify(options)).not.toContain("fixture-parent-secret");
    (callback as KeychainReadCallback)(null, "fixture-access\r\n", "");
    await expect(pending).resolves.toBe("fixture-access");
  });

  it("uses the packaged native reader with only the selected lookup and preserves Unicode", async () => {
    const profile = enablePackagedNativeRead();
    vi.stubEnv("GOATCITADEL_AUTH_TOKEN", "fixture-parent-secret");
    const account = "provider:openai-codex:oauth";
    const pending = new SecretStoreService().getSecretAsync(account);
    const [command, args, options, callback] = execFileMock.mock.calls[0]!;
    expect(command).toBe(fileURLToPath(new URL("../../../desktop/GoatCitadel-Credential-Read.exe", import.meta.url)));
    expect(args).toEqual([]);
    expect(options).toMatchObject({ encoding: "buffer", timeout: 1000, windowsHide: true, env: {
      GOATCITADEL_SECRET_SERVICE: profile, GOATCITADEL_SECRET_ACCOUNT: account,
    } });
    expect(JSON.stringify(options)).not.toContain("fixture-parent-secret");
    (callback as NativeReadCallback)(null, Buffer.from("秘密 café"), Buffer.alloc(0));
    await expect(pending).resolves.toBe("秘密 café");
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a confirmed native miss and falls back for an unavailable or malformed reader", async () => {
    const profile = enablePackagedNativeRead();
    const service = new SecretStoreService();
    const missing = service.getSecretAsync("test:missing");
    (execFileMock.mock.calls[0]![3] as NativeReadCallback)(Object.assign(new Error(), { code: 3 }), Buffer.alloc(0), Buffer.alloc(0));
    await expect(missing).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const unavailable = service.getSecretAsync("test:malformed");
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never);
    (execFileMock.mock.calls[1]![3] as NativeReadCallback)(null, Buffer.from([0xff]), Buffer.alloc(0));
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(3));
    const [command, , options, callback] = execFileMock.mock.calls[2]!;
    expect(command).toBe("powershell");
    expect(options).toMatchObject({ env: {
      GOATCITADEL_SECRET_SERVICE: profile, GOATCITADEL_SECRET_ACCOUNT: "test:malformed",
    } });
    (callback as KeychainReadCallback)(null, "fallback fixture\r\n", "");
    await expect(unavailable).resolves.toBe("fallback fixture");
  });

  it("respects explicit keychain disablement even when the packaged pilot is enabled", async () => {
    enablePackagedNativeRead();
    vi.stubEnv("GOATCITADEL_DISABLE_SECRET_STORE", "1");
    await expect(new SecretStoreService().getSecretAsync("test:disabled")).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("handles an absent Windows credential and redacts helper failures", async () => {
    setPlatform("win32");
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never);
    const service = new SecretStoreService();
    const missing = service.getSecretAsync("test:missing");
    const absent = Object.assign(new Error("exit 3"), { code: 3 });
    (execFileMock.mock.calls[0]![3] as KeychainReadCallback)(absent, "", "");
    await expect(missing).resolves.toBeUndefined();

    const failed = service.getSecretAsync("test:failure");
    const failure = Object.assign(new Error("fixture-private-diagnostic"), { code: 2 });
    (execFileMock.mock.calls[1]![3] as KeychainReadCallback)(failure, "fixture-private-output", "fixture-private-error");
    await expect(failed).rejects.toMatchObject({
      code: "SECRET_STORE_UNAVAILABLE", message: "Windows credential read failed.",
    });
    await expect(failed).rejects.not.toHaveProperty("cause");
  });

  it("keeps Windows reads and custody checks inside the selected desktop profile", () => {
    setPlatform("win32");
    const profile = `goatcitadel.desktop.${"a".repeat(64)}.11111111-2222-4333-8444-555555555555`;
    vi.stubEnv("GOATCITADEL_WINDOWS_PROFILE_RESOURCE", profile);
    const service = new SecretStoreService();
    spawnSyncMock
      .mockReturnValueOnce({ status: 0 } as never)
      .mockReturnValueOnce({ status: 3, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "b".repeat(64), stderr: "" } as never);

    expect(service.getProviderApiKey("openai")).toBeUndefined();
    expect(service.getCredentialCustodyId()).toBe("b".repeat(64));
    for (const [, , options] of spawnSyncMock.mock.calls.slice(1)) {
      expect(options?.env?.GOATCITADEL_SECRET_SERVICE).toBe(profile);
    }
  });

  it("keeps the completed-write receipt with its value in the original keychain slot", () => {
    setPlatform("win32");
    const id = "11111111-2222-4333-8444-555555555555", secret = "  private-receipt-value  ";
    const account = `mcp:fixture:environment:receipt-v1:${id}`, service = new SecretStoreService();
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never).mockReturnValueOnce({ status: 0, stdout: "ok", stderr: "" } as never);
    service.setSecretForCustody(account, secret, "a".repeat(64), id);
    const [, args, options] = spawnSyncMock.mock.calls[1]!;
    expect(options?.input).toBe(encodeMcpCredentialReceipt(secret, id));
    expect(JSON.stringify(args)).not.toContain(secret);
    expect(JSON.stringify(options?.env)).not.toContain(secret);
    // The where/which availability probe is memoized, so only the credential read reaches spawnSync.
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: encodeMcpCredentialReceipt(secret, id), stderr: "" } as never);
    expect(service.getSecret(account)).toBe(secret);
    spawnSyncMock.mockClear();
    expect(() => service.setSecret(account, secret)).toThrow("staged custody writer");
    expect(() => service.deleteSecret(account)).toThrow("canonical retirement owner");
    expect(service.deleteSecretForCustody(account, "a".repeat(64))).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    { stdout: "written", accepted: true }, { stdout: "absent", accepted: false }, { stdout: "mismatch", accepted: false },
  ])("accepts only a completed custody-bound write receipt: $stdout", ({ stdout, accepted }) => {
    setPlatform("win32");
    const id = "11111111-2222-4333-8444-555555555555", account = `mcp:fixture:access-token:receipt-v1:${id}`;
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never).mockReturnValueOnce({ status: 0, stdout, stderr: "" } as never);
    expect(new SecretStoreService().hasCredentialWriteReceipt(account, "a".repeat(64), id)).toBe(accepted);
    expect(spawnSyncMock.mock.calls[1]?.[2]?.env).toEqual(expect.objectContaining({
      GOATCITADEL_SECRET_WRITE_ID: id, GOATCITADEL_SECRET_RECEIPT_ACTION: "inspect" }));
  });

  it.each(["ok", "absent", "mismatch"])("checks the exact receipt when deleting a retired slot: %s", (stdout) => {
    setPlatform("win32");
    const id = "11111111-2222-4333-8444-555555555555", account = `mcp:fixture:access-token:receipt-v1:${id}`;
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never).mockReturnValueOnce({ status: 0, stdout, stderr: "" } as never);
    expect(new SecretStoreService().deleteSecretForCustody(account, "a".repeat(64), id)).toBe(stdout !== "mismatch");
    expect(spawnSyncMock.mock.calls[1]?.[2]?.env).toEqual(expect.objectContaining({
      GOATCITADEL_SECRET_WRITE_ID: id, GOATCITADEL_SECRET_RECEIPT_ACTION: "remove" }));
  });

  it("detects unavailable keychain errors and respects the explicit disable flag", () => {
    process.env.GOATCITADEL_DISABLE_SECRET_STORE = "yes";
    setPlatform("linux");

    const service = new SecretStoreService();

    expect(service.isAvailable()).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(isSecretStoreUnavailableLikeError(new SecretStoreUnavailableError("secure keychain is unavailable"))).toBe(
      true,
    );
    expect(isSecretStoreUnavailableLikeError(new Error("Cannot find type PasswordVault"))).toBe(true);
    expect(isSecretStoreUnavailableLikeError("not an error")).toBe(false);
  });

  it("captures only an opaque Windows custodian and keeps bound writes out of argv and environment", () => {
    setPlatform("win32");
    const custodyId = "a".repeat(64), secret = "private-custody-value";
    const service = new SecretStoreService();
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never)
      .mockReturnValueOnce({ status: 0, stdout: custodyId + "\n", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "ok\n", stderr: "" } as never);
    expect(service.getCredentialCustodyId()).toBe(custodyId);
    service.setSecretForCustody("mcp:fixture:environment:version", secret, custodyId);
    const [, args, options] = spawnSyncMock.mock.calls[2]!;
    expect(JSON.stringify(args)).not.toContain(secret);
    expect(JSON.stringify(options?.env)).not.toContain(secret);
    expect(options).toEqual(expect.objectContaining({ input: secret, timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true,
      env: expect.objectContaining({ GOATCITADEL_SECRET_CUSTODY: custodyId, GOATCITADEL_SECRET_SERVICE: "goatcitadel" }) }));
  });

  it.each(["win32", "linux", "darwin"] as const)("refuses unowned cleanup without opening a keychain on %s", (platform) => {
    setPlatform(platform);
    const service = new SecretStoreService();
    expect(service.deleteSecretForCustody("mcp:fixture:environment:version", null)).toBe(false);
    if (platform !== "win32") {
      expect(service.getCredentialCustodyId()).toBeUndefined();
      expect(service.deleteSecretForCustody("mcp:fixture:environment:version", "a".repeat(64))).toBe(false);
    }
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    { status: 0, stdout: "ok", expected: true },
    { status: 0, stdout: "absent", expected: true },
    { status: 4, stdout: "custody_mismatch", expected: false },
  ])("requires a custody-aware delete receipt: $stdout", ({ status, stdout, expected }) => {
    setPlatform("win32");
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never).mockReturnValueOnce({ status, stdout, stderr: "" } as never);
    expect(new SecretStoreService().deleteSecretForCustody("mcp:fixture:access-token:version", "a".repeat(64))).toBe(expected);
    expect(spawnSyncMock.mock.calls[1]?.[2]).toEqual(expect.objectContaining({ timeout: 10000, maxBuffer: 64 * 1024,
      env: expect.objectContaining({ GOATCITADEL_SECRET_CUSTODY: "a".repeat(64) }) }));
  });

  it.each([
    { status: 0, stdout: "" },
    { status: 4, stdout: "absent" },
    { status: 1, stdout: "" },
  ])("rejects an invalid custody deletion acknowledgement: $status / $stdout", (response) => {
    setPlatform("win32");
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never).mockReturnValueOnce({ ...response, stderr: "failed" } as never);
    expect(() => new SecretStoreService().deleteSecretForCustody("mcp:fixture:environment:version", "a".repeat(64))).toThrow();
  });

  it("rejects an unacknowledged custody read or changed custody write", () => {
    setPlatform("win32");
    const service = new SecretStoreService();
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never).mockReturnValueOnce({ status: 0, stdout: "not-a-custodian", stderr: "" } as never);
    expect(() => service.getCredentialCustodyId()).toThrow("not acknowledged");
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never).mockReturnValueOnce({ status: 4, stdout: "custody_mismatch", stderr: "" } as never);
    expect(() => service.setSecretForCustody("mcp:fixture:environment:version", "private-value", "a".repeat(64))).toThrow("custody changed");
  });

  it("validates provider/account inputs before calling the host keychain", () => {
    setPlatform("linux");
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
    const service = new SecretStoreService();

    expect(() => service.setProviderApiKey("   ", "secret")).toThrow("providerId is required");
    expect(() => service.setProviderApiKey("openai", "   ")).toThrow("apiKey must not be empty");
    expect(() => service.setSecret("   ", "secret")).toThrow("secret account is required");
    expect(() => service.setSecret("provider:openai", "   ")).toThrow("secret must not be empty");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("reports unavailable hosts before persisting Linux secrets", () => {
    setPlatform("linux");
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" } as never);
    const service = new SecretStoreService();

    expect(() => service.setSecret("provider:openai", "sk-test")).toThrow(SecretStoreUnavailableError);
    expect(spawnSyncMock).toHaveBeenCalledWith("which", ["secret-tool"], {
      stdio: "ignore",
      windowsHide: true,
    });
  });

  it("stores, reads, and deletes Linux secrets through secret-tool", () => {
    setPlatform("linux");
    const service = new SecretStoreService();
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "sk-test\n", stderr: "" } as never)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" } as never);

    service.setProviderApiKey(" OpenAI ", "sk-test");
    expect(service.getProviderApiKey("openai")).toBe("sk-test");
    service.deleteProviderApiKey("openai");

    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      "secret-tool",
      ["store", "--label", "GoatCitadel Provider Secret", "service", "goatcitadel", "account", "provider:openai"],
      expect.objectContaining({ input: "sk-test" }),
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      3,
      "secret-tool",
      ["lookup", "service", "goatcitadel", "account", "provider:openai"],
      expect.any(Object),
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      4,
      "secret-tool",
      ["clear", "service", "goatcitadel", "account", "provider:openai"],
      expect.any(Object),
    );
  });

  it("returns empty status instead of leaking keychain backend failures", () => {
    setPlatform("darwin");
    const service = new SecretStoreService();
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 44, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 2, stdout: "", stderr: "denied" } as never);

    expect(service.status("anthropic")).toEqual({
      providerId: "anthropic",
      hasSecret: false,
      source: "none",
    });
    expect(service.status("google")).toEqual({
      providerId: "google",
      hasSecret: false,
      source: "none",
    });
  });

  it("uses Windows PasswordVault commands and treats missing credentials as absent", () => {
    setPlatform("win32");
    const service = new SecretStoreService();
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "ok\n", stderr: "" } as never)
      .mockReturnValueOnce({ status: 3, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "ok\n", stderr: "" } as never);

    service.setSecret("provider:moonshot", "sk-win");
    expect(service.getSecret("provider:moonshot")).toBeUndefined();
    service.deleteSecret("provider:moonshot");

    expect(spawnSyncMock).toHaveBeenNthCalledWith(1, "where", ["powershell"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      "powershell",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]),
      expect.objectContaining({
        env: expect.objectContaining({
          GOATCITADEL_SECRET_SERVICE: "goatcitadel",
          GOATCITADEL_SECRET_ACCOUNT: "provider:moonshot",
        }),
        input: "sk-win",
      }),
    );
    const windowsWriteOptions = spawnSyncMock.mock.calls[1]?.[2] as { env?: Record<string, string>; input?: string };
    expect(windowsWriteOptions.env).not.toHaveProperty("GOATCITADEL_SECRET_VALUE");
    for (const call of spawnSyncMock.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ windowsHide: true }));
    }
  });

  it.each(["absent", "ok"])("accepts only explicit Windows credential deletion receipts: %s", (receipt) => {
    setPlatform("win32");
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: receipt, stderr: "" } as never);
    expect(() => new SecretStoreService().deleteSecret("mcp:fixture:access-token")).not.toThrow();
    expect(spawnSyncMock.mock.calls[1]?.[2]).toMatchObject({ windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 });
  });

  it.each([
    { status: 0, stdout: "", stderr: "" },
    { status: 0, stdout: "credential_not_found", stderr: "" },
    { status: 1, stdout: "", stderr: "Windows credential deletion failed." },
  ])("rejects unavailable or unacknowledged Windows deletion: %j", (result) => {
    setPlatform("win32");
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never).mockReturnValueOnce(result as never);
    expect(() => new SecretStoreService().deleteSecret("mcp:fixture:access-token")).toThrow();
  });

  it("surfaces command stderr when the keychain command exits unexpectedly", () => {
    setPlatform("darwin");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "security denied" } as never);
    const service = new SecretStoreService();

    expect(() => service.setSecret("provider:anthropic", "sk-test")).toThrow("security failed: security denied");
  });

  it("marks only keychain adapters with argv-and-env-free writes as safe for Chat custody", () => {
    const service = new SecretStoreService();

    setPlatform("win32");
    expect(service.isWriteCustodySafe()).toBe(true);
    setPlatform("linux");
    expect(service.isWriteCustodySafe()).toBe(true);
    setPlatform("darwin");
    expect(service.isWriteCustodySafe()).toBe(false);
  });

  it("redacts the secret from a macOS keychain-write error that echoes it", () => {
    setPlatform("darwin");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "add-generic-password failed for -w sk-leak-me" } as never);
    const service = new SecretStoreService();

    let thrown: Error | undefined;
    try {
      service.setSecret("provider:anthropic", "sk-leak-me");
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toContain("sk-leak-me");
    expect(thrown?.message).toContain("[redacted]");
  });
});

describe("runCommand env allowlist", () => {
  it("does not leak unrelated process.env secrets into keychain-helper subprocesses", () => {
    const hadPath = process.env.PATH !== undefined;
    process.env.UNRELATED_FAKE_SECRET = "sk-should-not-leak";
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "ok",
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    } as never);

    try {
      runCommand("noop", [], { GOATCITADEL_SECRET_VALUE: "x" });

      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      const env = (spawnSyncMock.mock.calls[0]?.[2] as { env?: Record<string, string> }).env;
      expect(env).toBeDefined();
      // The parent process.env (which carries provider API keys, auth/mesh tokens,
      // etc.) must NOT be spread into the keychain-helper child process.
      expect(env).not.toHaveProperty("UNRELATED_FAKE_SECRET");
      expect(spawnSyncMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ windowsHide: true }));
      // The explicit per-call override (service/account/value) must still pass through.
      expect(env?.GOATCITADEL_SECRET_VALUE).toBe("x");
      // A genuinely-needed locator var must survive the allowlist when present on the host.
      if (hadPath) {
        expect(env?.PATH).toBe(process.env.PATH);
      }
    } finally {
      delete process.env.UNRELATED_FAKE_SECRET;
    }
  });
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

describe("SecretStoreService availability and Windows timeouts", () => {
  it("probes where/which once per process, not on every call", () => {
    setPlatform("linux");
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
    const service = new SecretStoreService();
    expect(service.isAvailable()).toBe(true);
    expect(service.isAvailable()).toBe(true);
    expect(spawnSyncMock.mock.calls.filter(([command]) => command === "which")).toHaveLength(1);
  });

  it("bounds the legacy Windows get and set with the 10 s helper timeout", () => {
    setPlatform("win32");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0 } as never)
      .mockReturnValueOnce({ status: 0, stdout: "ok\n", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "value\n", stderr: "" } as never);
    const service = new SecretStoreService();
    service.setSecret("provider:openai", "sk");
    service.getSecret("provider:openai");
    expect(spawnSyncMock.mock.calls[1]?.[2]).toMatchObject({ timeout: 10000 });
    expect(spawnSyncMock.mock.calls[2]?.[2]).toMatchObject({ timeout: 10000 });
  });
});
