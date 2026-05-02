import { describe, expect, it, vi } from "vitest";
import {
  buildSlackOAuthConnectionInput,
  buildSlackOAuthStart,
  exchangeSlackOAuthCode,
  parseScopes,
  redactSlackOAuthConnection,
  summarizeSlackOAuthInstall,
  verifySlackOAuthState,
} from "./slack-oauth-service.js";

describe("slack oauth service", () => {
  it("builds a signed OAuth authorization URL and reports granted scopes", () => {
    const start = buildSlackOAuthStart({
      clientId: "123.abc",
      clientSecret: "client-secret",
      redirectUri: "https://goatcitadel.test/slack/callback",
      stateSecret: "state-secret",
      scopes: "chat:write channels:read,groups:read",
      brokerAuthorizeUrl: "https://broker.goatcitadel.test/slack/authorize",
    });

    expect(start.configured).toBe(true);
    expect(start.mode).toBe("hosted");
    expect(start.scopes).toEqual(["chat:write", "channels:read", "groups:read"]);
    expect(start.state).toBeDefined();
    expect(verifySlackOAuthState(start.state ?? "", "state-secret")).toBe(true);

    const authorizationUrl = new URL(start.authorizationUrl ?? "");
    expect(authorizationUrl.origin).toBe("https://broker.goatcitadel.test");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("123.abc");
    expect(authorizationUrl.searchParams.get("scope")).toBe("chat:write,channels:read,groups:read");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("https://goatcitadel.test/slack/callback");
  });

  it("exchanges an OAuth code and stores install metadata while redacting secrets", async () => {
    const fetcher = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          access_token: "xoxb-secret",
          scope: "chat:write,channels:read",
          bot_user_id: "U-BOT",
          app_id: "A123",
          team: { id: "T123", name: "Citadel" },
          authed_user: { id: "U-INSTALLER" },
          incoming_webhook: { channel: "#ops", channel_id: "C123", url: "https://hooks.slack.test/secret" },
        }),
        { status: 200 },
      );
    });

    const payload = await exchangeSlackOAuthCode({
      code: "code-123",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://goatcitadel.test/slack/callback",
      fetcher,
    });
    const input = buildSlackOAuthConnectionInput(payload);

    expect(fetcher).toHaveBeenCalledWith(
      "https://slack.com/api/oauth.v2.access",
      expect.objectContaining({ method: "POST" }),
    );
    expect(input.config).toEqual(
      expect.objectContaining({
        authMode: "oauth",
        slackInstallId: "slack:T123",
        slackTeamId: "T123",
        slackTeamName: "Citadel",
        slackBotUserId: "U-BOT",
        slackInstallerUserId: "U-INSTALLER",
        botToken: "xoxb-secret",
        defaultChannel: "C123",
      }),
    );
    expect(input.config.targets).toEqual([expect.objectContaining({ channel: "C123", default: true, label: "#ops" })]);

    const redacted = redactSlackOAuthConnection({
      connectionId: "11111111-1111-1111-1111-111111111111",
      catalogId: "channel.slack",
      kind: "channel",
      key: "slack",
      label: "Slack",
      enabled: true,
      status: "connected",
      config: input.config,
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });
    expect(redacted.config.botToken).toBe("[redacted]");
    expect(summarizeSlackOAuthInstall(redacted).scopes).toEqual(["chat:write", "channels:read"]);
  });

  it("parses comma and whitespace separated scopes", () => {
    expect(parseScopes("chat:write channels:read, groups:read")).toEqual([
      "chat:write",
      "channels:read",
      "groups:read",
    ]);
  });
});
