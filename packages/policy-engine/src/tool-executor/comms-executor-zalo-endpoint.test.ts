import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { executeCommsTool } from "./comms-executor.js";

// Zalo documents the text send at POST https://openapi.zalo.me/v3.0/oa/message/cs
// (developers.zalo.me/docs/official-account/tin-nhan/tin-tu-van/gui-tin-tu-van-dang-van-ban) and lists the old
// v2.0/oa/message call as shut down, error -240 (developers.zalo.me/docs/official-account/phu-luc/ma-loi).
const ZALO_SEND_URL = "https://openapi.zalo.me/v3.0/oa/message/cs";
const SHUT_DOWN =
  "MessageV2 API has been shut down, please switch to MessageV3. See instructions here https://go.zalo.me/api-v3";

interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string;
}

function policyConfig(): ToolPolicyConfig {
  return {
    profiles: { minimal: ["session.status"] },
    tools: { profile: "minimal", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: ["./workspace"],
      readOnlyRoots: ["./skills"],
      networkAllowlist: ["openapi.zalo.me"],
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

function zaloStorage() {
  const connection = {
    connectionId: "conn-1",
    key: "zalo",
    enabled: true,
    status: "connected",
    config: { accessToken: "zalo-token", defaultRecipientId: "2512523625412515" },
  };
  const markSent = vi.fn();
  const markFailed = vi.fn();
  const storage = {
    integrationConnections: { get: vi.fn(() => connection) },
    commsDeliveries: {
      createQueued: vi.fn((input: Record<string, unknown>) => ({
        deliveryId: "delivery-1",
        status: "queued",
        channelKey: input.channelKey,
        target: input.target,
        createdAt: "2026-10-28T00:00:00.000Z",
        updatedAt: "2026-10-28T00:00:00.000Z",
      })),
      markSent,
      markFailed,
    },
  } as unknown as Storage & AsyncStorage;
  return { storage, markSent, markFailed };
}

/** Zalo answers HTTP 200 and puts its verdict in the body's `error` and `message`. */
function stubZalo(replyBody: Record<string, unknown>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify(replyBody), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Zalo sends go through Zalo's current message API", () => {
  it("posts the text to v3.0/oa/message/cs with the same header and body shape, and never to the shut-down V2 call", async () => {
    const calls = stubZalo({ error: 0, message: "Success", data: { message_id: "zalo-msg-1" } });
    const { storage } = zaloStorage();

    const result = await executeCommsTool(channelSend(), policyConfig(), storage);

    expect(result).toMatchObject({ status: "sent", deliveryStatus: "sent", providerMessageId: "zalo-msg-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: ZALO_SEND_URL, method: "POST" });
    expect(calls[0]?.headers.access_token).toBe("zalo-token");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      recipient: { user_id: "2512523625412515" },
      message: { text: "hello" },
    });
    expect(calls.map((call) => call.url).join("\n")).not.toContain("/v2.0/");
  });

  it("fails and says so in Zalo's own words when Zalo reports the message API has been shut down (-240)", async () => {
    stubZalo({ error: -240, message: SHUT_DOWN });
    const { storage, markSent, markFailed } = zaloStorage();

    const result = await executeCommsTool(channelSend(), policyConfig(), storage);

    expect(result).toMatchObject({ status: "failed" });
    expect(JSON.stringify(result)).toContain("MessageV2 API has been shut down");
    expect(markSent).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledTimes(1);
  });
});
