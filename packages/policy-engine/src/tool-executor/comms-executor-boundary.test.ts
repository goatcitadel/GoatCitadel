import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { executeCommsTool, normalizeBlueBubblesBaseUrl } from "./comms-executor.js";
import { resetGoogleChatAccessTokenCache } from "./google-chat-service-account.js";

const MATTERMOST_CHANNEL_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";

interface FetchCall {
  method: string;
  url: string;
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

function channelSendRequest(connectionId: string, attachments: Array<Record<string, unknown>>): ToolInvokeRequest {
  return {
    toolName: "channel.send",
    args: {
      connectionId,
      message: "Do not send unless every attachment is ready.",
      attachments,
    },
    agentId: "operator",
    sessionId: `sess-${connectionId}`,
  };
}

function createMattermostStorage(
  connectionId: string,
  deliveryId: string,
): {
  markFailed: ReturnType<typeof vi.fn>;
  storage: Storage & AsyncStorage;
} {
  const markFailed = vi.fn();
  const storage = {
    integrationConnections: {
      get: vi.fn(() => ({
        connectionId,
        key: "mattermost",
        config: {
          serverUrl: "https://mattermost.example",
          botToken: "mattermost-token",
          defaultChannel: MATTERMOST_CHANNEL_ID,
        },
      })),
    },
    commsDeliveries: {
      createQueued: vi.fn((input: Record<string, unknown>) => ({
        deliveryId,
        status: "queued",
        channelKey: input.channelKey,
        target: input.target,
        createdAt: "2026-03-18T00:00:00.000Z",
        updatedAt: "2026-03-18T00:00:00.000Z",
      })),
      markSent: vi.fn(),
      markFailed,
    },
  } as unknown as Storage & AsyncStorage;
  return { markFailed, storage };
}

function recordFetchCall(calls: FetchCall[], input: string | URL | Request, init?: RequestInit): string {
  const url = String(input);
  calls.push({ method: String(init?.method ?? "GET").toUpperCase(), url });
  return url;
}

function mattermostBotResponse(): Response {
  return new Response(JSON.stringify({ id: "bot-user-id" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("comms mutation boundary tracking", () => {
  it.each(["complete", "fail"] as const)("awaits the durable boundary before a channel POST (%s)", async (mode) => {
    const calls: FetchCall[] = [];
    const { storage, markFailed } = createMattermostStorage("conn-async", "delivery-async");
    let entered!: () => void;
    let release!: () => void;
    const markerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const markerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = recordFetchCall(calls, input, init);
        if (url.endsWith("/users/me")) return mattermostBotResponse();
        if (url.endsWith("/posts")) return new Response(JSON.stringify({ id: "post-async" }), { status: 201 });
        throw new Error(`unexpected request ${url}`);
      }),
    );
    const invocation = executeCommsTool(
      channelSendRequest("conn-async", []),
      policyConfig(["mattermost.example"]),
      storage,
      undefined,
      {
        beforeExternalSideEffect: async () => {
          entered();
          await markerGate;
          if (mode === "fail") throw new Error("durable boundary unavailable");
        },
      },
    );
    try {
      await markerEntered;
      expect(calls).toEqual([{ method: "GET", url: "https://mattermost.example/api/v4/users/me" }]);
      release();
      const result = await invocation;
      if (mode === "complete") {
        expect(result).toMatchObject({ status: "sent", deliveryStatus: "sent" });
        expect(calls.at(-1)).toEqual({ method: "POST", url: "https://mattermost.example/api/v4/posts" });
      } else {
        expect(result).toMatchObject({ status: "failed", deliveryStatus: "not_available" });
        expect(calls).toHaveLength(1);
        expect(markFailed).toHaveBeenCalledWith(
          "delivery-async",
          expect.not.stringMatching(/unknown_after_send|manual reconciliation/i),
          expect.any(String),
          "not_available",
        );
      }
    } finally {
      release();
      await invocation;
    }
  });

  it("does not report a BlueBubbles read-only POST lookup as the message-send boundary", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = recordFetchCall(calls, input, init);
        if (url === "https://bluebubbles.example/api/v1/chat/query?password=bb-password") {
          return new Response("lookup unavailable", { status: 503 });
        }
        throw new Error(`unexpected provider mutation ${url}`);
      }),
    );
    const markFailed = vi.fn();
    const storage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-bluebubbles-lookup",
          key: "imessage",
          enabled: true,
          status: "connected",
          config: {
            provider: "bluebubbles",
            bridgeUrl: "https://bluebubbles.example",
            password: "bb-password",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn(() => ({
          deliveryId: "delivery-bluebubbles-lookup",
          status: "queued",
          channelKey: "imessage",
          target: "chat:123",
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed,
      },
    } as unknown as Storage & AsyncStorage;
    const beforeExternalSideEffect = vi.fn();

    const result = await executeCommsTool(
      {
        toolName: "imessage.send",
        args: { connectionId: "conn-bluebubbles-lookup", target: "chat:123", message: "hello" },
        agentId: "operator",
        sessionId: "sess-bluebubbles-lookup",
      },
      policyConfig(["bluebubbles.example"]),
      storage,
      undefined,
      { beforeExternalSideEffect },
    );

    expect(calls).toEqual([
      { method: "POST", url: "https://bluebubbles.example/api/v1/chat/query?password=bb-password" },
    ]);
    expect(beforeExternalSideEffect).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-bluebubbles-lookup",
      expect.not.stringMatching(/unknown_after_send|manual reconciliation/i),
      expect.any(String),
      "not_available",
    );
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "not_available" });
  });

  it("keeps an attachment 404 pre-dispatch and never contacts a provider mutation endpoint", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = recordFetchCall(calls, input, init);
        if (url === "https://mattermost.example/api/v4/users/me") {
          return mattermostBotResponse();
        }
        if (url === "https://files.example/missing.png") {
          return new Response("missing", { status: 404 });
        }
        throw new Error(`unexpected provider mutation ${url}`);
      }),
    );
    const { markFailed, storage } = createMattermostStorage("conn-missing", "delivery-missing");

    const result = await executeCommsTool(
      channelSendRequest("conn-missing", [{ title: "missing.png", url: "https://files.example/missing.png" }]),
      policyConfig(["mattermost.example", "files.example"]),
      storage,
    );

    expect(calls).toEqual([
      { method: "GET", url: "https://mattermost.example/api/v4/users/me" },
      { method: "GET", url: "https://files.example/missing.png" },
    ]);
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-missing",
      expect.stringMatching(/attachment fetch failed \(404\)/i),
      expect.any(String),
      "not_available",
    );
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "not_available" });
    expect(String(result.error ?? "")).not.toMatch(/unknown_after_send|manual reconciliation/i);
  });

  it("keeps an attachment body-read failure pre-dispatch and never contacts a provider mutation endpoint", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = recordFetchCall(calls, input, init);
        if (url === "https://mattermost.example/api/v4/users/me") {
          return mattermostBotResponse();
        }
        if (url === "https://files.example/broken.png") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error("attachment response stream failed"));
              },
            }),
            { status: 200, headers: { "Content-Type": "image/png" } },
          );
        }
        throw new Error(`unexpected provider mutation ${url}`);
      }),
    );
    const { markFailed, storage } = createMattermostStorage("conn-broken", "delivery-broken");

    const result = await executeCommsTool(
      channelSendRequest("conn-broken", [{ title: "broken.png", url: "https://files.example/broken.png" }]),
      policyConfig(["mattermost.example", "files.example"]),
      storage,
    );

    expect(calls).toEqual([
      { method: "GET", url: "https://mattermost.example/api/v4/users/me" },
      { method: "GET", url: "https://files.example/broken.png" },
    ]);
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-broken",
      expect.stringMatching(/attachment response stream failed/i),
      expect.any(String),
      "not_available",
    );
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "not_available" });
    expect(String(result.error ?? "")).not.toMatch(/unknown_after_send|manual reconciliation/i);
  });

  it("keeps the mutation boundary crossed when a later attachment read fails", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = recordFetchCall(calls, input, init);
        if (url === "https://mattermost.example/api/v4/users/me") {
          return mattermostBotResponse();
        }
        if (url === "https://files.example/first.png") {
          return new Response("first attachment", { status: 200, headers: { "Content-Type": "image/png" } });
        }
        if (url === "https://mattermost.example/api/v4/files") {
          return new Response(JSON.stringify({ file_infos: [{ id: "file-1" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "https://files.example/second.png") {
          return new Response("missing", { status: 404 });
        }
        throw new Error(`unexpected provider request ${url}`);
      }),
    );
    const { markFailed, storage } = createMattermostStorage("conn-partial-upload", "delivery-partial-upload");

    const result = await executeCommsTool(
      channelSendRequest("conn-partial-upload", [
        { title: "first.png", url: "https://files.example/first.png" },
        { title: "second.png", url: "https://files.example/second.png" },
      ]),
      policyConfig(["mattermost.example", "files.example"]),
      storage,
    );

    expect(calls).toEqual([
      { method: "GET", url: "https://mattermost.example/api/v4/users/me" },
      { method: "GET", url: "https://files.example/first.png" },
      { method: "POST", url: "https://mattermost.example/api/v4/files" },
      { method: "GET", url: "https://files.example/second.png" },
    ]);
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-partial-upload",
      expect.stringMatching(/unknown_after_send|manual reconciliation/i),
      expect.any(String),
      "manual_reconciliation_required",
    );
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "manual_reconciliation_required" });
  });

  it("keeps a private-network policy rejection blocked before an unsafe request is dispatched", async () => {
    const fetchMock = vi.fn(async () => new Response("should not be reached", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const markFailed = vi.fn();
    const storage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-private",
          key: "webhook",
          config: { webhookUrl: "http://169.254.169.254/latest/meta-data" },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn(() => ({
          deliveryId: "delivery-private",
          status: "queued",
          channelKey: "webhook",
          target: "webhook",
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed,
      },
    } as unknown as Storage & AsyncStorage;

    const result = await executeCommsTool(
      {
        toolName: "channel.send",
        args: { connectionId: "conn-private", message: "Never reach metadata." },
        agentId: "operator",
        sessionId: "sess-private",
      },
      policyConfig(["169.254.169.254"]),
      storage,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-private",
      expect.not.stringMatching(/unknown_after_send|manual reconciliation/i),
      expect.any(String),
      "blocked",
    );
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
  });
});

describe("mattermost reply threading", () => {
  const ROOT_POST_ID = "rootpost0000000000000000ab";

  async function sendWith(replyToMessageId: string | undefined): Promise<Record<string, unknown>> {
    const { storage } = createMattermostStorage("conn-thread", "delivery-thread");
    let postedBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/users/me")) return mattermostBotResponse();
        if (url.endsWith("/posts")) {
          postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ id: "reply-post" }), { status: 201 });
        }
        throw new Error(`unexpected request ${url}`);
      }),
    );
    const request = channelSendRequest("conn-thread", []);
    const result = await executeCommsTool(
      { ...request, args: { ...request.args, ...(replyToMessageId ? { replyToMessageId } : {}) } },
      policyConfig(["mattermost.example"]),
      storage,
    );
    expect(result).toMatchObject({ status: "sent" });
    return postedBody;
  }

  it("posts the reply under the inbound root post as root_id", async () => {
    expect(await sendWith(ROOT_POST_ID)).toMatchObject({ channel_id: MATTERMOST_CHANNEL_ID, root_id: ROOT_POST_ID });
  });

  it("stays top-level for a non-Mattermost reply fallback id or no reply target", async () => {
    expect(await sendWith("4f1c2b8e-1111-4222-8333-444455556666")).not.toHaveProperty("root_id");
    expect(await sendWith(undefined)).not.toHaveProperty("root_id");
  });
});

