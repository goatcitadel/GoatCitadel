import { describe, expect, it, vi } from "vitest";
import { getQqbotAccessToken, qqbotSendText } from "./qqbot-client.js";

const SECRET = "qq-client-secret-value";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function tokenFetcher(expiresIn: string | number = "7200") {
  let counter = 0;
  return vi.fn(async (_url: string, _init: RequestInit) =>
    json({ access_token: `tok-${(counter += 1)}`, expires_in: expiresIn }),
  );
}

describe("qqbot access token", () => {
  it("posts appId and clientSecret to bots.qq.com and reuses the cached token", async () => {
    const fetcher = tokenFetcher();
    const first = await getQqbotAccessToken({ appId: "app-cache-1", appSecret: SECRET, fetcher, now: () => 1_000_000 });
    const second = await getQqbotAccessToken({
      appId: "app-cache-1",
      appSecret: SECRET,
      fetcher,
      now: () => 1_000_000 + 3_000_000,
    });
    expect(first).toBe("tok-1");
    expect(second).toBe("tok-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://bots.qq.com/app/getAppAccessToken");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ appId: "app-cache-1", clientSecret: SECRET });
  });

  it("re-mints once the token is within 60 seconds of expiry", async () => {
    const fetcher = tokenFetcher("7200");
    await getQqbotAccessToken({ appId: "app-expiry", appSecret: SECRET, fetcher, now: () => 0 });
    // 7200 s minus the 60 s margin leaves 7140 s of validity.
    await getQqbotAccessToken({ appId: "app-expiry", appSecret: SECRET, fetcher, now: () => 7_139_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const refreshed = await getQqbotAccessToken({
      appId: "app-expiry",
      appSecret: SECRET,
      fetcher,
      now: () => 7_140_001,
    });
    expect(refreshed).toBe("tok-2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keys the cache by app id and secret", async () => {
    const fetcher = tokenFetcher();
    await getQqbotAccessToken({ appId: "app-key", appSecret: "secret-a", fetcher, now: () => 0 });
    await getQqbotAccessToken({ appId: "app-key", appSecret: "secret-b", fetcher, now: () => 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never puts the secret in a mint failure", async () => {
    const rejected = vi.fn(async () => json({ code: 100007, message: `bad secret ${SECRET}` }, 401));
    const error = await getQqbotAccessToken({
      appId: "app-fail-1",
      appSecret: SECRET,
      fetcher: rejected,
      now: () => 0,
    }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain(SECRET);

    const html = vi.fn(async () => new Response("<html>nope</html>", { status: 502 }));
    await expect(
      getQqbotAccessToken({ appId: "app-fail-2", appSecret: SECRET, fetcher: html, now: () => 0 }),
    ).rejects.toThrow(/502/);

    const thrown = vi.fn(async () => {
      throw new Error(`socket hang up for ${SECRET}`);
    });
    const thrownError = await getQqbotAccessToken({
      appId: "app-fail-3",
      appSecret: SECRET,
      fetcher: thrown,
      now: () => 0,
    }).catch((e: unknown) => e as Error);
    expect((thrownError as Error).message).not.toContain(SECRET);
  });

  it("fails clearly when the response carries no access token", async () => {
    const fetcher = vi.fn(async () => json({ expires_in: "7200" }));
    await expect(
      getQqbotAccessToken({ appId: "app-notoken", appSecret: SECRET, fetcher, now: () => 0 }),
    ).rejects.toThrow(/no access_token/);
  });
});

describe("qqbot send", () => {
  function sendFetcher(body: unknown = { id: "msg-1", timestamp: 1 }, status = 200) {
    return vi.fn(async (_url: string, _init: RequestInit) => json(body, status));
  }
  function call(fetcher: ReturnType<typeof sendFetcher>) {
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
  }

  it("posts a passive group reply with msg_id and msg_seq", async () => {
    const fetcher = sendFetcher();
    const result = await qqbotSendText({
      token: "tok",
      sandbox: false,
      target: "group:GROUP_OPENID",
      content: "hello",
      replyMsgId: "evt-1",
      msgSeq: 2,
      fetcher,
    });
    expect(result).toEqual({ messageId: "msg-1" });
    const { url, init, body } = call(fetcher);
    expect(url).toBe("https://api.bot.qq.com/v2/groups/GROUP_OPENID/messages");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("QQBot tok");
    expect(body).toEqual({ content: "hello", msg_type: 0, msg_id: "evt-1", msg_seq: 2 });
  });

  it("routes user, channel and dm targets and the sandbox host", async () => {
    let fetcher = sendFetcher();
    await qqbotSendText({ token: "t", sandbox: false, target: "user:U1", content: "c", msgSeq: 1, fetcher });
    expect(call(fetcher).url).toBe("https://api.bot.qq.com/v2/users/U1/messages");
    expect(call(fetcher).body).toEqual({ content: "c", msg_type: 0, msg_seq: 1 });

    fetcher = sendFetcher();
    await qqbotSendText({
      token: "t",
      sandbox: false,
      target: "channel:C9",
      content: "c",
      replyMsgId: "m",
      msgSeq: 1,
      fetcher,
    });
    expect(call(fetcher).url).toBe("https://api.bot.qq.com/channels/C9/messages");
    expect(call(fetcher).body).toEqual({ content: "c", msg_id: "m" });

    fetcher = sendFetcher();
    await qqbotSendText({ token: "t", sandbox: true, target: "dm:G7", content: "c", msgSeq: 1, fetcher });
    expect(call(fetcher).url).toBe("https://sandbox.api.sgroup.qq.com/dms/G7/messages");
    expect(call(fetcher).body).toEqual({ content: "c" });
  });

  it("re-mints once and retries when QQ rejects the token, and not for other errors", async () => {
    const queue = [json({ code: 11244, message: "token expired" }, 401), json({ id: "after" })];
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => queue.shift() ?? json({}));
    const refreshToken = vi.fn(async () => "fresh");
    const result = await qqbotSendText({
      token: "old",
      sandbox: false,
      target: "user:U",
      content: "c",
      msgSeq: 1,
      fetcher,
      refreshToken,
    });
    expect(result).toEqual({ messageId: "after" });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetcher.mock.calls[1] as [string, RequestInit])[1].body)).msg_seq).toBe(
      JSON.parse(String((fetcher.mock.calls[0] as [string, RequestInit])[1].body)).msg_seq,
    );
    expect(new Headers((fetcher.mock.calls[1] as [string, RequestInit])[1].headers).get("authorization")).toBe(
      "QQBot fresh",
    );

    const twice = vi.fn(async () => json({ code: 11244, message: "x" }, 401));
    await expect(
      qqbotSendText({
        token: "old",
        sandbox: false,
        target: "user:U",
        content: "c",
        msgSeq: 1,
        fetcher: twice,
        refreshToken,
      }),
    ).rejects.toThrow(/401/);
    expect(twice).toHaveBeenCalledTimes(2);

    const forbidden = vi.fn(async () => json({ code: 304003, message: "x" }, 403));
    const refresh2 = vi.fn(async () => "n");
    await expect(
      qqbotSendText({
        token: "old",
        sandbox: false,
        target: "user:U",
        content: "c",
        msgSeq: 1,
        fetcher: forbidden,
        refreshToken: refresh2,
      }),
    ).rejects.toThrow(/403/);
    expect(refresh2).not.toHaveBeenCalled();
  });

  it("does not carry an unscrubbed cause on a thrown mint failure", async () => {
    const thrown = vi.fn(async () => {
      throw new Error("boom " + SECRET);
    });
    const error = await getQqbotAccessToken({
      appId: "app-cause",
      appSecret: SECRET,
      fetcher: thrown,
      now: () => 0,
    }).catch((e: unknown) => e as Error);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SECRET);
    expect(String((error as Error).cause)).not.toContain(SECRET);
  });

  it("percent-encodes the target id", async () => {
    const fetcher = sendFetcher();
    await qqbotSendText({ token: "t", sandbox: false, target: "group:a/b", content: "c", msgSeq: 1, fetcher });
    expect(call(fetcher).url).toBe("https://api.bot.qq.com/v2/groups/a%2Fb/messages");
  });

  it("rejects an unknown target prefix before any request", async () => {
    const fetcher = sendFetcher();
    await expect(
      qqbotSendText({ token: "t", sandbox: false, target: "guild:1", content: "c", msgSeq: 1, fetcher }),
    ).rejects.toThrow("QQBot target must be group:, user:, channel: or dm:");
    await expect(
      qqbotSendText({ token: "t", sandbox: false, target: "group:", content: "c", msgSeq: 1, fetcher }),
    ).rejects.toThrow("QQBot target must be group:, user:, channel: or dm:");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces QQ errors without the token and fails when no message id returns", async () => {
    const denied = sendFetcher({ code: 304003, message: "tok leaked" }, 403);
    const error = await qqbotSendText({
      token: "tok",
      sandbox: false,
      target: "user:U",
      content: "c",
      msgSeq: 1,
      fetcher: denied,
    }).catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain("403");
    expect((error as Error).message).toContain("304003");
    expect((error as Error).message).not.toContain("tok leaked");

    const idless = sendFetcher({ timestamp: 1 });
    await expect(
      qqbotSendText({ token: "tok", sandbox: false, target: "user:U", content: "c", msgSeq: 1, fetcher: idless }),
    ).rejects.toThrow(/no message id/);
  });
});
