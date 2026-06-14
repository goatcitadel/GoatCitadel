import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SecretStoreService,
  SecretStoreUnavailableError,
  isSecretStoreUnavailableLikeError,
} from "./secret-store-service.js";

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
    expect(spawnSyncMock).toHaveBeenCalledWith("which", ["secret-tool"], { stdio: "ignore" });
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

    expect(spawnSyncMock).toHaveBeenNthCalledWith(1, "where", ["powershell"], { stdio: "ignore" });
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      "powershell",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]),
      expect.objectContaining({
        env: expect.objectContaining({
          GOATCITADEL_SECRET_SERVICE: "goatcitadel",
          GOATCITADEL_SECRET_ACCOUNT: "provider:moonshot",
          GOATCITADEL_SECRET_VALUE: "sk-win",
        }),
      }),
    );
  });

  it("surfaces command stderr when the keychain command exits unexpectedly", () => {
    setPlatform("darwin");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "security denied" } as never);
    const service = new SecretStoreService();

    expect(() => service.setSecret("provider:anthropic", "sk-test")).toThrow("security failed: security denied");
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

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}
