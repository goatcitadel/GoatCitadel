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
  it("returns the canonical source tool-run ID needed to reply after a complete read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "m",
          payload: { mimeType: "text/plain", body: { data: Buffer.from("body").toString("base64url") } },
        }),
      ),
    );
    const { store } = storage();
    const result = await executeCommsTool(
      { ...request("gmail.get_message", { messageId: "m" }), toolRunId: "canonical-read-1" },
      config,
      store,
      undefined,
      { resolveGoogleWorkspaceAccessToken: async () => "token" },
    );
    expect(result.sourceToolRunId).toBe("canonical-read-1");
    expect(result.message).toMatchObject({ id: "m", bodyText: "body" });
  });
  it("rejects an RSVP using another workspace's connection before resolving credentials or queuing delivery", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { store } = storage();
    vi.mocked(store.integrationConnections.get).mockResolvedValue({
      connectionId: "google",
      key: "gmail",
      status: "connected",
      config: {},
      workspaceId: "other-workspace",
    } as never);
    const resolveGoogleWorkspaceAccessToken = vi.fn(async () => "google-token");
    await expect(
      executeCommsTool(
        {
          ...request("calendar.respond_event", { eventId: "invite", eventEtag: '"v1"', responseStatus: "accepted" }),
          workspaceId: "current-workspace",
        },
        config,
        store,
        undefined,
        { resolveGoogleWorkspaceAccessToken },
      ),
    ).rejects.toThrow(/another workspace/);
    expect(resolveGoogleWorkspaceAccessToken).not.toHaveBeenCalled();
    expect(store.commsDeliveries.createQueued).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never reads a pasted access token; without the sign-in hook every tool is blocked before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const [toolName, args] of [
      ["gmail.read", {}],
      ["calendar.list", {}],
      ["calendar.respond_event", { eventId: "invite", eventEtag: '"v1"', responseStatus: "accepted" }],
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

  it.each(["accepted", "declined", "tentative"])(
    "submits only the signed-in attendee's %s RSVP after checking the reviewed event version",
    async (responseStatus) => {
      const beforeExternalSideEffect = vi.fn();
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === "GET") {
          expect(beforeExternalSideEffect).not.toHaveBeenCalled();
          return Response.json({
            id: "invite",
            etag: '"v1"',
            attendees: [
              { email: "me@example.com", self: true, responseStatus: "needsAction" },
              { email: "other@example.com", responseStatus: "accepted" },
            ],
          });
        }
        expect(beforeExternalSideEffect).toHaveBeenCalledTimes(1);
        expect(init.method).toBe("PATCH");
        expect(init.headers).toMatchObject({ "If-Match": '"v1"' });
        expect(JSON.parse(String(init.body))).toEqual({
          attendeesOmitted: true,
          attendees: [{ email: "me@example.com", responseStatus }],
        });
        return Response.json({ id: "invite", attendees: [{ email: "me@example.com", self: true, responseStatus }] });
      });
      vi.stubGlobal("fetch", fetchMock);
      const { store } = storage();
      const result = await executeCommsTool(
        request("calendar.respond_event", { eventId: "invite", eventEtag: '"v1"', responseStatus }),
        config,
        store,
        undefined,
        {
          resolveGoogleWorkspaceAccessToken: async () => "google-token",
          beforeExternalSideEffect,
        },
      );
      expect(result).toMatchObject({ status: "sent", providerMessageId: "invite" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1]![0])).toContain("sendUpdates=all");
    },
  );

  it.each(["stale", "no_self", "secondary", "invalid_status"])(
    "refuses %s RSVP before any mutation",
    async (failure) => {
      const beforeExternalSideEffect = vi.fn();
      const fetchMock = vi.fn(async () =>
        Response.json({
          id: "invite",
          etag: failure === "stale" ? '"v2"' : '"v1"',
          attendees: failure === "no_self" ? [] : [{ email: "me@example.com", self: true }],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { store } = storage();
      const result = await executeCommsTool(
        request("calendar.respond_event", {
          eventId: "invite",
          eventEtag: '"v1"',
          responseStatus: failure === "invalid_status" ? "yes" : "accepted",
          ...(failure === "secondary" ? { calendarId: "someone@example.com" } : {}),
        }),
        config,
        store,
        undefined,
        {
          resolveGoogleWorkspaceAccessToken: async () => "google-token",
          beforeExternalSideEffect,
        },
      );
      expect(result.status).toBe("failed");
      expect(beforeExternalSideEffect).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(failure === "secondary" ? 2 : 1);
    },
  );

  it.each(["network", "unconfirmed"])("does not retry an ambiguous RSVP after %s failure", async (failure) => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "GET")
        return Response.json({ id: "invite", etag: '"v1"', attendees: [{ self: true, email: "me@example.com" }] });
      if (failure === "network") throw new Error("connection lost");
      return Response.json({
        id: "invite",
        attendees: [{ self: true, email: "me@example.com", responseStatus: "needsAction" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { store } = storage();
    const result = await executeCommsTool(
      request("calendar.respond_event", { eventId: "invite", eventEtag: '"v1"', responseStatus: "accepted" }),
      config,
      store,
      undefined,
      {
        resolveGoogleWorkspaceAccessToken: async () => "google-token",
      },
    );
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "manual_reconciliation_required" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
