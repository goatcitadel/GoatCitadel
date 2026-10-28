import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";

const liveProbeMocks = vi.hoisted(() => ({
  discord: vi.fn(),
  line: vi.fn(),
  mattermost: vi.fn(),
  ntfy: vi.fn(),
  slack: vi.fn(),
  telegram: vi.fn(),
  whatsapp: vi.fn(),
  zalo: vi.fn(),
}));
const webhookProbeMock = vi.hoisted(() => vi.fn());

vi.mock("./channel-bot-live-probes.js", () => ({
  runDiscordBotLiveChecks: liveProbeMocks.discord,
  runLineBotLiveChecks: liveProbeMocks.line,
  runMattermostBotLiveChecks: liveProbeMocks.mattermost,
  runNtfyLiveChecks: liveProbeMocks.ntfy,
  runSlackBotLiveChecks: liveProbeMocks.slack,
  runTelegramBotLiveChecks: liveProbeMocks.telegram,
  runWhatsAppCloudLiveChecks: liveProbeMocks.whatsapp,
  runZaloBotLiveChecks: liveProbeMocks.zalo,
}));

vi.mock("./channel-webhook-probes.js", () => ({
  runWebhookDestinationLiveChecks: webhookProbeMock,
}));

import {
  runIntegrationConnectionLiveChecks,
  type IntegrationDiagnosticsPort,
} from "./integration-diagnostics-service.js";

