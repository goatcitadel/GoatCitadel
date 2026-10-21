import { describe, expect, it, vi } from "vitest";
import type { FirecrawlRuntimeConfig } from "../config.js";
import { WebSearchCredentialService, type WebSearchCredentialServiceOptions } from "./web-search-credential-service.js";

const SCOPE = "root-0123456789abcdef01234567";
const FIRECRAWL_ACCOUNT = `runtime-configuration:installation:${SCOPE}:search.firecrawl`;
const BRAVE_ACCOUNT = `runtime-configuration:installation:${SCOPE}:search.brave`;

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    isAvailable: vi.fn(() => true),
    getSecret: vi.fn((account: string) => values.get(account)),
    setSecret: vi.fn((account: string, secret: string) => void values.set(account, secret)),
    deleteSecret: vi.fn((account: string) => void values.delete(account)),
  };
}

function firecrawlConfig(overrides: Partial<FirecrawlRuntimeConfig> = {}): FirecrawlRuntimeConfig {
  return {
    enabled: true,
    baseUrl: "https://api.firecrawl.dev",
    apiKeyEnv: "FIRECRAWL_API_KEY",
    timeoutMs: 20_000,
    defaultReadBackend: "firecrawl",
    fallbackToNative: true,
    ...overrides,
  };
}

function service(overrides: Partial<WebSearchCredentialServiceOptions> = {}) {
  const secretStore = memoryStore();
  const options: WebSearchCredentialServiceOptions = {
    secretStore,
    installationScopeId: SCOPE,
    getNetworkAllowlist: () => ["api.firecrawl.dev", "api.search.brave.com"],
    getFirecrawlConfig: () => firecrawlConfig(),
    probeOfficial: vi.fn(async () => ({ ok: true, status: "succeeded" })),
    withOfficialTargetChange: vi.fn((_targetId, work) =>
      work(),
    ) as WebSearchCredentialServiceOptions["withOfficialTargetChange"],
    appendAudit: vi.fn(async () => undefined),
    env: {},
    fetchImpl: vi.fn(async () => new Response(JSON.stringify({ data: { remainingCredits: 480 } }), { status: 200 })),
    ...overrides,
  };
  return {
    credentials: new WebSearchCredentialService(options),
    options,
    secretStore: options.secretStore as ReturnType<typeof memoryStore>,
  };
}

