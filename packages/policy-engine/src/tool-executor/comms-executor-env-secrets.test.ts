import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { executeCommsTool, type ChannelEnvSecretRequest, type ChannelEnvSecretResolution } from "./comms-executor.js";

/**
 * A send reads a connection's variable only through the hook the Gateway supplies; the Gateway owns the name rule.
 * The hook here is a stand-in with a small rule of its own, so these tests prove the wiring and the failure
 * behaviour, not the rule (the Gateway tests drive the real rule through this same executor).
 */

const REFUSAL = "The variable name must start with MATTERMOST_. Rename it and restart GoatCitadel.";
const OPENAI_VALUE = "synthetic-openai-value-0001";
const AUTH_VALUE = "synthetic-gateway-auth-value-0002";
const MATTERMOST_VALUE = "synthetic-mattermost-bot-value-0003";

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

function channelSend(): ToolInvokeRequest {
  return {
    toolName: "channel.send",
    args: { connectionId: "conn-1", message: "hello" },
    agentId: "operator",
    sessionId: "sess-conn-1",
  };
}

function createChannelStorage(key: string, config: Record<string, unknown>) {
  const connection = {
    connectionId: "conn-1",
    catalogId: `channel.${key}`,
    key,
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

function mattermostStorage(config: Record<string, unknown>) {
  return createChannelStorage("mattermost", {
    serverUrl: "https://chat.example.com",
    defaultChannel: "town-square",
    defaultTeam: "goatcitadel",
    ...config,
  });
}

function stubMattermostFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  const json = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body ?? ""),
      });
      if (url.endsWith("/api/v4/users/me")) return json({ id: "botuserid01234567890123456" });
      if (url.endsWith("/api/v4/teams/name/goatcitadel")) return json({ id: "teamid12345678901234567890" });
      if (url.endsWith("/channels/name/town-square")) return json({ id: "channelid12345678901234567" });
      if (url.endsWith("/api/v4/posts")) return json({ id: "post-123" }, 201);
      return new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

/** The Gateway's job in miniature: refuse a name outside `MATTERMOST_`, read the rest from the environment. */
function mattermostOnlyHook(): ReturnType<
  typeof vi.fn<(input: ChannelEnvSecretRequest) => ChannelEnvSecretResolution>
> {
  return vi.fn((input: ChannelEnvSecretRequest): ChannelEnvSecretResolution => {
    if (!input.envName.startsWith("MATTERMOST_")) return { refusal: REFUSAL };
    return { value: process.env[input.envName] };
  });
}

function everythingKept(parts: unknown[]): string {
  return JSON.stringify(parts);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("a send refuses a variable the Gateway will not read", () => {
  it.each([
    ["OPENAI_API_KEY", OPENAI_VALUE],
    ["GOATCITADEL_AUTH_TOKEN", AUTH_VALUE],
  ])("fails a Mattermost send before any request when botTokenEnv is %s", async (name, value) => {
    vi.stubEnv(name, value);
    const calls = stubMattermostFetch();
    const { storage, createQueued, markSent, markFailed } = mattermostStorage({ botTokenEnv: name });
    const resolveChannelEnvSecret = mattermostOnlyHook();

    const result = await executeCommsTool(channelSend(), policyConfig(["chat.example.com"]), storage, undefined, {
      resolveChannelEnvSecret,
    });

    expect(calls).toHaveLength(0);
    expect(resolveChannelEnvSecret).toHaveBeenCalledWith({
      catalogId: "channel.mattermost",
      channelKey: "mattermost",
      field: "botTokenEnv",
      envName: name,
    });
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(String(result.error)).toContain(REFUSAL);
    // The failure names the rule, never the variable's value, and neither the result nor the ledger holds it.
    expect(everythingKept([result, createQueued.mock.calls, markSent.mock.calls, markFailed.mock.calls])).not.toContain(
      value,
    );
  });

  it("does not put the refused name in the failure either, since a person may have pasted a token there", async () => {
    const pasted = "pasted-token-not-a-name-0004";
    const calls = stubMattermostFetch();
    const { storage, markFailed } = mattermostStorage({ botTokenEnv: pasted });

    const result = await executeCommsTool(channelSend(), policyConfig(["chat.example.com"]), storage, undefined, {
      resolveChannelEnvSecret: mattermostOnlyHook(),
    });

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(String(result.error)).toContain(REFUSAL);
    expect(everythingKept([result, markFailed.mock.calls])).not.toContain(pasted);
  });

  it("fails the send for a refused name in the second token field too", async () => {
    vi.stubEnv("OPENAI_API_KEY", OPENAI_VALUE);
    const calls = stubMattermostFetch();
    const { storage } = mattermostStorage({ tokenEnv: "OPENAI_API_KEY" });
    const resolveChannelEnvSecret = mattermostOnlyHook();

    const result = await executeCommsTool(channelSend(), policyConfig(["chat.example.com"]), storage, undefined, {
      resolveChannelEnvSecret,
    });

    expect(calls).toHaveLength(0);
    expect(resolveChannelEnvSecret).toHaveBeenCalledWith(expect.objectContaining({ field: "tokenEnv" }));
    expect(result).toMatchObject({ status: "failed" });
    expect(String(result.error)).toContain(REFUSAL);
  });

  it("refuses the same name on a reaction and on an unsend", async () => {
    vi.stubEnv("OPENAI_API_KEY", OPENAI_VALUE);
    for (const toolName of ["channel.react", "channel.unsend"]) {
      const calls = stubMattermostFetch();
      const { storage } = mattermostStorage({ botTokenEnv: "OPENAI_API_KEY" });

      const result = await executeCommsTool(
        {
          toolName,
          args: { connectionId: "conn-1", messageId: "post-1", emoji: "thumbsup", target: "town-square" },
          agentId: "operator",
          sessionId: "sess-conn-1",
        },
        policyConfig(["chat.example.com"]),
        storage,
        undefined,
        { resolveChannelEnvSecret: mattermostOnlyHook() },
      );

      expect(calls, toolName).toHaveLength(0);
      expect(result, toolName).toMatchObject({ status: "failed" });
      expect(String(result.error), toolName).toContain(REFUSAL);
    }
  });
});

describe("a send with no way to read a variable fails closed", () => {
  it("reads nothing from the environment when no hook is supplied, and says the token is missing", async () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", MATTERMOST_VALUE);
    const calls = stubMattermostFetch();
    const { storage, markFailed } = mattermostStorage({ botTokenEnv: "MATTERMOST_BOT_TOKEN" });

    const result = await executeCommsTool(channelSend(), policyConfig(["chat.example.com"]), storage);

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "not_available" });
    expect(String(result.error)).toContain("Missing Mattermost bot token");
    expect(everythingKept([result, markFailed.mock.calls])).not.toContain(MATTERMOST_VALUE);
  });

  it("treats a hook that finds the variable unset as a missing token", async () => {
    const calls = stubMattermostFetch();
    const { storage } = mattermostStorage({ botTokenEnv: "MATTERMOST_BOT_TOKEN" });

    const result = await executeCommsTool(channelSend(), policyConfig(["chat.example.com"]), storage, undefined, {
      resolveChannelEnvSecret: () => ({}),
    });

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ status: "failed" });
    expect(String(result.error)).toContain("Missing Mattermost bot token");
  });

  it("treats a blank value from the hook as a missing token", async () => {
    const calls = stubMattermostFetch();
    const { storage } = mattermostStorage({ botTokenEnv: "MATTERMOST_BOT_TOKEN" });

    const result = await executeCommsTool(channelSend(), policyConfig(["chat.example.com"]), storage, undefined, {
      resolveChannelEnvSecret: () => ({ value: "   " }),
    });

    expect(calls).toHaveLength(0);
    expect(String(result.error)).toContain("Missing Mattermost bot token");
  });
});