describe("google chat app reply references", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccountKey = JSON.stringify({
    client_email: "bot@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });

  async function sendReply(
    replyToMessageId: string,
    lookup: () => Response,
  ): Promise<{ result: Record<string, unknown>; calls: FetchCall[] }> {
    resetGoogleChatAccessTokenCache();
    const calls: FetchCall[] = [];
    const storage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-gchat",
          key: "google-chat",
          config: { serviceAccountKey, defaultSpace: "spaces/S" },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-gchat",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-10-16T00:00:00.000Z",
          updatedAt: "2026-10-16T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage & AsyncStorage;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = recordFetchCall(calls, input, init);
        if (url.startsWith("https://oauth2.googleapis.com/")) {
          return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
        }
        if (url === "https://chat.googleapis.com/v1/spaces/S/messages/M") return lookup();
        if (url.startsWith("https://chat.googleapis.com/v1/spaces/S/messages")) {
          return new Response(JSON.stringify({ name: "spaces/S/messages/R" }), { status: 200 });
        }
        throw new Error(`unexpected request ${url}`);
      }),
    );
    const request: ToolInvokeRequest = {
      toolName: "channel.send",
      args: { connectionId: "conn-gchat", message: "reply", replyToMessageId },
      agentId: "operator",
      sessionId: "sess-gchat",
    };
    const result = (await executeCommsTool(
      request,
      policyConfig(["chat.googleapis.com", "oauth2.googleapis.com"]),
      storage,
    )) as unknown as Record<string, unknown>;
    return { result, calls };
  }

  it("rejects an unrecognized reply reference before any Chat API request", async () => {
    const { result, calls } = await sendReply("4f1c2b8e-1111-4222-8333-444455556666", () => new Response("{}"));
    expect(result).toMatchObject({ status: "failed" });
    expect(calls.some((call) => call.url.startsWith("https://chat.googleapis.com/"))).toBe(false);
  });

  it("fails before posting when the reply message thread cannot be read", async () => {
    const { result, calls } = await sendReply("spaces/S/messages/M", () => new Response("gone", { status: 404 }));
    expect(result).toMatchObject({ status: "failed" });
    expect(calls.some((call) => call.method === "POST" && call.url.includes("chat.googleapis.com"))).toBe(false);
  });

  it("replies in the message's thread when the lookup succeeds", async () => {
    const { result, calls } = await sendReply(
      "spaces/S/messages/M",
      () => new Response(JSON.stringify({ thread: { name: "spaces/S/threads/T" } })),
    );
    expect(result).toMatchObject({ status: "sent" });
    expect(calls.at(-1)).toMatchObject({ method: "POST" });
  });
});

