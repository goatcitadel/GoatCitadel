import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveMatrixTxnId,
  matrixReact,
  matrixRedact,
  matrixSendText,
  matrixSetTyping,
  matrixWhoAmI,
  type MatrixClientContext,
} from "./matrix-client.js";

const ctx: MatrixClientContext = {
  homeserverUrl: "https://matrix.example.com/",
  accessToken: "syt_secret_token",
  allowlist: ["matrix.example.com"],
};

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (..._args: unknown[]) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function call(fetchMock: ReturnType<typeof stubFetch>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : undefined };
}

describe("matrix client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends m.text with PUT send/m.room.message/<txnId>", async () => {
    const fetchMock = stubFetch(200, { event_id: "$evt1" });
    const result = await matrixSendText(ctx, { roomId: "!room:example.com", body: "hello", txnId: "txn 1" });
    expect(result).toEqual({ eventId: "$evt1" });
    const { url, init, body } = call(fetchMock);
    expect(url).toBe(
      "https://matrix.example.com/_matrix/client/v3/rooms/!room%3Aexample.com/send/m.room.message/txn%201",
    );
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer syt_secret_token");
    expect(body).toEqual({ msgtype: "m.text", body: "hello" });
  });

  it("adds in_reply_to for a reply and an m.thread relation for a thread", async () => {
    let fetchMock = stubFetch(200, { event_id: "$e" });
    await matrixSendText(ctx, { roomId: "!r:x.com", body: "b", txnId: "t", replyToEventId: "$parent" });
    expect(call(fetchMock).body["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$parent" } });

    fetchMock = stubFetch(200, { event_id: "$e" });
    await matrixSendText(ctx, { roomId: "!r:x.com", body: "b", txnId: "t", threadRootId: "$root" });
    expect(call(fetchMock).body["m.relates_to"]).toEqual({
      rel_type: "m.thread",
      event_id: "$root",
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$root" },
    });

    fetchMock = stubFetch(200, { event_id: "$e" });
    await matrixSendText(ctx, {
      roomId: "!r:x.com",
      body: "b",
      txnId: "t",
      threadRootId: "$root",
      replyToEventId: "$latest",
    });
    expect(call(fetchMock).body["m.relates_to"]["m.in_reply_to"]).toEqual({ event_id: "$latest" });
  });

  it("marks the thread in_reply_to as a fallback only when there is no explicit reply", async () => {
    const fetchMock = stubFetch(200, { event_id: "$e" });
    await matrixSendText(ctx, {
      roomId: "!r:x.com",
      body: "b",
      txnId: "t",
      threadRootId: "$root",
      replyToEventId: "$latest",
    });
    expect(call(fetchMock).body["m.relates_to"].is_falling_back).toBe(false);
  });

  it("refuses non-local plain-HTTP homeservers before any fetch", async () => {
    const fetchMock = stubFetch(200, { event_id: "$e" });
    await expect(
      matrixSendText(
        { ...ctx, homeserverUrl: "http://matrix.example.com" },
        { roomId: "!r:x.com", body: "b", txnId: "t" },
      ),
    ).rejects.toThrow(/https unless it targets localhost/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reacts with an m.annotation relation", async () => {
    const fetchMock = stubFetch(200, { event_id: "$react" });
    const result = await matrixReact(ctx, { roomId: "!r:x.com", eventId: "$target", key: "👍", txnId: "t2" });
    expect(result).toEqual({ eventId: "$react" });
    const { url, init, body } = call(fetchMock);
    expect(url).toBe("https://matrix.example.com/_matrix/client/v3/rooms/!r%3Ax.com/send/m.reaction/t2");
    expect(init.method).toBe("PUT");
    expect(body).toEqual({ "m.relates_to": { rel_type: "m.annotation", event_id: "$target", key: "👍" } });
  });

  it("redacts with PUT redact/<eventId>/<txnId> and an optional reason", async () => {
    let fetchMock = stubFetch(200, { event_id: "$redaction" });
    const result = await matrixRedact(ctx, { roomId: "!r:x.com", eventId: "$old", txnId: "t3", reason: "oops" });
    expect(result).toEqual({ eventId: "$redaction" });
    let seen = call(fetchMock);
    expect(seen.url).toBe("https://matrix.example.com/_matrix/client/v3/rooms/!r%3Ax.com/redact/%24old/t3");
    expect(seen.init.method).toBe("PUT");
    expect(seen.body).toEqual({ reason: "oops" });

    fetchMock = stubFetch(200, { event_id: "$redaction" });
    await matrixRedact(ctx, { roomId: "!r:x.com", eventId: "$old", txnId: "t3" });
    seen = call(fetchMock);
    expect(seen.body).toEqual({});
  });

  it("sets typing with PUT typing/<userId> and resolves the user with whoami", async () => {
    let fetchMock = stubFetch(200, {});
    await matrixSetTyping(ctx, { roomId: "!r:x.com", userId: "@bot:x.com", typing: true, timeoutMs: 15000 });
    let seen = call(fetchMock);
    expect(seen.url).toBe("https://matrix.example.com/_matrix/client/v3/rooms/!r%3Ax.com/typing/%40bot%3Ax.com");
    expect(seen.init.method).toBe("PUT");
    expect(seen.body).toEqual({ typing: true, timeout: 15000 });

    fetchMock = stubFetch(200, {});
    await matrixSetTyping(ctx, { roomId: "!r:x.com", userId: "@bot:x.com", typing: false });
    expect(call(fetchMock).body).toEqual({ typing: false });

    fetchMock = stubFetch(200, { user_id: "@bot:x.com" });
    await expect(matrixWhoAmI(ctx)).resolves.toEqual({ userId: "@bot:x.com" });
    seen = call(fetchMock);
    expect(seen.url).toBe("https://matrix.example.com/_matrix/client/v3/account/whoami");
    expect(seen.init.method).toBe("GET");
  });

  it("derives a deterministic 32-char txn id per key and chunk, else a random one", () => {
    const first = deriveMatrixTxnId("delivery-key", 0);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveMatrixTxnId("delivery-key", 0)).toBe(first);
    expect(deriveMatrixTxnId("delivery-key", 1)).not.toBe(first);
    expect(deriveMatrixTxnId(undefined)).not.toBe(deriveMatrixTxnId(undefined));
  });

  it("throws before fetch when the homeserver is outside the allowlist", async () => {
    const fetchMock = stubFetch(200, { event_id: "$x" });
    await expect(
      matrixSendText({ ...ctx, allowlist: ["other.example.com"] }, { roomId: "!r:x.com", body: "b", txnId: "t" }),
    ).rejects.toThrow(/allowlist|blocked/i);
    await expect(
      matrixSendText({ ...ctx, grantAllowlist: ["other.example.com"] }, { roomId: "!r:x.com", body: "b", txnId: "t" }),
    ).rejects.toThrow(/allowlist|blocked/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces errcode and error on a non-2xx response without the access token", async () => {
    stubFetch(403, { errcode: "M_FORBIDDEN", error: "You do not have permission syt_secret_token" });
    let error: unknown;
    try {
      await matrixSendText(ctx, { roomId: "!r:x.com", body: "b", txnId: "t" });
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof Error)) throw new Error("expected the send to fail");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("M_FORBIDDEN");
    expect(error.message).toContain("403");
    expect(error.message).not.toContain("syt_secret_token");
  });
});
