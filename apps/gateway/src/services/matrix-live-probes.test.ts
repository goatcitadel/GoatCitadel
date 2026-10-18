import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import type { IntegrationDiagnosticsPort } from "./integration-diagnostics-service.js";
import { runConfiguredMatrixChecks, runMatrixLiveChecks } from "./matrix-live-probes.js";

const TOKEN = "syt_test_matrix_token";
const ROOM = "!room:example.test";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function routedFetcher(routes: { whoami?: Response; joined?: Response; send?: Response }) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/account/whoami")) return routes.whoami ?? json({ user_id: "@bot:example.test" });
    if (url.endsWith("/joined_rooms")) return routes.joined ?? json({ joined_rooms: [ROOM] });
    if (url.includes("/send/m.room.message/")) return routes.send ?? json({ event_id: "$evt1" });
    throw new Error(`unexpected ${url}`);
  });
}

const base = { homeserverUrl: "https://matrix.example.test/", token: TOKEN, roomId: ROOM };

describe("Matrix live probes", () => {
  it("passes whoami and room membership without sending unless requested", async () => {
    const fetcher = routedFetcher({});
    const result = await runMatrixLiveChecks({ ...base, includeSandboxSend: false, fetcher });
    expect(result.checks.map((c) => [c.key, c.status])).toEqual([
      ["matrix_auth", "pass"],
      ["matrix_room", "pass"],
    ]);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/send/"))).toBe(false);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://matrix.example.test/_matrix/client/v3/account/whoami");
  });

  it("fails with token rejected on a 401 and stops probing", async () => {
    const fetcher = routedFetcher({ whoami: json({ errcode: "M_UNKNOWN_TOKEN" }, 401) });
    const result = await runMatrixLiveChecks({ ...base, includeSandboxSend: true, fetcher });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ key: "matrix_auth", status: "fail" });
    expect(result.checks[0]?.message).toContain("token rejected");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("reports token rejected for a 401 with a non-JSON body", async () => {
    const fetcher = routedFetcher({ whoami: new Response("<html>denied</html>", { status: 401 }) });
    const result = await runMatrixLiveChecks({ ...base, includeSandboxSend: false, fetcher });
    expect(result.checks[0]).toMatchObject({ key: "matrix_auth", status: "fail" });
    expect(result.checks[0]?.message).toContain("token rejected");
  });

  it("reports an HTTP rejection for joined_rooms and send without reading a non-JSON body", async () => {
    const fetcher = routedFetcher({
      joined: new Response("", { status: 403 }),
      send: new Response("<html>no</html>", { status: 403 }),
    });
    const result = await runMatrixLiveChecks({ ...base, includeSandboxSend: true, fetcher });
    expect(result.checks.find((c) => c.key === "matrix_room")?.message).toContain("HTTP 403");
    expect(result.checks.find((c) => c.key === "matrix_sandbox_send")).toMatchObject({ status: "fail" });
  });

  it("warns when the default room is not joined", async () => {
    const fetcher = routedFetcher({ joined: json({ joined_rooms: ["!other:example.test"] }) });
    const result = await runMatrixLiveChecks({ ...base, includeSandboxSend: false, fetcher });
    expect(result.checks.find((c) => c.key === "matrix_room")).toMatchObject({ status: "warn" });
  });

  it("sends an m.notice only when the sandbox send is requested", async () => {
    const fetcher = routedFetcher({});
    const result = await runMatrixLiveChecks({ ...base, includeSandboxSend: true, fetcher });
    const sendCall = fetcher.mock.calls.find(([url]) => String(url).includes("/send/m.room.message/"));
    expect(sendCall).toBeDefined();
    const init = sendCall?.[1] as unknown as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toMatchObject({ msgtype: "m.notice" });
    expect(result.probe.steps.find((s) => s.key === "matrix_sandbox_send")).toMatchObject({
      status: "pass",
      providerMessageId: "$evt1",
    });
  });

  it("refuses a disallowed homeserver host without any fetch", async () => {
    const fetchWithDiagnosticsTimeout = vi.fn();
    const deps = {
      readConnectionConfigValue: (config: Record<string, unknown>, key: string) =>
        typeof config[key] === "string" ? (config[key] as string) : undefined,
      resolveConnectionSecret: () => TOKEN,
      isConnectionUrlAllowlisted: () => false,
      fetchWithDiagnosticsTimeout,
    } as unknown as IntegrationDiagnosticsPort;
    const connection = {
      key: "matrix",
      kind: "channel",
      catalogId: "channel.matrix",
      config: { homeserverUrl: "https://matrix.example.test", accessTokenEnv: "MATRIX_ACCESS_TOKEN" },
    } as unknown as IntegrationConnection;
    const result = await runConfiguredMatrixChecks(deps, connection, true);
    expect(result.checks[0]).toMatchObject({ key: "matrix_network", status: "fail" });
    expect(fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });
});
