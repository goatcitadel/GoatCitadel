import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { readBoundedResponseJson } from "./bounded-response-reader.js";

const DEFAULT_SLACK_SCOPES = [
  "chat:write",
  "chat:write.public",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "app_mentions:read",
].join(",");

export interface SlackOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  stateSecret?: string;
  scopes?: string;
  brokerAuthorizeUrl?: string;
  origin?: string;
}

export interface SlackOAuthStartResult {
  authorizationUrl?: string;
  state?: string;
  configured: boolean;
  mode: "hosted" | "self_owned" | "missing";
  scopes: string[];
  missing: string[];
}

export interface SlackOAuthTokenPayload {
  ok?: boolean;
  access_token?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: {
    id?: string;
    name?: string;
  };
  authed_user?: {
    id?: string;
  };
  incoming_webhook?: {
    channel?: string;
    channel_id?: string;
    url?: string;
  };
  error?: string;
}

export interface SlackOAuthInstallResult {
  connection: IntegrationConnection;
  install: {
    installId: string;
    teamId?: string;
    teamName?: string;
    botUserId?: string;
    scopes: string[];
    installerUserId?: string;
    webhookChannel?: string;
    webhookChannelId?: string;
  };
}

export function buildSlackOAuthStart(input: SlackOAuthConfig): SlackOAuthStartResult {
  const scopes = parseScopes(input.scopes ?? DEFAULT_SLACK_SCOPES);
  const brokerAuthorizeUrl = input.brokerAuthorizeUrl?.trim();
  const clientId = input.clientId?.trim();
  const redirectUri = input.redirectUri?.trim();
  const stateSecret = input.stateSecret?.trim();
  const missing = [
    clientId ? undefined : "GOATCITADEL_SLACK_OAUTH_CLIENT_ID",
    input.clientSecret?.trim() ? undefined : "GOATCITADEL_SLACK_OAUTH_CLIENT_SECRET",
    redirectUri ? undefined : "GOATCITADEL_SLACK_OAUTH_REDIRECT_URI",
    stateSecret ? undefined : "GOATCITADEL_SLACK_OAUTH_STATE_SECRET",
  ].filter((item): item is string => Boolean(item));

  if (!clientId || !input.clientSecret?.trim() || !redirectUri || !stateSecret) {
    return {
      configured: false,
      mode: "missing",
      scopes,
      missing,
    };
  }

  const statePayload: Record<string, unknown> = {
    nonce: randomBytes(16).toString("base64url"),
    issuedAt: Date.now(),
  };
  if (input.origin) {
    statePayload.origin = input.origin;
  }

  const state = signSlackOAuthState(statePayload, stateSecret);
  const authorizationUrl = new URL(brokerAuthorizeUrl || "https://slack.com/oauth/v2/authorize");
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("scope", scopes.join(","));
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", state);

  return {
    authorizationUrl: authorizationUrl.toString(),
    state,
    configured: true,
    mode: brokerAuthorizeUrl ? "hosted" : "self_owned",
    scopes,
    missing: [],
  };
}

export function verifySlackOAuthState(state: string, stateSecret: string, maxAgeMs = 10 * 60 * 1000): boolean {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) {
    return false;
  }
  const expected = sign(encoded, stateSecret);
  if (!safeEqual(signature, expected)) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { issuedAt?: unknown };
    return typeof payload.issuedAt === "number" && Date.now() - payload.issuedAt <= maxAgeMs;
  } catch {
    return false;
  }
}

export async function exchangeSlackOAuthCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<SlackOAuthTokenPayload> {
  const body = new URLSearchParams();
  body.set("code", input.code);
  body.set("client_id", input.clientId);
  body.set("client_secret", input.clientSecret);
  body.set("redirect_uri", input.redirectUri);
  const response = await input.fetcher("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await readBoundedResponseJson<SlackOAuthTokenPayload>(response, {
    maxBytes: 64 * 1024,
    timeoutMs: 5_000,
    label: "Slack OAuth",
  });
  if (response.status < 200 || response.status >= 300 || payload.ok === false) {
    throw new Error(
      payload.error ? `Slack OAuth failed: ${payload.error}` : `Slack OAuth failed with HTTP ${response.status}.`,
    );
  }
  return payload;
}

export function buildSlackOAuthConnectionInput(payload: SlackOAuthTokenPayload): {
  catalogId: string;
  label: string;
  enabled: boolean;
  status: "connected";
  config: Record<string, unknown>;
} {
  const teamId = payload.team?.id?.trim();
  const teamName = payload.team?.name?.trim();
  const installId = teamId ? `slack:${teamId}` : `slack:${randomBytes(8).toString("hex")}`;
  const webhookTarget = payload.incoming_webhook?.channel_id || payload.incoming_webhook?.channel;
  return {
    catalogId: "channel.slack",
    label: teamName ? `Slack - ${teamName}` : "Slack workspace",
    enabled: true,
    status: "connected",
    config: {
      authMode: "oauth",
      slackInstallId: installId,
      slackTeamId: teamId,
      slackTeamName: teamName,
      slackBotUserId: payload.bot_user_id,
      slackAppId: payload.app_id,
      slackScopes: payload.scope,
      slackInstallerUserId: payload.authed_user?.id,
      botToken: payload.access_token,
      targets: webhookTarget
        ? [
            {
              id: "default",
              label: payload.incoming_webhook?.channel || "Slack default",
              channel: webhookTarget,
              default: true,
              kind: "channel",
            },
          ]
        : [],
      defaultChannel: webhookTarget,
      oauthConnectedAt: new Date().toISOString(),
    },
  };
}

export function redactSlackOAuthConnection(connection: IntegrationConnection): IntegrationConnection {
  return {
    ...connection,
    config: {
      ...connection.config,
      botToken: connection.config.botToken ? "[redacted]" : undefined,
      webhookUrl: connection.config.webhookUrl ? "[redacted]" : undefined,
    },
  };
}

export function summarizeSlackOAuthInstall(connection: IntegrationConnection): SlackOAuthInstallResult["install"] {
  const config = connection.config;
  return {
    installId: readString(config, "slackInstallId") ?? connection.connectionId,
    teamId: readString(config, "slackTeamId"),
    teamName: readString(config, "slackTeamName"),
    botUserId: readString(config, "slackBotUserId"),
    scopes: parseScopes(readString(config, "slackScopes") ?? ""),
    installerUserId: readString(config, "slackInstallerUserId"),
  };
}

export function parseScopes(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function signSlackOAuthState(payload: Record<string, unknown>, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
