import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SecretStoreService,
  SecretStoreUnavailableError,
  isSecretStoreUnavailableLikeError,
  runCommand,
} from "./secret-store-service.js";
import { encodeMcpCredentialReceipt } from "./mcp-credential-receipt.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const spawnSyncMock = vi.mocked(spawnSync);
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalDisableSecretStore = process.env.GOATCITADEL_DISABLE_SECRET_STORE;

afterEach(() => {
  spawnSyncMock.mockReset();
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  if (originalDisableSecretStore === undefined) {
    delete process.env.GOATCITADEL_DISABLE_SECRET_STORE;
  } else {
    process.env.GOATCITADEL_DISABLE_SECRET_STORE = originalDisableSecretStore;
  }
});

describe("SecretStoreService", () => {
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
    spawnSyncMock.mockReturnValueOnce({ status: 0 } as never)
      .mockReturnValueOnce({ status: 0, stdout: encodeMcpCredentialReceipt(secret, id), stderr: "" } as never);
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
      .mockReturnValueOnce({ status: 0 } as never)
      .mockReturnValueOnce({ status: 0, stdout: "ok\n", stderr: "" } as never);
    expect(service.getCredentialCustodyId()).toBe(custodyId);
    service.setSecretForCustody("mcp:fixture:environment:version", secret, custodyId);
    const [, args, options] = spawnSyncMock.mock.calls[3]!;
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
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "sk-test\n", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
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
      4,
      "secret-tool",
      ["lookup", "service", "goatcitadel", "account", "provider:openai"],
      expect.any(Object),
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      6,
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
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 3, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
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
