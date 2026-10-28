import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import type { IntegrationDiagnosticsPort } from "./integration-diagnostics-service.js";
import { appendWecomStructuralChecks, runConfiguredWecomChecks, runWecomLiveChecks } from "./wecom-live-probes.js";

const SECRET = "wecom-probe-secret";
const TOKEN = "wecom-probe-access-token";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function routedFetcher(routes: { token?: Response; agent?: Response; send?: Response }) {
  return vi.fn(async (url: string) => {
    if (url.includes("/cgi-bin/gettoken")) {
      return routes.token ?? json({ errcode: 0, errmsg: "ok", access_token: TOKEN, expires_in: 7200 });
    }
    if (url.includes("/cgi-bin/agent/get")) {
      return routes.agent ?? json({ errcode: 0, errmsg: "ok", agentid: 1000002, name: "GoatCitadel" });
    }
    if (url.includes("/cgi-bin/message/send")) return routes.send ?? json({ errcode: 0, errmsg: "ok", msgid: "M1" });
    throw new Error(`unexpected ${url}`);
  });
}

const base = {
  corpId: "ww1",
  agentId: "1000002",
  secret: SECRET,
  callbackConfigured: true,
  target: "user:zhangsan",
};

describe("WeCom live probes", () => {
  it("mints a token and reads the application without sending unless requested", async () => {
    const fetcher = routedFetcher({});
    const result = await runWecomLiveChecks({ ...base, includeSandboxSend: false, fetcher });
    expect(result.checks.map((c) => [c.key, c.status])).toEqual([
      ["wecom_auth", "pass"],
      ["wecom_agent", "pass"],
      ["wecom_callback", "pass"],
    ]);
    expect(result.probe.steps.find((s) => s.key === "wecom_sandbox_send")).toMatchObject({ status: "skipped" });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/message/send"))).toBe(false);
    const agent = fetcher.mock.calls.find(([url]) => String(url).includes("/cgi-bin/agent/get"));
    expect(String(agent?.[0])).toBe(
      `https://qyapi.weixin.qq.com/cgi-bin/agent/get?access_token=${TOKEN}&agentid=1000002`,
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("reports the errcode when WeCom rejects the corp id or secret and stops probing", async () => {
    const fetcher = routedFetcher({ token: json({ errcode: 40013, errmsg: "invalid corpid" }) });
    const result = await runWecomLiveChecks({ ...base, includeSandboxSend: true, fetcher });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ key: "wecom_auth", status: "fail" });
    expect(result.checks[0]?.message).toContain("errcode 40013");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("checks the HTTP status before reading the gettoken body", async () => {
    const fetcher = routedFetcher({ token: new Response("<html>bad gateway</html>", { status: 502 }) });
    const result = await runWecomLiveChecks({ ...base, includeSandboxSend: false, fetcher });
    expect(result.checks[0]).toMatchObject({ key: "wecom_auth", status: "warn" });
    expect(result.checks[0]?.message).toContain("HTTP 502");
  });

  it("hints at the trusted IP list for errcode 60020", async () => {
    const fetcher = routedFetcher({ agent: json({ errcode: 60020, errmsg: "not allow access from your ip" }) });
    const result = await runWecomLiveChecks({ ...base, includeSandboxSend: false, fetcher });
    const agent = result.checks.find((c) => c.key === "wecom_agent");
    expect(agent).toMatchObject({ status: "fail" });
    expect(agent?.message).toContain("trusted IP");
  });

  it("warns that inbound is disabled when the callback token or AES key are missing", async () => {
    const result = await runWecomLiveChecks({
      ...base,
      callbackConfigured: false,
      includeSandboxSend: false,
      fetcher: routedFetcher({}),
    });
    const callback = result.checks.find((c) => c.key === "wecom_callback");
    expect(callback).toMatchObject({ status: "warn" });
    expect(callback?.message).toMatch(/inbound is disabled/i);
  });

  it("sends a sandbox text only when requested", async () => {
    const fetcher = routedFetcher({});
    const result = await runWecomLiveChecks({ ...base, includeSandboxSend: true, fetcher });
    const sendCall = fetcher.mock.calls.find(([url]) => String(url).includes("/message/send"));
    expect(String(sendCall?.[0])).toBe(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${TOKEN}`);
    expect(JSON.parse(String((sendCall?.[1] as RequestInit).body))).toMatchObject({
      touser: "zhangsan",
      msgtype: "text",
      agentid: 1000002,
    });
    expect(result.probe.steps.find((s) => s.key === "wecom_sandbox_send")).toMatchObject({
      status: "pass",
      providerMessageId: "M1",
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("skips the sandbox send without a target and fails with an errcode when WeCom refuses", async () => {
    const none = await runWecomLiveChecks({
      ...base,
      target: undefined,
      includeSandboxSend: true,
      fetcher: routedFetcher({}),
    });
    expect(none.probe.steps.find((s) => s.key === "wecom_sandbox_send")).toMatchObject({ status: "skipped" });

    const refused = await runWecomLiveChecks({
      ...base,
      includeSandboxSend: true,
      fetcher: routedFetcher({ send: json({ errcode: 81013, errmsg: "user & party & tag all invalid" }) }),
    });
    expect(refused.checks.find((c) => c.key === "wecom_sandbox_send")).toMatchObject({ status: "fail" });
    expect(refused.checks.find((c) => c.key === "wecom_sandbox_send")?.message).toContain("errcode 81013");
  });

  it.each(["@all", "user:@all", "user:@ALL", "user:a|b"])(
    "refuses a broadcast or multi-recipient sandbox target %s without sending",
    async (target) => {
      const fetcher = routedFetcher({});
      const result = await runWecomLiveChecks({ ...base, target, includeSandboxSend: true, fetcher });
      expect(result.checks.find((c) => c.key === "wecom_sandbox_send")).toMatchObject({ status: "fail" });
      expect(result.checks.find((c) => c.key === "wecom_sandbox_send")?.message).toContain("single");
      expect(fetcher.mock.calls.some(([url]) => String(url).includes("/cgi-bin/message/send"))).toBe(false);
    },
  );

  it("fails the sandbox send when WeCom reports the recipient invalid", async () => {
    const result = await runWecomLiveChecks({
      ...base,
      includeSandboxSend: true,
      fetcher: routedFetcher({ send: json({ errcode: 0, errmsg: "ok", invaliduser: "zhangsan", msgid: "M" }) }),
    });
    expect(result.checks.find((c) => c.key === "wecom_sandbox_send")).toMatchObject({ status: "fail" });
  });

  it("does not leak the token when a fetch throws", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/gettoken")) return json({ errcode: 0, access_token: TOKEN, expires_in: 7200 });
      throw new Error(`socket closed ${url}`);
    });
    const result = await runWecomLiveChecks({ ...base, includeSandboxSend: false, fetcher });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

function depsFor(options: { allowlisted: (url: string) => boolean; secret?: string | undefined }) {
  const fetchWithDiagnosticsTimeout = vi.fn(async () => json({}));
  const deps = {
    readConnectionConfigValue: (config: Record<string, unknown>, key: string) =>
      typeof config[key] === "string" ? (config[key] as string) : undefined,
    resolveConnectionSecret: () => options.secret,
    isConnectionUrlAllowlisted: options.allowlisted,
    fetchWithDiagnosticsTimeout,
  } as unknown as IntegrationDiagnosticsPort;
  return { deps, fetchWithDiagnosticsTimeout };
}

const connection = {
  key: "wecom",
  kind: "channel",
  catalogId: "channel.wecom",
  config: { corpId: "ww1", agentId: "1000002", secretEnv: "WECOM_SECRET" },
} as unknown as IntegrationConnection;

describe("WeCom structural callback readiness", () => {
  const structuralConfig = {
    corpId: "ww1",
    agentId: "1000002",
    secretEnv: "WECOM_SECRET",
    callbackTokenEnv: "WECOM_TEST_CALLBACK_TOKEN",
    encodingAesKeyEnv: "WECOM_TEST_ENCODING_AES_KEY",
  };
  function callbackMessage(config: Record<string, unknown>): string | undefined {
    const checks: Array<{ key: string; status: string; message: string }> = [];
    appendWecomStructuralChecks({
      deps: {
        readConnectionConfigValue: (c: Record<string, unknown>, key: string) =>
          typeof c[key] === "string" ? (c[key] as string) : undefined,
      },
      config,
      target: undefined,
      checks: checks as never,
      requireText: () => undefined,
      requireSecretRef: () => undefined,
    });
    return checks.find((c) => c.key === "inbound_callback")?.message;
  }

  it("is not ready when the callback env names are set but unresolved", () => {
    expect(callbackMessage(structuralConfig)).toContain("is not configured");
  });

  it("is ready when the callback env values resolve", () => {
    vi.stubEnv("WECOM_TEST_CALLBACK_TOKEN", "t");
    vi.stubEnv("WECOM_TEST_ENCODING_AES_KEY", "k");
    try {
      expect(callbackMessage(structuralConfig)).toContain("are configured");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["an LLM provider key", "OPENAI_API_KEY"],
    ["a Gateway key", "GOATCITADEL_AUTH_TOKEN"],
    ["a name outside the callback's allowlist", "WECOM_TEST_CB_UNSET"],
    ["a lowercase name", "wecom_test_callback_token"],
  ])("does not count %s as the callback token or key, even when it is set", (_label, name) => {
    vi.stubEnv(name, "synthetic-callback-value");
    try {
      expect(callbackMessage({ ...structuralConfig, callbackTokenEnv: name, encodingAesKeyEnv: name })).toContain(
        "is not configured",
      );
      vi.stubEnv("WECOM_TEST_CALLBACK_TOKEN", "t");
      expect(
        callbackMessage({
          ...structuralConfig,
          callbackTokenEnv: "WECOM_TEST_CALLBACK_TOKEN",
          encodingAesKeyEnv: name,
        }),
      ).toContain("is not configured");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("counts a pasted callback token and key without reading any variable", () => {
    expect(
      callbackMessage({ ...structuralConfig, callbackToken: "pasted-token", encodingAesKey: "pasted-key" }),
    ).toContain("are configured");
  });
});

describe("WeCom configured probe gates", () => {
  it("requires corp id, agent id and secret before probing", async () => {
    const { deps, fetchWithDiagnosticsTimeout } = depsFor({ allowlisted: () => true, secret: undefined });
    const result = await runConfiguredWecomChecks(deps, connection, true);
    expect(result.checks[0]).toMatchObject({ key: "wecom_input", status: "fail" });
    expect(fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("refuses a disallowed host before any fetch carrying the secret", async () => {
    const { deps, fetchWithDiagnosticsTimeout } = depsFor({ allowlisted: () => false, secret: SECRET });
    const result = await runConfiguredWecomChecks(deps, connection, true);
    expect(result.checks[0]).toMatchObject({ key: "wecom_network", status: "fail" });
    expect(result.checks[0]?.message).toContain("qyapi.weixin.qq.com");
    expect(fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });
});
