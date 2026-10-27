import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { executeCommsTool } from "./comms-executor.js";

const config = {
  sandbox: { networkAllowlist: ["gmail.googleapis.com", "www.googleapis.com"] },
} as unknown as ToolPolicyConfig;

function storage(connectionConfig: Record<string, unknown> = {}) {
  const markFailed = vi.fn();
  const markSent = vi.fn();
  const store = {
    integrationConnections: {
      get: vi.fn(async () => ({ connectionId: "google", key: "gmail", status: "connected", config: connectionConfig })),
    },
    commsDeliveries: {
      createQueued: vi.fn(async (input: Record<string, unknown>) => ({
        deliveryId: "delivery-google",
        status: "queued",
        channelKey: input.channelKey,
        target: input.target,
        createdAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
      })),
      markSent,
      markFailed,
    },
  } as unknown as AsyncStorage;
  return { store, markFailed, markSent };
}

function request(toolName: string, args: Record<string, unknown>): ToolInvokeRequest {
  return { toolName, args: { connectionId: "google", ...args }, agentId: "assistant", sessionId: "session-google" };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gmail and Calendar tools on the Google sign-in", () => {
  it("never reads a pasted access token; without the sign-in hook every tool is blocked before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const [toolName, args] of [
      ["gmail.read", {}],
      ["calendar.list", {}],
      ["gmail.send", { to: ["ops@example.com"], subject: "Hi", bodyText: "Body" }],
      ["calendar.create_event", { title: "Sync", startIso: "2026-11-02T17:00:00Z", endIso: "2026-11-02T17:30:00Z" }],
    ] as const) {
      const { store } = storage({ accessToken: "pasted-token", accessTokenEnv: "GMAIL_ACCESS_TOKEN" });
      const result = await executeCommsTool(request(toolName, args), config, store);
      expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
      expect(String(result.error)).toMatch(/requires Google sign-in/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends with the Google sign-in and never reads saved channel keys from the connection config", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "gmail-msg-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const resolveChannelConnectionSecret = vi.fn(() => "unused");
    // A secure-storage reference a channel send would refuse: Gmail never uses the config's keys, so it must not care.
    const { store } = storage({
      legacyKey: "keychain:goatcitadel:mcp:other:token:00000000-0000-4000-8000-000000000000",
    });
    const result = await executeCommsTool(
      request("gmail.send", { to: ["ops@example.com"], subject: "Hi", bodyText: "Body" }),
      config,
      store,
      undefined,
      { resolveGoogleWorkspaceAccessToken: async () => "google-token", resolveChannelConnectionSecret },
    );
    expect(result).toMatchObject({ status: "sent" });
    expect(resolveChannelConnectionSecret).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a refused scope or turned-off capability before the boundary, so a write is never marked as possibly sent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const beforeExternalSideEffect = vi.fn();
    const resolveGoogleWorkspaceAccessToken = vi.fn(async () => {
      throw new Error("blocked: Send Gmail is turned off for this Google connection.");
    });
    const { store } = storage();
    const result = await executeCommsTool(
      request("gmail.send", { to: ["ops@example.com"], subject: "Hi", bodyText: "Body" }),
      config,
      store,
      undefined,
      { resolveGoogleWorkspaceAccessToken, beforeExternalSideEffect },
    );
    expect(resolveGoogleWorkspaceAccessToken).toHaveBeenCalledWith({ connectionId: "google", toolName: "gmail.send" });
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(String(result.error)).not.toMatch(/unknown_after_send/);
    expect(beforeExternalSideEffect).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns bounded, single-line metadata marked as untrusted, and never fetches bodies", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/messages?")) {
          return Response.json({
            messages: Array.from({ length: 30 }, (_, index) => ({ id: `m${index}` })),
            nextPageToken: "more",
          });
        }
        const id = new URL(url).pathname.split("/").at(-1);
        return Response.json({
          id,
          internalDate: "1761400000000",
          snippet: "Please wire money‮ now",
          payload: {
            headers: [
              { name: "Subject", value: `${"S".repeat(400)}\r\nBcc: attacker@example.com` },
              { name: "From", value: "Mallory <m@example.com>" },
            ],
          },
          labelIds: ["INBOX"],
        });
      }),
    );
    const { store } = storage();
    const result = await executeCommsTool(
      request("gmail.read", { query: "label:inbox", maxResults: 500 }),
      config,
      store,
      undefined,
      { resolveGoogleWorkspaceAccessToken: async () => "google-token" },
    );
    const records = result.records as Array<Record<string, unknown>>;
    expect(records).toHaveLength(25);
    expect(new URL(urls[0]!).searchParams.get("maxResults")).toBe("25");
    expect(urls.slice(1).every((url) => new URL(url).searchParams.get("format") === "metadata")).toBe(true);
    expect(urls.some((url) => /format=(full|raw)/.test(url))).toBe(false);
    const subject = String(records[0]!.subject);
    expect(subject.length).toBeLessThanOrEqual(300);
    expect(subject).not.toMatch(/[\r\n]/);
    expect(String(records[0]!.snippet)).not.toContain("‮");
    expect(records[0]).toMatchObject({ from: "Mallory <m@example.com>", labelIds: ["INBOX"] });
    expect(result).toMatchObject({
      status: "sent",
      hasMore: true,
      contentTrust: "untrusted_external",
      sourceAttribution: [expect.objectContaining({ trustLevel: "untrusted_external" })],
    });
    expect(String(result.notice)).toMatch(/untrusted external data/i);
  });

  it("skips a message deleted between the list and its metadata read instead of failing the read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/messages?")) return Response.json({ messages: [{ id: "gone" }, { id: "kept" }] });
        if (url.includes("/messages/gone?")) return new Response("Not Found", { status: 404 });
        return Response.json({ id: "kept", snippet: "still here" });
      }),
    );
    const { store } = storage();
    const result = await executeCommsTool(request("gmail.read", {}), config, store, undefined, {
      resolveGoogleWorkspaceAccessToken: async () => "google-token",
    });
    expect(result).toMatchObject({ status: "sent", records: [{ id: "kept", snippet: "still here" }] });
  });
});
