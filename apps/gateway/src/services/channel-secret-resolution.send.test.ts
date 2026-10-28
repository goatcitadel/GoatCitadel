import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { executeTool, type ToolExecutorRuntimeHooks } from "@goatcitadel/policy-engine";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { resolveChannelSendEnvSecret } from "./channel-secret-resolution.js";

/**
 * A real send through the policy-engine executor with the hook the Gateway wires, so the name rule that decides
 * which variable a send may read is the real one. The variables here hold made-up values that must never be sent.
 */

const OPENAI_VALUE = "synthetic-openai-value-0001";
const AUTH_VALUE = "synthetic-gateway-auth-value-0002";
const MATTERMOST_VALUE = "synthetic-mattermost-bot-value-0003";
const hooks: ToolExecutorRuntimeHooks = { resolveChannelEnvSecret: resolveChannelSendEnvSecret };

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function policyConfig(allowlist: string[]): ToolPolicyConfig {
  return {
    profiles: { minimal: ["session.status"] },
    tools: { profile: "minimal", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: ["./workspace"],
      readOnlyRoots: ["./skills"],
      networkAllowlist: allowlist,
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function sendRequest(target?: string): ToolInvokeRequest {
  return {
    toolName: "channel.send",
    args: { connectionId: "conn-1", message: "hello", ...(target ? { target } : {}) },
    agentId: "operator",
    sessionId: "sess-conn-1",
  };
}

function channelStorage(key: string, config: Record<string, unknown>) {
  const connection = {
    connectionId: "conn-1",
    catalogId: `channel.${key}`,
    kind: "channel",
    key,
    label: key,
    enabled: true,
    status: "connected",
    config,
  };
  const createQueued = vi.fn((input: Record<string, unknown>) => ({
    deliveryId: "delivery-1",
    status: "queued",
    channelKey: input.channelKey,
    target: input.target,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  }));
  const markSent = vi.fn();
  const markFailed = vi.fn();
  const storage = {
    integrationConnections: { get: vi.fn(() => connection) },
    commsDeliveries: { createQueued, markSent, markFailed },
  } as unknown as Storage & AsyncStorage;
  return { storage, createQueued, markSent, markFailed };
}

function stubFetch(respond: (url: string) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body ?? ""),
      });
      return respond(url);
    }),
  );
  return calls;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mattermostRoutes(url: string): Response {
  if (url.endsWith("/api/v4/users/me")) return json({ id: "botuserid01234567890123456" });
  if (url.endsWith("/api/v4/teams/name/goatcitadel")) return json({ id: "teamid12345678901234567890" });
  if (url.endsWith("/channels/name/town-square")) return json({ id: "channelid12345678901234567" });
  if (url.endsWith("/api/v4/posts")) return json({ id: "post-123" }, 201);
  return new Response("not found", { status: 404 });
}

