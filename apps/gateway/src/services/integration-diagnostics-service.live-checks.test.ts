import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";

const liveProbeMocks = vi.hoisted(() => ({
  discord: vi.fn(),
  imessage: vi.fn(),
  line: vi.fn(),
  mattermost: vi.fn(),
  ntfy: vi.fn(),
  signal: vi.fn(),
  slack: vi.fn(),
  telegram: vi.fn(),
  whatsapp: vi.fn(),
  zalo: vi.fn(),
  zalouser: vi.fn(),
}));
const webhookProbeMock = vi.hoisted(() => vi.fn());

vi.mock("./channel-bot-live-probes.js", () => ({
  runDiscordBotLiveChecks: liveProbeMocks.discord,
  runIMessageBridgeLiveChecks: liveProbeMocks.imessage,
  runLineBotLiveChecks: liveProbeMocks.line,
  runMattermostBotLiveChecks: liveProbeMocks.mattermost,
  runNtfyLiveChecks: liveProbeMocks.ntfy,
  runSignalBridgeLiveChecks: liveProbeMocks.signal,
  runSlackBotLiveChecks: liveProbeMocks.slack,
  runTelegramBotLiveChecks: liveProbeMocks.telegram,
  runWhatsAppCloudLiveChecks: liveProbeMocks.whatsapp,
  runZaloBotLiveChecks: liveProbeMocks.zalo,
  runZaloUserBridgeLiveChecks: liveProbeMocks.zalouser,
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
        "signal",
        {
          bridgeUrl: "http://127.0.0.1:9000",
          accountId: "signal-account",
          defaultRecipient: "+15551234567",
        },
        liveProbeMocks.signal,
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
      [
        "imessage",
        {
          bridgeUrl: "http://127.0.0.1:4321",
          apiPassword: "bridge-password",
          defaultTarget: "+15551234567",
        },
        liveProbeMocks.imessage,
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
    expect(liveProbeMocks.imessage).toHaveBeenCalledWith(
      expect.objectContaining({
        password: "bridge-password",
        defaultHandle: "+15551234567",
      }),
    );
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
