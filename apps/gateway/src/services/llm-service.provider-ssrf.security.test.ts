import type { LookupAddress, LookupOptions } from "node:dns";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { startFakeOpenAiCompatibleServer, type FakeOpenAiServer } from "../test/fake-openai-server.js";
import { createNoopSecretStore } from "../test/llm-fixtures.js";
import { findBlockedResolvedProviderAddress, LlmService } from "./llm-service.js";

// Regression coverage for review Finding 4 (LLM-provider SSRF / DNS rebinding).
//
// The provider outbound HTTP path used a plain global fetch() with no guarded
// dispatcher, so a provider whose baseUrl host passed the config-save-time
// hostname check but re-resolved to a private / metadata / loopback address at
// fetch time (classic DNS rebinding) reached the internal target unblocked. The
// only runtime host check (assertProviderHostAllowed) was a no-op whenever the
// sandbox networkAllowlist was empty — the default configuration.
//
// The fix installs a DNS-rebinding-safe guarded lookup on the provider request
// dispatcher: after resolution, a private/reserved resolved IP is blocked unless
// the configured host is a loopback literal that genuinely resolves to loopback
// (so llama.cpp / Ollama / LM Studio on 127.0.0.1 keep working). The policy
// mirrors validateProviderBaseUrl exactly (same predicates, applied to the
// resolved IP) so no provider that is legal today — including the shipped
// tailnet genie-ir20 provider on 100.64.0.0/10 — regresses.

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * Node-style dns.lookup replacement that resolves *every* hostname to a fixed
 * IPv4 address. Literal IPs are returned verbatim so the fake loopback server
 * still works when a test mixes real and rebinding providers.
 */
function fixedLookup(address: string): (host: string, options: LookupOptions, cb: LookupCallback) => void {
  return (host, options, callback) => {
    const resolved = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : address;
    if ((options as LookupOptions & { all?: boolean }).all) {
      callback(null, [{ address: resolved, family: 4 }]);
      return;
    }
    callback(null, resolved, 4);
  };
}

function rebindingConfig(baseUrl: string): LlmConfigFile {
  return {
    activeProviderId: "rebind",
    activeModel: "test",
    providers: [
      {
        providerId: "rebind",
        label: "rebind",
        // A public hostname passes the save-time validateProviderBaseUrl string
        // check; the injected lookup makes it rebind to an internal address.
        baseUrl,
        apiStyle: "openai-chat-completions",
        defaultModel: "test",
      },
    ],
  };
}

describe("findBlockedResolvedProviderAddress (Finding 4 — resolved-IP policy)", () => {
  it("blocks the cloud metadata endpoint", () => {
    expect(findBlockedResolvedProviderAddress("http://provider.example/v1", "169.254.169.254")).toBeTruthy();
  });

  it("blocks RFC1918 private ranges", () => {
    expect(findBlockedResolvedProviderAddress("http://provider.example/v1", "10.0.0.5")).toBeTruthy();
    expect(findBlockedResolvedProviderAddress("http://provider.example/v1", "192.168.1.1")).toBeTruthy();
    expect(findBlockedResolvedProviderAddress("http://provider.example/v1", "172.16.9.9")).toBeTruthy();
  });

  it("blocks a remote host that rebinds to loopback", () => {
    // A non-loopback configured host resolving to 127.0.0.1 is the rebinding
    // attack — loopback is only permitted for explicitly-loopback base URLs.
    expect(findBlockedResolvedProviderAddress("http://provider.example/v1", "127.0.0.1")).toBeTruthy();
  });

  it("permits loopback when the configured host is a loopback literal (local runtime)", () => {
    expect(findBlockedResolvedProviderAddress("http://127.0.0.1:1234/v1", "127.0.0.1")).toBeUndefined();
    expect(findBlockedResolvedProviderAddress("http://localhost:11434/v1", "127.0.0.1")).toBeUndefined();
  });

  it("permits only an RFC1918 bridge address for Docker's exact host alias", () => {
    const providerUrl = "http://host.docker.internal:8080/v1";
    expect(findBlockedResolvedProviderAddress(providerUrl, "10.0.0.1", ["host.docker.internal"])).toBeUndefined();
    expect(
      findBlockedResolvedProviderAddress(providerUrl, "172.17.0.1", ["host.docker.internal:8080"]),
    ).toBeUndefined();
    expect(
      findBlockedResolvedProviderAddress(providerUrl, "::ffff:192.168.65.254", ["host.docker.internal"]),
    ).toBeUndefined();

    for (const allowlist of [
      [],
      ["*"],
      ["*.docker.internal"],
      [".docker.internal"],
      ["host.docker.internal:9090"],
      ["provider.example"],
    ]) {
      expect(findBlockedResolvedProviderAddress(providerUrl, "192.168.65.254", allowlist)).toBeTruthy();
    }
    expect(
      findBlockedResolvedProviderAddress("http://host.docker.internal.example/v1", "192.168.65.254", [
        "host.docker.internal.example",
      ]),
    ).toBeTruthy();
    expect(
      findBlockedResolvedProviderAddress("http://provider.example/v1", "192.168.65.254", ["provider.example"]),
    ).toBeTruthy();
    expect(findBlockedResolvedProviderAddress(providerUrl, "127.0.0.1", ["host.docker.internal"])).toBeTruthy();
    expect(findBlockedResolvedProviderAddress(providerUrl, "169.254.169.254", ["host.docker.internal"])).toBeTruthy();
    expect(findBlockedResolvedProviderAddress(providerUrl, "224.0.0.1", ["host.docker.internal"])).toBeTruthy();
  });

  it("permits public addresses (does not over-block legitimate remote providers)", () => {
    expect(findBlockedResolvedProviderAddress("http://api.openai.com/v1", "104.18.0.1")).toBeUndefined();
  });

  it("preserves the shipped tailnet provider range (100.64.0.0/10 is not blocked)", () => {
    // genie-ir20 ships as http://100.64.0.4:8910/v1 and passes save-time
    // validation; the fetch-time guard must not regress it.
    expect(findBlockedResolvedProviderAddress("http://100.64.0.4:8910/v1", "100.64.0.4")).toBeUndefined();
  });
});

