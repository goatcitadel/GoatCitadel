import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import type { IntegrationDiagnosticsPort } from "./integration-diagnostics-service.js";
import { runConfiguredQqbotChecks, runQqbotLiveChecks } from "./qqbot-live-probes.js";

const SECRET = "qq-probe-app-secret";
const TOKEN = "qq-probe-access-token";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function routedFetcher(routes: { token?: Response; me?: Response; send?: Response }) {
  return vi.fn(async (url: string) => {
    if (url === "https://bots.qq.com/app/getAppAccessToken") {
      return routes.token ?? json({ access_token: TOKEN, expires_in: "7200" });
    }
    if (url.endsWith("/users/@me")) return routes.me ?? json({ id: "BOT1", username: "GoatBot" });
    if (url.includes("/messages")) return routes.send ?? json({ id: "msg-probe-1" });
    throw new Error(`unexpected ${url}`);
  });
}

const base = { appId: "102000", appSecret: SECRET, sandbox: false, target: "user:USER_OPENID" };

describe("QQBot live probes", () => {
  it("mints a token and reads the bot identity without sending unless requested", async () => {
    const fetcher = routedFetcher({});
    const result = await runQqbotLiveChecks({ ...base, includeSandboxSend: false, fetcher });
    expect(result.checks.map((c) => [c.key, c.status])).toEqual([
      ["qqbot_auth", "pass"],
      ["qqbot_bot", "pass"],
    ]);
    expect(result.probe.steps.find((s) => s.key === "qqbot_sandbox_send")).toMatchObject({ status: "skipped" });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/messages"))).toBe(false);
    const me = fetcher.mock.calls.find(([url]) => String(url).endsWith("/users/@me"));
    expect(String(me?.[0])).toBe("https://api.bot.qq.com/users/@me");
    expect(new Headers((me?.[1] as RequestInit).headers).get("authorization")).toBe(`QQBot ${TOKEN}`);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("fails with credentials rejected on a 401 before reading the body and stops probing", async () => {
    const fetcher = routedFetcher({ token: new Response("<html>denied</html>", { status: 401 }) });
    const result = await runQqbotLiveChecks({ ...base, includeSandboxSend: true, fetcher });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ key: "qqbot_auth", status: "fail" });
    expect(result.checks[0]?.message).toContain("credentials rejected");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("fails when the token response carries no access token", async () => {
    const fetcher = routedFetcher({ token: json({ expires_in: "7200" }) });
    const result = await runQqbotLiveChecks({ ...base, includeSandboxSend: false, fetcher });
    expect(result.checks[0]).toMatchObject({ key: "qqbot_auth", status: "fail" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("warns when the bot identity cannot be read and does not leak the token", async () => {
    const fetcher = routedFetcher({ me: new Response("", { status: 500 }) });
    const result = await runQqbotLiveChecks({ ...base, includeSandboxSend: false, fetcher });
    expect(result.checks.find((c) => c.key === "qqbot_bot")).toMatchObject({ status: "warn" });
    expect(result.checks.find((c) => c.key === "qqbot_bot")?.message).toContain("HTTP 500");
  });

  it("sends an active sandbox message only when requested and uses the sandbox host", async () => {
    const fetcher = routedFetcher({});
    const result = await runQqbotLiveChecks({ ...base, sandbox: true, includeSandboxSend: true, fetcher });
    const sendCall = fetcher.mock.calls.find(([url]) => String(url).includes("/messages"));
    expect(String(sendCall?.[0])).toBe("https://sandbox.api.sgroup.qq.com/v2/users/USER_OPENID/messages");
    const init = sendCall?.[1] as unknown as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ msg_type: 0 });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("msg_id");
    expect(result.probe.steps.find((s) => s.key === "qqbot_sandbox_send")).toMatchObject({
      status: "pass",
      providerMessageId: "msg-probe-1",
    });
  });

  it("skips the sandbox send without a default target and rejects with a status-only message", async () => {
    const noTarget = await runQqbotLiveChecks({
      ...base,
      target: undefined,
      includeSandboxSend: true,
      fetcher: routedFetcher({}),
    });
    expect(noTarget.probe.steps.find((s) => s.key === "qqbot_sandbox_send")).toMatchObject({ status: "skipped" });

    const rejected = await runQqbotLiveChecks({
      ...base,
      includeSandboxSend: true,
      fetcher: routedFetcher({ send: new Response("<html>no</html>", { status: 403 }) }),
    });
    expect(rejected.checks.find((c) => c.key === "qqbot_sandbox_send")).toMatchObject({ status: "fail" });
    expect(rejected.checks.find((c) => c.key === "qqbot_sandbox_send")?.message).toContain("HTTP 403");

    const badTarget = await runQqbotLiveChecks({
      ...base,
      target: "guild:1",
      includeSandboxSend: true,
      fetcher: routedFetcher({}),
    });
    expect(badTarget.checks.find((c) => c.key === "qqbot_sandbox_send")).toMatchObject({ status: "fail" });
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
  key: "qqbot",
  kind: "channel",
  catalogId: "channel.qqbot",
  config: { appId: "102000", appSecretEnv: "QQBOT_APP_SECRET" },
} as unknown as IntegrationConnection;

describe("QQBot configured probe gates", () => {
  it("requires an app id and secret before probing", async () => {
    const { deps, fetchWithDiagnosticsTimeout } = depsFor({ allowlisted: () => true, secret: undefined });
    const result = await runConfiguredQqbotChecks(deps, connection, true);
    expect(result.checks[0]).toMatchObject({ key: "qqbot_input", status: "fail" });
    expect(fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("refuses a disallowed host before any fetch carrying the secret", async () => {
    const { deps, fetchWithDiagnosticsTimeout } = depsFor({
      allowlisted: (url) => !url.includes("bots.qq.com"),
      secret: SECRET,
    });
    const result = await runConfiguredQqbotChecks(deps, connection, true);
    expect(result.checks[0]).toMatchObject({ key: "qqbot_network", status: "fail" });
    expect(result.checks[0]?.message).toContain("bots.qq.com");
    expect(fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("checks the sandbox API host when sandbox is enabled", async () => {
    const seen: string[] = [];
    const { deps } = depsFor({
      allowlisted: (url) => {
        seen.push(url);
        return url.includes("bots.qq.com");
      },
      secret: SECRET,
    });
    const sandboxed = { ...connection, config: { ...connection.config, sandbox: true } } as IntegrationConnection;
    await runConfiguredQqbotChecks(deps, sandboxed, false);
    expect(seen.join(" ")).toContain("sandbox.api.sgroup.qq.com");
  });
});