describe("BlueBubbles bridge URL scheme (password travels in the query string)", () => {
  it("defaults schemeless remote hosts to https and keeps http only for loopback or an explicit http URL", () => {
    expect(normalizeBlueBubblesBaseUrl("bluebubbles.example")).toBe("https://bluebubbles.example");
    expect(normalizeBlueBubblesBaseUrl("bluebubbles.example:1234/")).toBe("https://bluebubbles.example:1234");
    expect(normalizeBlueBubblesBaseUrl("192.168.1.20:1234")).toBe("https://192.168.1.20:1234");
    expect(normalizeBlueBubblesBaseUrl("127.0.0.1:1234")).toBe("http://127.0.0.1:1234");
    expect(normalizeBlueBubblesBaseUrl("LOCALHOST:1234")).toBe("http://LOCALHOST:1234");
    expect(normalizeBlueBubblesBaseUrl("[::1]:1234")).toBe("http://[::1]:1234");
    expect(normalizeBlueBubblesBaseUrl("http://bluebubbles.lan:1234/")).toBe("http://bluebubbles.lan:1234");
    expect(normalizeBlueBubblesBaseUrl("https://bluebubbles.example")).toBe("https://bluebubbles.example");
    expect(normalizeBlueBubblesBaseUrl("  ")).toBeUndefined();
  });

  it("sends a schemeless remote bridge's password-bearing lookup over https", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        recordFetchCall(calls, input, init);
        return new Response("lookup unavailable", { status: 503 });
      }),
    );
    const storage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-bluebubbles-schemeless",
          key: "imessage",
          enabled: true,
          status: "connected",
          config: { provider: "bluebubbles", bridgeUrl: "bluebubbles.example", password: "bb-password" },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn(() => ({
          deliveryId: "delivery-bluebubbles-schemeless",
          status: "queued",
          channelKey: "imessage",
          target: "chat:123",
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage & AsyncStorage;

    await executeCommsTool(
      {
        toolName: "imessage.send",
        args: { connectionId: "conn-bluebubbles-schemeless", target: "chat:123", message: "hello" },
        agentId: "operator",
        sessionId: "sess-bluebubbles-schemeless",
      },
      policyConfig(["bluebubbles.example"]),
      storage,
    );

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith("https://bluebubbles.example/")).toBe(true);
    }
  });
});
