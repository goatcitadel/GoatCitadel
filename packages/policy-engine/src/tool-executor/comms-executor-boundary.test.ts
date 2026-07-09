import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { executeCommsTool } from "./comms-executor.js";

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
  storage: Storage;
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
  } as unknown as Storage;
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
    } as unknown as Storage;

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