describe("integration diagnostics live-check routing", () => {
  beforeEach(() => {
    for (const mock of Object.values(liveProbeMocks)) {
      mock.mockReset();
      mock.mockResolvedValue({ checks: [{ key: "ok", status: "pass", message: "ok" }] });
    }
    webhookProbeMock.mockReset();
    webhookProbeMock.mockResolvedValue({ checks: [{ key: "webhook", status: "pass", message: "ok" }] });
  });

  it("routes channel live checks through each connector probe with normalized inputs", async () => {
    const port = createPort();
    const channelInputs: Array<[string, Record<string, unknown>, ReturnType<typeof vi.fn>]> = [
      [
        "slack",
        {
          botToken: "slack-token",
          defaultChannel: "C123",
          targets: [{ default: true, channel: "C123", threadTs: "1700.1" }],
        },
        liveProbeMocks.slack,
      ],
      ["telegram", { botToken: "telegram-token", defaultChatId: "123", parseMode: "HTML" }, liveProbeMocks.telegram],
      [
        "ntfy",
        {
          baseUrl: "https://ntfy.example.test",
          topic: "goatcitadel-ops",
          token: "ntfy-token",
          priority: "4",
        },
        liveProbeMocks.ntfy,
      ],
      [
        "whatsapp",
        {
          accessToken: "wa-token",
          phoneNumberId: "phone-1",
          defaultTarget: "15551234567",
          baseUrl: "https://graph.facebook.com",
          apiVersion: "v20.0",
        },
        liveProbeMocks.whatsapp,
      ],
      [
        "mattermost",
        {
          token: "mattermost-token",
          baseUrl: "https://mattermost.example.test",
          defaultChannel: "town-square",
          defaultTeam: "ops",
        },
        liveProbeMocks.mattermost,
      ],
      ["line", { token: "line-token", defaultTarget: "U123" }, liveProbeMocks.line],
      ["zalo", { token: "zalo-token", defaultTarget: "zalo-user" }, liveProbeMocks.zalo],
    ];

    for (const [key, config, expectedProbe] of channelInputs) {
      await runIntegrationConnectionLiveChecks(port, createConnection(key, config), { includeSandboxSend: true });
      expect(expectedProbe).toHaveBeenCalledWith(expect.objectContaining({ includeSandboxSend: true }));
    }

    expect(liveProbeMocks.slack).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "slack-token",
        channel: "C123",
        threadTs: "1700.1",
        fetcher: expect.any(Function),
      }),
    );
    expect(liveProbeMocks.whatsapp).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "wa-token",
        phoneNumberId: "phone-1",
        baseUrl: "https://graph.facebook.com",
        apiVersion: "v20.0",
      }),
    );
    expect(liveProbeMocks.ntfy).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://ntfy.example.test",
        topic: "goatcitadel-ops",
        token: "ntfy-token",
        priority: "4",
        dryRun: false,
      }),
    );
    expect(liveProbeMocks.mattermost).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://mattermost.example.test",
        token: "mattermost-token",
        defaultTeam: "ops",
      }),
    );
  });

  it("routes Matrix live checks with the access token and gates on the network allowlist", async () => {
    const port = createPort();
    const fetchMock = vi.mocked(port.fetchWithDiagnosticsTimeout);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/account/whoami")
        ? new Response(JSON.stringify({ user_id: "@bot:example.test" }))
        : new Response(JSON.stringify({ joined_rooms: ["!room:example.test"] })),
    );
    const connection = createConnection("matrix", {
      homeserverUrl: "https://matrix.example.test",
      accessToken: "matrix-token",
      defaultRoomId: "!room:example.test",
    });

    const result = await runIntegrationConnectionLiveChecks(port, connection, { includeSandboxSend: false });
    expect(result.checks.map((check) => [check.key, check.status])).toEqual([
      ["matrix_auth", "pass"],
      ["matrix_room", "pass"],
    ]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer matrix-token");

    fetchMock.mockClear();
    vi.mocked(port.isConnectionUrlAllowlisted).mockReturnValue(false);
    const blocked = await runIntegrationConnectionLiveChecks(port, connection, { includeSandboxSend: true });
    expect(blocked.checks[0]).toMatchObject({ key: "matrix_network", status: "fail" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes QQBot live checks with the app secret and gates on the network allowlist", async () => {
    const port = createPort();
    const fetchMock = vi.mocked(port.fetchWithDiagnosticsTimeout);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("getAppAccessToken")
        ? new Response(JSON.stringify({ access_token: "qq-token", expires_in: "7200" }))
        : new Response(JSON.stringify({ id: "BOT1", username: "GoatBot" })),
    );
    const connection = createConnection("qqbot", { appId: "102000", appSecret: "qq-secret" });

    const result = await runIntegrationConnectionLiveChecks(port, connection, { includeSandboxSend: false });
    expect(result.checks.map((check) => [check.key, check.status])).toEqual([
      ["qqbot_auth", "pass"],
      ["qqbot_bot", "pass"],
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://bots.qq.com/app/getAppAccessToken");
    expect(JSON.parse(String(init.body))).toEqual({ appId: "102000", clientSecret: "qq-secret" });

    fetchMock.mockClear();
    vi.mocked(port.isConnectionUrlAllowlisted).mockReturnValue(false);
    const blocked = await runIntegrationConnectionLiveChecks(port, connection, { includeSandboxSend: true });
    expect(blocked.checks[0]).toMatchObject({ key: "qqbot_network", status: "fail" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes WeCom live checks with the application secret and gates on the network allowlist", async () => {
    const port = createPort();
    const fetchMock = vi.mocked(port.fetchWithDiagnosticsTimeout);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/cgi-bin/gettoken")
        ? new Response(JSON.stringify({ errcode: 0, access_token: "wecom-token", expires_in: 7200 }))
        : new Response(JSON.stringify({ errcode: 0, name: "GoatCitadel" })),
    );
    const connection = createConnection("wecom", { corpId: "ww1", agentId: "1000002", secret: "wecom-secret" });

    const result = await runIntegrationConnectionLiveChecks(port, connection, { includeSandboxSend: false });
    expect(result.checks.map((check) => [check.key, check.status])).toEqual([
      ["wecom_auth", "pass"],
      ["wecom_agent", "pass"],
      ["wecom_callback", "warn"],
    ]);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=ww1&corpsecret=wecom-secret");

    fetchMock.mockClear();
    vi.mocked(port.isConnectionUrlAllowlisted).mockReturnValue(false);
    const blocked = await runIntegrationConnectionLiveChecks(port, connection, { includeSandboxSend: true });
    expect(blocked.checks[0]).toMatchObject({ key: "wecom_network", status: "fail" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes webhook live checks and skips incomplete channel credentials", async () => {
    const port = createPort();

    await runIntegrationConnectionLiveChecks(
      port,
      createConnection("google-chat", { webhookUrl: "https://chat.example.test/hook", defaultThreadKey: "thread-1" }),
      { includeSandboxSend: false },
    );
    await runIntegrationConnectionLiveChecks(
      port,
      createConnection("teams", { webhookUrl: "https://teams.example.test/hook", cardTitle: "Ops" }),
      { includeSandboxSend: true },
    );

    expect(webhookProbeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: "google-chat",
        defaultThreadKey: "thread-1",
        includeSandboxSend: false,
      }),
    );
    expect(webhookProbeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: "teams",
        cardTitle: "Ops",
        includeSandboxSend: true,
      }),
    );
    expect(
      await runIntegrationConnectionLiveChecks(port, createConnection("whatsapp", { accessToken: "wa-token" }), {
        includeSandboxSend: true,
      }),
    ).toEqual({ checks: [] });
    expect(
      await runIntegrationConnectionLiveChecks(port, createConnection("mattermost", { token: "mattermost-token" }), {
        includeSandboxSend: true,
      }),
    ).toEqual({ checks: [] });
    expect(
      await runIntegrationConnectionLiveChecks(port, createConnection("unknown-channel", { token: "token" }), {
        includeSandboxSend: true,
      }),
    ).toEqual({ checks: [] });
  });

  it("does not webhook-probe Google Chat app (service-account) connections and asks for a manual reply check", async () => {
    const port = createPort();

    const result = await runIntegrationConnectionLiveChecks(
      port,
      createConnection("google-chat", {
        serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
        audienceType: "project_number",
        audience: "123456789012",
      }),
      { includeSandboxSend: true },
    );

    expect(webhookProbeMock).not.toHaveBeenCalled();
    expect(result.checks).toEqual([
      {
        key: "google_chat_app_live_send",
        status: "warn",
        message:
          "GoatCitadel can't send a test message in Chat app mode. After you finish, message the app from an allowed sender and check that it replies.",
      },
    ]);
  });

  it("lets public HTTPS webhook destinations through governed live checks without a sandbox allowlist entry", async () => {
    const port = createPort();
    port.isConnectionUrlAllowlisted = vi.fn(() => false);

    const result = await runIntegrationConnectionLiveChecks(
      port,
      createConnection("google-chat", {
        webhookUrl: "https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t",
      }),
      { includeSandboxSend: true },
    );

    expect(webhookProbeMock).toHaveBeenCalledWith(expect.objectContaining({ channelKey: "google-chat" }));
    expect(result.checks).toEqual([{ key: "webhook", status: "pass", message: "ok" }]);
    expect(port.isConnectionUrlAllowlisted).not.toHaveBeenCalled();
  });

  it("refuses plain HTTP, private, and unlisted loopback webhook destinations before probing", async () => {
    const port = createPort();
    const destinations = [
      "http://chat.googleapis.com/v1/spaces/AAA/messages",
      "https://10.0.0.5/hook",
      "http://127.0.0.1:9/hook",
      "https://localhost/hook",
      "https://169.254.169.254/latest/meta-data",
    ];

    for (const webhookUrl of destinations) {
      const result = await runIntegrationConnectionLiveChecks(port, createConnection("teams", { webhookUrl }), {
        includeSandboxSend: true,
      });
      expect(result.checks).toEqual([
        expect.objectContaining({
          key: "teams_sandbox_send",
          status: "fail",
          message: expect.stringContaining("public HTTPS"),
        }),
      ]);
      expect(result.probe?.steps[0]).toMatchObject({ status: "fail", disposition: "blocking" });
      expect(JSON.stringify(result)).not.toContain(webhookUrl);
    }
    expect(webhookProbeMock).not.toHaveBeenCalled();
  });

  it("allows an explicitly allowlisted loopback webhook destination", async () => {
    const port = createPort();
    port.config.toolPolicy.sandbox.networkAllowlist = ["127.0.0.1"];

    await runIntegrationConnectionLiveChecks(
      port,
      createConnection("slack", { webhookUrl: "http://127.0.0.1:9/services/T/B/C" }),
      { includeSandboxSend: true },
    );

    expect(webhookProbeMock).toHaveBeenCalledWith(expect.objectContaining({ channelKey: "slack" }));
  });
});

function createPort(): IntegrationDiagnosticsPort {
  return {
    config: {
      toolPolicy: {
        tools: { profile: "default" },
        sandbox: { networkAllowlist: [] },
      },
    },
    fetchWithDiagnosticsTimeout: vi.fn(async () => new Response("{}")),
    getDiscordRuntimeStatus: vi.fn(),
    isConnectionUrlAllowlisted: vi.fn(() => true),
    readConnectionConfigValue: vi.fn((config: Record<string, unknown>, key: string) => {
      const value = config[key];
      return typeof value === "string" ? value : undefined;
    }),
    resolveConnectionSecret: vi.fn((config: Record<string, unknown>, directKey: string) => {
      const value = config[directKey];
      return typeof value === "string" ? value : undefined;
    }),
  };
}

function createConnection(key: string, config: Record<string, unknown>): IntegrationConnection {
  return {
    connectionId: `${key}-connection`,
    catalogId: `channel.${key}`,
    kind: "channel",
    key,
    label: key,
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
  };
}
