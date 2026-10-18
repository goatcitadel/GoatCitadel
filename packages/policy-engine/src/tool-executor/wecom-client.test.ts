import { describe, expect, it, vi } from "vitest";
import { clearWecomAccessToken, getWecomAccessToken, wecomSendText } from "./wecom-client.js";

const SECRET = "wecom-app-secret-value";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function tokenFetcher() {
  let counter = 0;
  return vi.fn(async (_url: string, _init: RequestInit) =>
    json({ errcode: 0, errmsg: "ok", access_token: `wtok-${(counter += 1)}`, expires_in: 7200 }),
  );
}

describe("wecom access token", () => {
  it("gets /cgi-bin/gettoken with corpid and corpsecret and reuses the cache", async () => {
    const fetcher = tokenFetcher();
    const first = await getWecomAccessToken({ corpId: "corp-cache", secret: SECRET, fetcher, now: () => 0 });
    const second = await getWecomAccessToken({ corpId: "corp-cache", secret: SECRET, fetcher, now: () => 7_139_000 });
    expect(first).toBe("wtok-1");
    expect(second).toBe("wtok-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=corp-cache&corpsecret=${SECRET}`);
    expect(init.method).toBe("GET");
    const third = await getWecomAccessToken({ corpId: "corp-cache", secret: SECRET, fetcher, now: () => 7_140_001 });
    expect(third).toBe("wtok-2");
  });

  it("throws the errcode only on failure and never echoes the secret or url", async () => {
    const fetcher = vi.fn(async () => json({ errcode: 40013, errmsg: `invalid corpid ${SECRET}` }));
    const error = await getWecomAccessToken({ corpId: "corp-bad", secret: SECRET, fetcher, now: () => 0 }).catch(
      (e: unknown) => e as Error,
    );
    expect((error as Error).message).toBe("WeCom gettoken failed (errcode 40013)");

    const httpError = vi.fn(async () => new Response("<html>x</html>", { status: 503 }));
    const e2 = await getWecomAccessToken({
      corpId: "corp-bad2",
      secret: SECRET,
      fetcher: httpError,
      now: () => 0,
    }).catch((e: unknown) => e as Error);
    expect((e2 as Error).message).toContain("503");
    expect((e2 as Error).message).not.toContain(SECRET);

    const thrown = vi.fn(async (url: string) => {
      throw new Error(`fetch failed for ${url}`);
    });
    const e3 = await getWecomAccessToken({ corpId: "corp-bad3", secret: SECRET, fetcher: thrown, now: () => 0 }).catch(
      (e: unknown) => e as Error,
    );
    expect((e3 as Error).message).not.toContain(SECRET);
  });
});

describe("wecom send", () => {
  function sendFetcher(...bodies: unknown[]) {
    const queue = [...bodies];
    return vi.fn(async (_url: string, _init: RequestInit) =>
      json(queue.shift() ?? { errcode: 0, errmsg: "ok", msgid: "m-1" }),
    );
  }
  function call(fetcher: ReturnType<typeof sendFetcher>, index = 0) {
    const [url, init] = fetcher.mock.calls[index] as [string, RequestInit];
    return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
  }

  it("posts message/send for a user, party, tag and bare id", async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["user:zhangsan", { touser: "zhangsan" }],
      ["party:7", { toparty: "7" }],
      ["tag:9", { totag: "9" }],
      ["lisi", { touser: "lisi" }],
    ];
    for (const [target, expected] of cases) {
      const fetcher = sendFetcher({ errcode: 0, errmsg: "ok", msgid: "MSG" });
      const result = await wecomSendText({ token: "t0k", agentId: "1000002", target, content: "hi", fetcher });
      expect(result).toEqual({ messageId: "MSG" });
      const { url, init, body } = call(fetcher);
      expect(url).toBe("https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=t0k");
      expect(init.method).toBe("POST");
      expect(body).toEqual({ ...expected, msgtype: "text", agentid: 1000002, text: { content: "hi" } });
    }
  });

  it("drops the cached token and retries once on 42001", async () => {
    const mint = tokenFetcher();
    const fetcher = sendFetcher(
      { errcode: 42001, errmsg: "access_token expired" },
      { errcode: 0, errmsg: "ok", msgid: "AFTER" },
    );
    await getWecomAccessToken({ corpId: "corp-retry", secret: SECRET, fetcher: mint, now: () => 0 });
    const result = await wecomSendText({
      token: "wtok-1",
      agentId: "1",
      target: "u",
      content: "x",
      fetcher,
      refreshToken: async () => {
        clearWecomAccessToken({ corpId: "corp-retry", secret: SECRET });
        return getWecomAccessToken({ corpId: "corp-retry", secret: SECRET, fetcher: mint, now: () => 0 });
      },
    });
    expect(result).toEqual({ messageId: "AFTER" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(call(fetcher, 1).url).toBe("https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=wtok-2");
  });

  it("retries only once and then reports the errcode", async () => {
    const fetcher = sendFetcher(
      { errcode: 40014, errmsg: "invalid access_token" },
      { errcode: 40014, errmsg: "invalid access_token" },
    );
    const refreshToken = vi.fn(async () => "fresh");
    await expect(
      wecomSendText({ token: "old", agentId: "1", target: "u", content: "x", fetcher, refreshToken }),
    ).rejects.toThrow("WeCom send failed (errcode 40014: invalid access_token)");
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errcodes and never leaks the token url", async () => {
    const fetcher = sendFetcher({ errcode: 60020, errmsg: "not allow access from your ip" });
    await expect(
      wecomSendText({ token: "t0k", agentId: "1", target: "u", content: "x", fetcher, refreshToken: async () => "n" }),
    ).rejects.toThrow("WeCom send failed (errcode 60020: not allow access from your ip)");
    expect(fetcher).toHaveBeenCalledTimes(1);

    const thrown = vi.fn(async (url: string) => {
      throw new Error(`fetch failed ${url}`);
    });
    const error = await wecomSendText({
      token: "t0k",
      agentId: "1",
      target: "u",
      content: "x",
      fetcher: thrown,
    }).catch((e: unknown) => e as Error);
    expect((error as Error).message).not.toContain("t0k");
  });

  it("fails when WeCom reports the single recipient invalid", async () => {
    const fetcher = sendFetcher({ errcode: 0, errmsg: "ok", invaliduser: "ghost", msgid: "M" });
    await expect(wecomSendText({ token: "t", agentId: "1", target: "ghost", content: "x", fetcher })).rejects.toThrow(
      /invalid recipient/,
    );
  });

  it("rejects an empty target id and a non-numeric agent id", async () => {
    const fetcher = sendFetcher();
    await expect(wecomSendText({ token: "t", agentId: "1", target: "user:", content: "x", fetcher })).rejects.toThrow(
      /target/i,
    );
    await expect(wecomSendText({ token: "t", agentId: "abc", target: "u", content: "x", fetcher })).rejects.toThrow(
      /agent id/i,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