describe("LlmService provider SSRF guard (Finding 4 — fetch time, empty allowlist)", () => {
  let server: FakeOpenAiServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("blocks a chat completion when the provider host rebinds to the metadata IP", async () => {
    const service = new LlmService(rebindingConfig("http://provider.example/v1"), process.env, {
      secretStore: createNoopSecretStore(),
      // Default production posture: enforcement on, allowlist empty.
      networkAllowlist: [],
      enforceNetworkAllowlist: true,
      dnsLookup: fixedLookup("169.254.169.254"),
    });

    await expect(
      service.chatCompletions({ providerId: "rebind", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/blocked/i);
  });

  it("blocks a chat completion when the provider host rebinds to a private range", async () => {
    const service = new LlmService(rebindingConfig("http://provider.example/v1"), process.env, {
      secretStore: createNoopSecretStore(),
      networkAllowlist: [],
      enforceNetworkAllowlist: true,
      dnsLookup: fixedLookup("10.1.2.3"),
    });

    await expect(
      service.chatCompletions({ providerId: "rebind", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/blocked/i);
  });

  it("blocks model discovery when the provider host rebinds to the metadata IP", async () => {
    const service = new LlmService(rebindingConfig("http://provider.example/v1"), process.env, {
      secretStore: createNoopSecretStore(),
      networkAllowlist: [],
      enforceNetworkAllowlist: true,
      dnsLookup: fixedLookup("169.254.169.254"),
    });

    // The unknown providerId has no template fallback catalog, so the block
    // surfaces as a thrown error rather than being masked by a fallback list.
    await expect(service.listModels("rebind")).rejects.toThrow(/blocked/i);
  });

  it("still allows a legitimately-configured loopback provider (local inference)", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const address = new URL(server.baseUrl);
    const config: LlmConfigFile = {
      activeProviderId: "local",
      activeModel: "fake-chat",
      providers: [
        {
          providerId: "local",
          label: "local llama.cpp",
          baseUrl: server.baseUrl,
          apiStyle: "openai-chat-completions",
          defaultModel: "fake-chat",
        },
      ],
    };
    const service = new LlmService(config, process.env, {
      secretStore: createNoopSecretStore(),
      networkAllowlist: [],
      enforceNetworkAllowlist: true,
    });

    // Sanity: the fake server binds to loopback.
    expect(address.hostname).toBe("127.0.0.1");

    const models = await service.listModels("local");
    expect(models.map((model) => model.id)).toEqual(["fake-chat", "fake-tools"]);

    const response = await service.chatCompletions({
      providerId: "local",
      messages: [{ role: "user", content: "hello" }],
    });
    const choices = response.choices as Array<{ message?: { content?: unknown } }> | undefined;
    expect(typeof choices?.[0]?.message?.content).toBe("string");
    expect(server.requests.some((entry) => entry.path === "/v1/chat/completions")).toBe(true);
  });

  it("does not block a public resolved IP (guard permits legitimate remote providers)", async () => {
    // Public-per-policy documentation IP (203.0.113.0/24 is TEST-NET-3 and is
    // NOT in llm-service's private/reserved set). The connect will fail because
    // nothing is listening there, but the failure must be a network error, not
    // an SSRF "blocked" error — proving the guard lets public hosts through.
    const service = new LlmService(rebindingConfig("http://provider.example/v1"), process.env, {
      secretStore: createNoopSecretStore(),
      networkAllowlist: [],
      enforceNetworkAllowlist: true,
      dnsLookup: fixedLookup("203.0.113.7"),
    });

    await expect(
      service.chatCompletions({ providerId: "rebind", messages: [{ role: "user", content: "hi" }], timeoutMs: 1500 }),
    ).rejects.not.toThrow(/blocked/i);
  });

  it("still enforces an explicit allowlist when one is configured", async () => {
    const service = new LlmService(rebindingConfig("http://provider.example/v1"), process.env, {
      secretStore: createNoopSecretStore(),
      // Non-empty allowlist that does NOT contain provider.example.
      networkAllowlist: ["api.openai.com"],
      enforceNetworkAllowlist: true,
      dnsLookup: fixedLookup("104.18.0.1"),
    });

    await expect(
      service.chatCompletions({ providerId: "rebind", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow();
  });
});
