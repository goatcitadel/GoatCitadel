import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { executeCommsTool } from "./comms-executor.js";

const REF_PREFIX = "keychain:goatcitadel:channel-connection:";
const ZALO_REF = `${REF_PREFIX}conn-1:accessToken:00000000-0000-4000-8000-000000000000`;
const TELEGRAM_REF = `${REF_PREFIX}conn-1:botToken:00000000-0000-4000-8000-000000000001`;
const REAL_TOKEN = "real-token";

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

function createChannelStorage(
  key: string,
  config: Record<string, unknown>,
  label?: string,
): {
  storage: Storage & AsyncStorage;
  connection: { config: Record<string, unknown> };
  createQueued: ReturnType<typeof vi.fn>;
  markSent: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
} {
  const connection = { connectionId: "conn-1", key, label, enabled: true, status: "connected", config };
  const createQueued = vi.fn((input: Record<string, unknown>) => ({
    deliveryId: "delivery-1",
    status: "queued",
    channelKey: input.channelKey,
    target: input.target,
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  }));
  const markSent = vi.fn();
  const markFailed = vi.fn();
  const storage = {
    integrationConnections: { get: vi.fn(() => connection) },
    commsDeliveries: { createQueued, markSent, markFailed },
  } as unknown as Storage & AsyncStorage;
  return { storage, connection, createQueued, markSent, markFailed };
}

