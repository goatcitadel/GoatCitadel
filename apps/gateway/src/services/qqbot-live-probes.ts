import {
  redactSecretText,
  type ChannelProbeReport,
  type ConnectorDiagnosticReport,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import { isExplicitTrue } from "@goatcitadel/gateway-core";
import { readBoundedResponseJson } from "./bounded-response-reader.js";
import { mapProbeStepsToChecks } from "./channel-probe-result.js";
import type { IntegrationDiagnosticsPort } from "./integration-diagnostics-service.js";

const READ_LIMITS = { maxBytes: 64 * 1024, timeoutMs: 5_000 } as const;
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const API_BASE = "https://api.sgroup.qq.com";
const SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Helpers the diagnostics service hands to channel-owned structural checks (keeps the facade small). */
export interface StructuralCheckContext {
  deps: Pick<IntegrationDiagnosticsPort, "readConnectionConfigValue">;
  config: Record<string, unknown>;
  target: string | undefined;
  checks: ConnectorDiagnosticReport["checks"];
  requireText(key: string, label: string, value: string | undefined, status?: "warn" | "fail"): void;
  requireSecretRef(key: string, label: string, directKey: string, envKey: string): void;
}

/** Structural (no network) QQBot checks. The target is optional, so it only warns. */
export function appendQqbotStructuralChecks(context: StructuralCheckContext): void {
  const { deps, config, checks } = context;
  context.requireText("app_id", "QQBot app id", deps.readConnectionConfigValue(config, "appId"));
  context.requireSecretRef("auth", "QQBot app secret", "appSecret", "appSecretEnv");
  context.requireText("target", "Default QQBot target", context.target, "warn");
  checks.push({
    key: "delivery_posture",
    status: "pass",
    message:
      "QQBot outbound is text-only. Inbound arrives on a signed webhook (ed25519 over the app secret) and is default-deny: only allowlisted QQ openids can start turns. QQ allows active (unprompted) group and C2C messages only within platform quotas, so replies to a recent inbound message are passive replies.",
  });
}

/** Setup preflight for QQBot: allowlist, token mint, bot identity and an optional active sandbox message. */
export async function runConfiguredQqbotChecks(
  deps: IntegrationDiagnosticsPort,
  connection: IntegrationConnection,
  includeSandboxSend: boolean,
) {
  const config = connection.config;
  const read = (key: string) => deps.readConnectionConfigValue(config, key);
  const appId = read("appId");
  const appSecret = deps.resolveConnectionSecret(config, "appSecret", "appSecretEnv", connection.catalogId);
  if (!appId || !appSecret) {
    return {
      checks: [
        {
          key: "qqbot_input",
          status: "fail" as const,
          message: "QQBot requires an app id and an app secret before probing.",
        },
      ],
    };
  }
  const sandbox = isExplicitTrue(config.sandbox);
  const apiBase = sandbox ? SANDBOX_API_BASE : API_BASE;
  // Both hosts are checked before the first request, because the secret is sent to the token host.
  for (const url of [TOKEN_URL, apiBase]) {
    if (!deps.isConnectionUrlAllowlisted(url)) {
      return {
        checks: [
          {
            key: "qqbot_network",
            status: "fail" as const,
            message: `The QQBot host ${new URL(url).hostname} is outside the network allowlist.`,
          },
        ],
      };
    }
  }
  return runQqbotLiveChecks({
    appId,
    appSecret,
    sandbox,
    target: read("defaultTarget"),
    includeSandboxSend,
    fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
  });
}

export async function runQqbotLiveChecks(input: {
  appId: string;
  appSecret: string;
  sandbox: boolean;
  target?: string;
  includeSandboxSend: boolean;
  fetcher: Fetcher;
}) {
  const apiBase = input.sandbox ? SANDBOX_API_BASE : API_BASE;
  const probe: ChannelProbeReport = {
    kind: "qqbot_open_platform",
    mode: "bot_api",
    checkedAt: new Date().toISOString(),
    steps: [],
  };
  let token = "";
  const scrub = (text: string) => redactSecretText(text.split(input.appSecret).join("[redacted]")).value;

  try {
    const response = await input.fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: input.appId, clientSecret: input.appSecret }),
    });
    if (!response.ok) {
      const rejected = response.status === 400 || response.status === 401 || response.status === 403;
      probe.steps.push({
        key: "qqbot_auth",
        label: "App credentials",
        status: rejected ? "fail" : "warn",
        disposition: "blocking",
        message: rejected
          ? "QQBot credentials rejected: QQ refused the app id and secret."
          : `QQBot returned HTTP ${response.status} for the access token request.`,
        failureCategory: rejected ? "credential_rejected" : "platform_unavailable",
      });
      return finish(probe);
    }
    const body = record(await readBoundedResponseJson(response, { ...READ_LIMITS, label: "QQBot token probe" }));
    token = typeof body.access_token === "string" ? body.access_token.trim() : "";
    if (!token) {
      probe.steps.push({
        key: "qqbot_auth",
        label: "App credentials",
        status: "fail",
        disposition: "blocking",
        message: "QQBot credentials rejected: the response had no access token.",
        failureCategory: "credential_rejected",
      });
      return finish(probe);
    }
    probe.steps.push({
      key: "qqbot_auth",
      label: "App credentials",
      status: "pass",
      disposition: "blocking",
      message: "QQ issued an access token for the app id and secret.",
    });
  } catch {
    probe.steps.push({
      key: "qqbot_auth",
      label: "App credentials",
      status: "warn",
      disposition: "blocking",
      message: "The QQ token endpoint could not be reached.",
      failureCategory: "platform_unavailable",
    });
    return finish(probe);
  }

  const headers = { Authorization: `QQBot ${token}` };
  await checkBotIdentity(input.fetcher, apiBase, headers, probe, (text) => scrub(text.split(token).join("[redacted]")));

  if (!input.includeSandboxSend) {
    probe.steps.push({
      key: "qqbot_sandbox_send",
      label: "Sandbox send",
      status: "skipped",
      disposition: "deferred",
      message: "Run the explicit guided test to send a sandbox message.",
    });
    return finish(probe);
  }
  await sandboxSend(input.fetcher, apiBase, headers, probe, input.target);
  return finish(probe);
}