describe("a send with an allowed variable", () => {
  it("sends with the value the hook gives, and keeps that value out of the result and the ledger", async () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", MATTERMOST_VALUE);
    const calls = stubMattermostFetch();
    const { storage, createQueued, markSent, markFailed } = mattermostStorage({
      botTokenEnv: "MATTERMOST_BOT_TOKEN",
    });
    const resolveChannelEnvSecret = mattermostOnlyHook();

    const result = await executeCommsTool(channelSend(), policyConfig(["chat.example.com"]), storage, undefined, {
      resolveChannelEnvSecret,
    });

    expect(result).toMatchObject({ status: "sent", providerMessageId: "post-123" });
    expect(resolveChannelEnvSecret).toHaveBeenCalledWith({
      catalogId: "channel.mattermost",
      channelKey: "mattermost",
      field: "botTokenEnv",
      envName: "MATTERMOST_BOT_TOKEN",
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.headers.authorization === `Bearer ${MATTERMOST_VALUE}`)).toBe(true);
    expect(everythingKept([result, createQueued.mock.calls, markSent.mock.calls, markFailed.mock.calls])).not.toContain(
      MATTERMOST_VALUE,
    );
  });

  it("uses the hook's value and not the process environment's", async () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", "value-from-the-process-environment");
    const calls = stubMattermostFetch();
    const { storage } = mattermostStorage({ botTokenEnv: "MATTERMOST_BOT_TOKEN" });

    const result = await executeCommsTool(channelSend(), policyConfig(["chat.example.com"]), storage, undefined, {
      resolveChannelEnvSecret: () => ({ value: " value-from-the-hook " }),
    });

    expect(result).toMatchObject({ status: "sent" });
    expect(calls[0]?.headers.authorization).toBe("Bearer value-from-the-hook");
  });

  it("does not ask about a variable when a pasted or saved value is there, even if the name is refused", async () => {
    vi.stubEnv("OPENAI_API_KEY", OPENAI_VALUE);
    const calls = stubMattermostFetch();
    const { storage } = mattermostStorage({ botToken: "direct-token", botTokenEnv: "OPENAI_API_KEY" });
    const resolveChannelEnvSecret = mattermostOnlyHook();

    const result = await executeCommsTool(channelSend(), policyConfig(["chat.example.com"]), storage, undefined, {
      resolveChannelEnvSecret,
    });

    expect(result).toMatchObject({ status: "sent" });
    expect(resolveChannelEnvSecret).not.toHaveBeenCalled();
    expect(calls[0]?.headers.authorization).toBe("Bearer direct-token");
  });

  it("asks once per variable field the channel reads, naming the field", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: String(init?.body ?? ""),
        });
        return new Response(JSON.stringify({ error: 0, data: { message_id: "zalo-msg-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const { storage } = createChannelStorage("zalo", {
      accessTokenEnv: "ZALO_ACCESS_TOKEN",
      defaultRecipientId: "123",
    });
    const resolveChannelEnvSecret = vi.fn(
      (_input: ChannelEnvSecretRequest): ChannelEnvSecretResolution => ({
        value: "zalo-hook-value",
      }),
    );

    const result = await executeCommsTool(channelSend(), policyConfig(["openapi.zalo.me"]), storage, undefined, {
      resolveChannelEnvSecret,
    });

    expect(result).toMatchObject({ status: "sent" });
    expect(resolveChannelEnvSecret).toHaveBeenCalledWith({
      catalogId: "channel.zalo",
      channelKey: "zalo",
      field: "accessTokenEnv",
      envName: "ZALO_ACCESS_TOKEN",
    });
    expect(calls[0]?.headers.access_token).toBe("zalo-hook-value");
  });
});