function stubFetch(responseBody: Record<string, unknown>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

function everythingSent(calls: FetchCall[]): string {
  return JSON.stringify(calls);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("comms sends use this connection's saved keys", () => {
  it("sends a Zalo message with the stored token instead of the secure-storage reference", async () => {
    const calls = stubFetch({ error: 0, data: { message_id: "zalo-msg-1" } });
    const { storage, createQueued, markSent, markFailed } = createChannelStorage("zalo", {
      accessToken: ZALO_REF,
      defaultRecipientId: "123",
    });
    const resolveChannelConnectionSecret = vi.fn((ref: string) => (ref === ZALO_REF ? REAL_TOKEN : undefined));

    const result = await executeCommsTool(channelSend(), policyConfig(["openapi.zalo.me"]), storage, undefined, {
      resolveChannelConnectionSecret,
    });

    expect(result).toMatchObject({ status: "sent", deliveryStatus: "sent", providerMessageId: "zalo-msg-1" });
    expect(resolveChannelConnectionSecret).toHaveBeenCalledTimes(1);
    expect(resolveChannelConnectionSecret).toHaveBeenCalledWith(ZALO_REF);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://openapi.zalo.me/v2.0/oa/message");
    expect(calls[0]?.headers.access_token).toBe(REAL_TOKEN);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ recipient: { user_id: "123" } });
    expect(everythingSent(calls)).not.toContain("keychain:");
    // The stored value reaches the provider and nothing else: not the result, nor the delivery ledger.
    const kept = JSON.stringify([result, createQueued.mock.calls, markSent.mock.calls, markFailed.mock.calls]);
    expect(kept).not.toContain(REAL_TOKEN);
  });

  it("sends a Telegram message with the stored bot token in the request path", async () => {
    const calls = stubFetch({ ok: true, result: { message_id: 42 } });
    const { storage } = createChannelStorage("telegram", { botToken: TELEGRAM_REF, defaultChatId: "555" });

    const result = await executeCommsTool(channelSend(), policyConfig(["api.telegram.org"]), storage, undefined, {
      resolveChannelConnectionSecret: (ref) => (ref === TELEGRAM_REF ? REAL_TOKEN : undefined),
    });

    expect(result).toMatchObject({ status: "sent", deliveryStatus: "sent" });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe(`/bot${REAL_TOKEN}/sendMessage`);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ chat_id: "555", text: "hello" });
    expect(everythingSent(calls)).not.toContain("keychain:");
  });

  it("leaves the stored connection config untouched", async () => {
    stubFetch({ error: 0, data: { message_id: "zalo-msg-1" } });
    const { storage, connection } = createChannelStorage("zalo", { accessToken: ZALO_REF, defaultRecipientId: "123" });

    await executeCommsTool(channelSend(), policyConfig(["openapi.zalo.me"]), storage, undefined, {
      resolveChannelConnectionSecret: () => REAL_TOKEN,
    });

    expect(connection.config).toEqual({ accessToken: ZALO_REF, defaultRecipientId: "123" });
  });

  it("does not ask for values that are not references", async () => {
    const calls = stubFetch({ error: 0, data: { message_id: "zalo-msg-1" } });
    const { storage } = createChannelStorage("zalo", { accessToken: "plain-token", defaultRecipientId: "123" });
    const resolveChannelConnectionSecret = vi.fn(() => REAL_TOKEN);

    const result = await executeCommsTool(channelSend(), policyConfig(["openapi.zalo.me"]), storage, undefined, {
      resolveChannelConnectionSecret,
    });

    expect(result).toMatchObject({ status: "sent" });
    expect(resolveChannelConnectionSecret).not.toHaveBeenCalled();
    expect(calls[0]?.headers.access_token).toBe("plain-token");
  });

  it.each([
    ["has no stored value", () => undefined],
    ["has a blank stored value", () => "   "],
  ])("fails a send without a request when the saved key %s", async (_name, resolve) => {
    const calls = stubFetch({ error: 0, data: { message_id: "zalo-msg-1" } });
    const { storage, markFailed } = createChannelStorage("zalo", { accessToken: ZALO_REF, defaultRecipientId: "123" });

    const result = await executeCommsTool(channelSend(), policyConfig(["openapi.zalo.me"]), storage, undefined, {
      resolveChannelConnectionSecret: resolve,
    });

    expect(result).toMatchObject({
      status: "failed",
      deliveryStatus: "not_available",
      error: "The saved zalo credential is unavailable from secure storage.",
    });
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(markFailed.mock.calls)).not.toContain("keychain:");
  });

  it("fails a send without a request when the runtime has no way to read saved keys", async () => {
    const calls = stubFetch({ error: 0, data: { message_id: "zalo-msg-1" } });
    const { storage } = createChannelStorage("zalo", { accessToken: ZALO_REF, defaultRecipientId: "123" });

    const result = await executeCommsTool(channelSend(), policyConfig(["openapi.zalo.me"]), storage);

    expect(result).toMatchObject({
      status: "failed",
      error: "The saved zalo credential is unavailable from secure storage.",
    });
    expect(calls).toHaveLength(0);
  });

  it("names the connection's label in the unavailable message when it has one", async () => {
    const calls = stubFetch({ error: 0, data: { message_id: "zalo-msg-1" } });
    const { storage } = createChannelStorage(
      "zalo",
      { accessToken: ZALO_REF, defaultRecipientId: "123" },
      "  Shop Zalo  ",
    );

    const result = await executeCommsTool(channelSend(), policyConfig(["openapi.zalo.me"]), storage, undefined, {
      resolveChannelConnectionSecret: () => undefined,
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "The saved Shop Zalo credential is unavailable from secure storage.",
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["another connection", `${REF_PREFIX}conn-2:accessToken:00000000-0000-4000-8000-000000000002`],
    ["a connection whose id extends this one", `${REF_PREFIX}conn-10:accessToken:00000000-0000-4000-8000-000000000003`],
  ])("never reads or sends a reference that names %s", async (_name, foreignRef) => {
    const calls = stubFetch({ error: 0, data: { message_id: "zalo-msg-1" } });
    const { storage } = createChannelStorage("zalo", { accessToken: foreignRef, defaultRecipientId: "123" });
    const resolveChannelConnectionSecret = vi.fn(() => REAL_TOKEN);

    const result = await executeCommsTool(channelSend(), policyConfig(["openapi.zalo.me"]), storage, undefined, {
      resolveChannelConnectionSecret,
    });

    expect(resolveChannelConnectionSecret).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "failed",
      error: "The saved zalo credential is unavailable from secure storage.",
    });
    expect(calls).toHaveLength(0);
  });

  it("fails the whole send when only one of several references is another connection's", async () => {
    const calls = stubFetch({ error: 0, data: { message_id: "zalo-msg-1" } });
    const foreignRef = `${REF_PREFIX}conn-2:secret:00000000-0000-4000-8000-000000000004`;
    const { storage } = createChannelStorage("zalo", {
      accessToken: ZALO_REF,
      secret: foreignRef,
      defaultRecipientId: "123",
    });
    const resolveChannelConnectionSecret = vi.fn(() => REAL_TOKEN);

    const result = await executeCommsTool(channelSend(), policyConfig(["openapi.zalo.me"]), storage, undefined, {
      resolveChannelConnectionSecret,
    });

    expect(resolveChannelConnectionSecret).not.toHaveBeenCalledWith(foreignRef);
    expect(result).toMatchObject({ status: "failed" });
    expect(calls).toHaveLength(0);
  });
});