const mattermostConfig = (botTokenEnv: string) => ({
  serverUrl: "https://chat.example.com",
  botTokenEnv,
  defaultChannel: "town-square",
  defaultTeam: "goatcitadel",
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("a Mattermost send and the Gateway's name rule", () => {
  it.each([
    ["OPENAI_API_KEY", OPENAI_VALUE],
    ["GOATCITADEL_AUTH_TOKEN", AUTH_VALUE],
  ])("fails before any request when botTokenEnv is %s, and says the name is not allowed", async (name, value) => {
    vi.stubEnv(name, value);
    const calls = stubFetch(mattermostRoutes);
    const { storage, createQueued, markSent, markFailed } = channelStorage("mattermost", mattermostConfig(name));

    const result = await executeTool(sendRequest(), policyConfig(["chat.example.com"]), storage, hooks);

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(result.error).toBe(
      "blocked: The variable name must start with MATTERMOST_. Rename it and restart GoatCitadel.",
    );
    const kept = JSON.stringify([result, createQueued.mock.calls, markSent.mock.calls, markFailed.mock.calls]);
    expect(kept).not.toContain(value);
  });

  it("still sends with a correctly named variable, using that variable's value", async () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", MATTERMOST_VALUE);
    const calls = stubFetch(mattermostRoutes);
    const { storage, createQueued, markSent, markFailed } = channelStorage(
      "mattermost",
      mattermostConfig("MATTERMOST_BOT_TOKEN"),
    );

    const result = await executeTool(sendRequest(), policyConfig(["chat.example.com"]), storage, hooks);

    expect(result).toMatchObject({ status: "sent", providerMessageId: "post-123" });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.headers.authorization === `Bearer ${MATTERMOST_VALUE}`)).toBe(true);
    const kept = JSON.stringify([result, createQueued.mock.calls, markSent.mock.calls, markFailed.mock.calls]);
    expect(kept).not.toContain(MATTERMOST_VALUE);
  });

  it("also takes the prefix the credential rule gives every integration", async () => {
    vi.stubEnv("INTEGRATION_MATTERMOST_TOKEN", MATTERMOST_VALUE);
    const calls = stubFetch(mattermostRoutes);
    const { storage } = channelStorage("mattermost", mattermostConfig("INTEGRATION_MATTERMOST_TOKEN"));

    const result = await executeTool(sendRequest(), policyConfig(["chat.example.com"]), storage, hooks);

    expect(result).toMatchObject({ status: "sent" });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${MATTERMOST_VALUE}`);
  });

  it("refuses another channel's variable even though it is well formed", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "synthetic-slack-bot-value-0006");
    const calls = stubFetch(mattermostRoutes);
    const { storage } = channelStorage("mattermost", mattermostConfig("SLACK_BOT_TOKEN"));

    const result = await executeTool(sendRequest(), policyConfig(["chat.example.com"]), storage, hooks);

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ status: "failed" });
    expect(String(result.error)).toContain("must start with MATTERMOST_");
  });

  it("says the token is missing, not that the name is wrong, when the allowed variable is not set", async () => {
    const calls = stubFetch(mattermostRoutes);
    const { storage } = channelStorage("mattermost", mattermostConfig("MATTERMOST_BOT_TOKEN"));

    const result = await executeTool(sendRequest(), policyConfig(["chat.example.com"]), storage, hooks);

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ status: "failed" });
    expect(String(result.error)).toContain("Missing Mattermost bot token");
  });

  it("keeps a token pasted into the name field out of the failure, the ledger and the request", async () => {
    const pasted = "xoxb-pasted-token-0007-not-a-name";
    vi.stubEnv(pasted, MATTERMOST_VALUE);
    const calls = stubFetch(mattermostRoutes);
    const { storage, createQueued, markSent, markFailed } = channelStorage("mattermost", mattermostConfig(pasted));

    const result = await executeTool(sendRequest(), policyConfig(["chat.example.com"]), storage, hooks);

    expect(calls).toHaveLength(0);
    expect(String(result.error)).toContain("must start with MATTERMOST_");
    const kept = JSON.stringify([result, createQueued.mock.calls, markSent.mock.calls, markFailed.mock.calls]);
    expect(kept).not.toContain(pasted);
    expect(kept).not.toContain(MATTERMOST_VALUE);
  });

  it("fails closed when the runtime supplies no hook, even for a well-named variable that is set", async () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", MATTERMOST_VALUE);
    const calls = stubFetch(mattermostRoutes);
    const { storage } = channelStorage("mattermost", mattermostConfig("MATTERMOST_BOT_TOKEN"));

    const result = await executeTool(sendRequest(), policyConfig(["chat.example.com"]), storage);

    expect(calls).toHaveLength(0);
    expect(String(result.error)).toContain("Missing Mattermost bot token");
  });
});

describe("every channel's send refuses a variable the rule does not allow", () => {
  // The field each send reads first when it is the only one set. The catalog entry is `channel.<key>`.
  const sends: Array<[key: string, config: Record<string, unknown>]> = [
    ["slack", { webhookUrlEnv: "OPENAI_API_KEY" }],
    ["slack", { botTokenEnv: "OPENAI_API_KEY" }],
    ["discord", { webhookUrlEnv: "OPENAI_API_KEY" }],
    ["discord", { botTokenEnv: "OPENAI_API_KEY" }],
    ["teams", { webhookUrlEnv: "OPENAI_API_KEY" }],
    ["google-chat", { serviceAccountKeyEnv: "OPENAI_API_KEY" }],
    ["google-chat", { webhookUrlEnv: "OPENAI_API_KEY" }],
    ["ntfy", { baseUrl: "https://ntfy.example.com", topic: "alerts", tokenEnv: "OPENAI_API_KEY" }],
    ["matrix", { homeserverUrl: "https://matrix.example.com", accessTokenEnv: "OPENAI_API_KEY" }],
    ["line", { channelAccessTokenEnv: "OPENAI_API_KEY" }],
    ["whatsapp", { accessTokenEnv: "OPENAI_API_KEY", phoneNumberId: "555" }],
    ["nextcloud-talk", { baseUrl: "https://cloud.example.com", tokenEnv: "OPENAI_API_KEY" }],
    ["qqbot", { appId: "100", appSecretEnv: "OPENAI_API_KEY" }],
    ["wecom", { corpId: "ww1", agentId: "1000002", secretEnv: "OPENAI_API_KEY" }],
    ["zalo", { accessTokenEnv: "OPENAI_API_KEY" }],
    ["telegram", { botTokenEnv: "OPENAI_API_KEY" }],
  ];

  it.each(sends)("%s: %j", async (key, config) => {
    vi.stubEnv("OPENAI_API_KEY", OPENAI_VALUE);
    const calls = stubFetch(() => json({ ok: true }));
    const { storage, createQueued, markSent, markFailed } = channelStorage(key, config);

    const result = await executeTool(sendRequest("123"), policyConfig(["*"]), storage, hooks);

    const prefix = key.toUpperCase().replaceAll("-", "_");
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ status: "failed" });
    expect(String(result.error)).toContain(`The variable name must start with ${prefix}_.`);
    const kept = JSON.stringify([result, createQueued.mock.calls, markSent.mock.calls, markFailed.mock.calls]);
    expect(kept).not.toContain(OPENAI_VALUE);
  });
});