describe("WebSearchCredentialService", () => {
  it("reports source and allowlist posture without exposing a key", () => {
    const secretStore = memoryStore({ [BRAVE_ACCOUNT]: "brave-secret" });
    const { credentials } = service({
      secretStore,
      env: { FIRECRAWL_API_KEY: "env-firecrawl-secret" },
      getNetworkAllowlist: () => ["api.search.brave.com"],
    });

    const statuses = credentials.listStatuses();

    expect(statuses.map((status) => [status.targetId, status.activeSource, status.endpointAllowlisted])).toEqual([
      ["search.firecrawl", "env", false],
      ["search.brave", "keychain", true],
      ["search.parallel", "none", false],
    ]);
    expect(JSON.stringify(statuses)).not.toMatch(/secret/u);
  });

  it("checks a Firecrawl key live before storing it in the keychain", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const { credentials, secretStore, options } = service({ fetchImpl });

    const status = await credentials.store("search.firecrawl", "  fc-new-key  ");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.firecrawl.dev/v2/team/credit-usage",
      expect.objectContaining({ init: expect.objectContaining({ headers: { Authorization: "Bearer fc-new-key" } }) }),
    );
    expect(secretStore.values.get(FIRECRAWL_ACCOUNT)).toBe("fc-new-key");
    expect(status).toMatchObject({ activeSource: "keychain", keychainConfigured: true });
    expect(options.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "web_search_credential.stored", targetId: "search.firecrawl" }),
    );
    expect(JSON.stringify(vi.mocked(options.appendAudit!).mock.calls)).not.toContain("fc-new-key");
    await expect(credentials.resolveFirecrawlCredential()).resolves.toBe("fc-new-key");
  });

  it("refuses a Firecrawl key the server rejects and leaves the keychain untouched", async () => {
    const { credentials, secretStore } = service({ fetchImpl: vi.fn(async () => new Response("", { status: 401 })) });

    await expect(credentials.store("search.firecrawl", "fc-bad")).rejects.toThrow("Firecrawl rejected this API key.");
    expect(secretStore.setSecret).not.toHaveBeenCalled();
  });

  it("does not call a Firecrawl host outside the allowlist", async () => {
    const fetchImpl = vi.fn();
    const { credentials } = service({ fetchImpl, getNetworkAllowlist: () => [] });

    const check = await credentials.checkFirecrawl();

    expect(check.status).toBe("blocked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows the canonical local Firecrawl port without an allowlist entry and reports refused connections", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3002");
    });
    const { credentials } = service({
      fetchImpl,
      getNetworkAllowlist: () => [],
      getFirecrawlConfig: () => firecrawlConfig({ baseUrl: "http://127.0.0.1:3002" }),
    });

    const check = await credentials.checkFirecrawl();

    expect(check).toMatchObject({ status: "unreachable", keySource: "none" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3002/v2/team/credit-usage",
      expect.objectContaining({ allowlist: ["127.0.0.1:3002", "localhost:3002"] }),
    );
  });

  it("reports remaining hosted credits on a successful check", async () => {
    const { credentials } = service();
    await expect(credentials.checkFirecrawl()).resolves.toMatchObject({ status: "ok", remainingCredits: 480 });
  });

  it("runs Brave changes under the shared Chat owner fence and live probe", async () => {
    const withOfficialTargetChange = vi.fn((_targetId: string, work: () => Promise<unknown>) => work());
    const probeOfficial = vi.fn(async () => ({ ok: false, status: "unavailable", httpStatus: 401 }));
    const { credentials, secretStore } = service({
      withOfficialTargetChange:
        withOfficialTargetChange as WebSearchCredentialServiceOptions["withOfficialTargetChange"],
      probeOfficial,
    });

    await expect(credentials.store("search.brave", "brave-bad")).rejects.toThrow("Brave Search rejected the key");
    expect(withOfficialTargetChange).toHaveBeenCalledWith("search.brave", expect.any(Function));
    expect(probeOfficial).toHaveBeenCalledWith("brave", "brave-bad", ["api.firecrawl.dev", "api.search.brave.com"]);
    expect(secretStore.setSecret).not.toHaveBeenCalled();
  });

  it("does not touch the keychain when the Chat owner fence refuses the change", async () => {
    const { credentials, secretStore } = service({
      withOfficialTargetChange: (async () => {
        throw new Error("Brave Search is being configured from Chat.");
      }) as WebSearchCredentialServiceOptions["withOfficialTargetChange"],
    });

    await expect(credentials.store("search.brave", "brave-key")).rejects.toThrow("being configured from Chat");
    await expect(credentials.clear("search.brave")).rejects.toThrow("being configured from Chat");
    expect(secretStore.setSecret).not.toHaveBeenCalled();
    expect(secretStore.deleteSecret).not.toHaveBeenCalled();
  });

  it("reports a failed audit write without hiding a committed keychain change", async () => {
    const reportAuditFailure = vi.fn();
    const { credentials, secretStore } = service({
      appendAudit: vi.fn(async () => {
        throw new Error("audit store offline");
      }),
      reportAuditFailure,
    });

    await expect(credentials.store("search.firecrawl", "fc-key")).resolves.toMatchObject({ keychainConfigured: true });
    expect(secretStore.values.get(FIRECRAWL_ACCOUNT)).toBe("fc-key");
    expect(reportAuditFailure).toHaveBeenCalledWith(
      "web_search_credential.stored",
      "search.firecrawl",
      expect.any(Error),
    );

    await expect(credentials.clear("search.firecrawl")).resolves.toMatchObject({ keychainConfigured: false });
    expect(reportAuditFailure).toHaveBeenCalledTimes(2);
  });

  it("gives the keychain key only to the configured Firecrawl endpoint", async () => {
    const secretStore = memoryStore({ [FIRECRAWL_ACCOUNT]: "fc-key" });
    const { credentials } = service({ secretStore });

    await expect(credentials.resolveFirecrawlCredential("https://api.firecrawl.dev/")).resolves.toBe("fc-key");
    await expect(credentials.resolveFirecrawlCredential("https://API.firecrawl.dev")).resolves.toBe("fc-key");
    await expect(credentials.resolveFirecrawlCredential("https://attacker.example")).resolves.toBeUndefined();
    await expect(credentials.resolveFirecrawlCredential("not a url")).resolves.toBeUndefined();
  });

  it("reports a private Firecrawl host as not allowlisted, like Settings and the tools", async () => {
    const fetchImpl = vi.fn();
    const { credentials } = service({
      fetchImpl,
      getNetworkAllowlist: () => ["192.168.1.20:3002"],
      getFirecrawlConfig: () => firecrawlConfig({ baseUrl: "http://192.168.1.20:3002" }),
    });

    expect(credentials.status("search.firecrawl").endpointAllowlisted).toBe(false);
    await expect(credentials.checkFirecrawl()).resolves.toMatchObject({ status: "blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clears a keychain key and falls back to the environment", async () => {
    const secretStore = memoryStore({ [FIRECRAWL_ACCOUNT]: "fc-key" });
    const { credentials } = service({ secretStore, env: { FIRECRAWL_API_KEY: "env-key" } });

    const status = await credentials.clear("search.firecrawl");

    expect(secretStore.values.has(FIRECRAWL_ACCOUNT)).toBe(false);
    expect(status.activeSource).toBe("env");
  });

  it("keeps temporary secure-input custody separate from the active key", () => {
    const { credentials, secretStore } = service();

    credentials.holdTemporary("plan-1", " temp-key ");
    expect(credentials.hasTemporary("plan-1")).toBe(true);
    expect(secretStore.values.has(FIRECRAWL_ACCOUNT)).toBe(false);
    expect(credentials.consumeTemporary("plan-1")).toBe("temp-key");
    expect(credentials.hasTemporary("plan-1")).toBe(false);
    expect(() => credentials.consumeTemporary("plan-1")).toThrow("Enter it again");
  });
});