async function checkBotIdentity(
  fetcher: Fetcher,
  apiBase: string,
  headers: Record<string, string>,
  probe: ChannelProbeReport,
  scrub: (text: string) => string,
): Promise<void> {
  try {
    const response = await fetcher(`${apiBase}/users/@me`, { method: "GET", headers });
    if (!response.ok) {
      probe.steps.push({
        key: "qqbot_bot",
        label: "Bot identity",
        status: "warn",
        disposition: "advisory",
        message: `QQBot returned HTTP ${response.status} when reading the bot identity.`,
        failureCategory: "platform_unavailable",
      });
      return;
    }
    const body = record(await readBoundedResponseJson(response, { ...READ_LIMITS, label: "QQBot identity probe" }));
    const name = typeof body.username === "string" && body.username.trim() ? body.username.trim() : "the bot";
    probe.steps.push({
      key: "qqbot_bot",
      label: "Bot identity",
      status: "pass",
      disposition: "advisory",
      message: scrub(`Authenticated as ${name.slice(0, 80)}.`),
    });
  } catch {
    probe.steps.push({
      key: "qqbot_bot",
      label: "Bot identity",
      status: "warn",
      disposition: "advisory",
      message: "The bot identity could not be read.",
      failureCategory: "platform_unavailable",
    });
  }
}

async function sandboxSend(
  fetcher: Fetcher,
  apiBase: string,
  headers: Record<string, string>,
  probe: ChannelProbeReport,
  target: string | undefined,
): Promise<void> {
  if (!target) {
    probe.steps.push({
      key: "qqbot_sandbox_send",
      label: "Sandbox send",
      status: "skipped",
      disposition: "deferred",
      message: "Sandbox send skipped because no default target is configured.",
    });
    return;
  }
  const route = buildSendRoute(target);
  if (!route) {
    probe.steps.push({
      key: "qqbot_sandbox_send",
      label: "Sandbox send",
      status: "fail",
      disposition: "blocking",
      message: "The default target must start with group:, user:, channel: or dm:.",
      failureCategory: "malformed_value",
    });
    return;
  }
  try {
    const response = await fetcher(`${apiBase}${route.path}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "GoatCitadel channel setup verification.", ...route.extra }),
    });
    if (!response.ok) {
      probe.steps.push({
        key: "qqbot_sandbox_send",
        label: "Sandbox send",
        status: response.status >= 500 ? "warn" : "fail",
        disposition: "blocking",
        message: `QQBot rejected the sandbox send (HTTP ${response.status}). QQ limits active (unprompted) messages; message the bot first or verify the target.`,
        failureCategory:
          response.status === 401 || response.status === 403 ? "permission_mismatch" : "destination_mismatch",
      });
      return;
    }
    const body = record(await readBoundedResponseJson(response, { ...READ_LIMITS, label: "QQBot send probe" }));
    probe.steps.push({
      key: "qqbot_sandbox_send",
      label: "Sandbox send",
      status: "pass",
      disposition: "blocking",
      ...(typeof body.id === "string" ? { providerMessageId: body.id } : {}),
      message: "QQ accepted the sandbox message. Confirm receipt manually.",
    });
  } catch {
    probe.steps.push({
      key: "qqbot_sandbox_send",
      label: "Sandbox send",
      status: "warn",
      disposition: "blocking",
      message: "QQBot send outcome is uncertain. Inspect the conversation before running another send.",
      failureCategory: "platform_unavailable",
    });
  }
}

function buildSendRoute(target: string): { path: string; extra: Record<string, unknown> } | undefined {
  const match = /^(group|user|channel|dm):(.+)$/s.exec(target.trim());
  const id = match?.[2]?.trim();
  if (!match || !id) return undefined;
  const encoded = encodeURIComponent(id);
  switch (match[1]) {
    case "group":
      return { path: `/v2/groups/${encoded}/messages`, extra: { msg_type: 0 } };
    case "user":
      return { path: `/v2/users/${encoded}/messages`, extra: { msg_type: 0 } };
    case "channel":
      return { path: `/channels/${encoded}/messages`, extra: {} };
    default:
      return { path: `/dms/${encoded}/messages`, extra: {} };
  }
}

function finish(probe: ChannelProbeReport) {
  return { checks: mapProbeStepsToChecks(probe.steps), probe };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
