import { redactSecretText, type ChannelProbeReport, type IntegrationConnection } from "@goatcitadel/contracts";
import { parseWecomTarget } from "@goatcitadel/policy-engine";
import { readBoundedResponseJson } from "./bounded-response-reader.js";
import { mapProbeStepsToChecks } from "./channel-probe-result.js";
import { resolveChannelConfigTarget } from "./channel-config.js";
import { readConfigSecret } from "./channel-secret-resolution.js";
import type { StructuralCheckContext } from "./qqbot-live-probes.js";
import type { IntegrationDiagnosticsPort } from "./integration-diagnostics-service.js";

const READ_LIMITS = { maxBytes: 64 * 1024, timeoutMs: 5_000 } as const;
const API_BASE = "https://qyapi.weixin.qq.com";
const TRUSTED_IP_ERRCODE = 60020;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Structural (no network) WeCom checks. The target is optional, so it only warns; the callback is advisory. */
export function appendWecomStructuralChecks(context: StructuralCheckContext): void {
  const { deps, config, checks } = context;
  const read = (key: string) => deps.readConnectionConfigValue(config, key);
  context.requireText("corp_id", "WeCom corp id", read("corpId"));
  context.requireText("agent_id", "WeCom agent id", read("agentId"));
  context.requireSecretRef("auth", "WeCom application secret", "secret", "secretEnv");
  context.requireText("target", "Default WeCom target", context.target, "warn");
  // The encrypted callback reads these two with `readConfigSecret`, so this asks the same reader: a variable counts
  // only when its name is one the callback reads and it holds a value, not merely when a name is set.
  const resolved = (directKey: string, envKey: string) => Boolean(readConfigSecret(config, directKey, envKey));
  const callbackReady =
    resolved("callbackToken", "callbackTokenEnv") && resolved("encodingAesKey", "encodingAesKeyEnv");
  checks.push({
    key: "inbound_callback",
    status: "pass",
    message: callbackReady
      ? "The callback token and EncodingAESKey are configured for the encrypted callback."
      : "The callback token or EncodingAESKey is not configured, so inbound is disabled; outbound sends still work.",
  });
  checks.push({
    key: "delivery_posture",
    status: "pass",
    message:
      "WeCom outbound is text-only application messages. Inbound arrives on the encrypted callback (signature and CorpID verified) and is default-deny: only allowlisted WeCom userids can start turns. The gateway host public IP must be on the application trusted IP list.",
  });
}

/** Setup preflight for WeCom: allowlist, gettoken, application lookup, callback posture and an optional send. */
export async function runConfiguredWecomChecks(
  deps: IntegrationDiagnosticsPort,
  connection: IntegrationConnection,
  includeSandboxSend: boolean,
) {
  const config = connection.config;
  const read = (key: string) => deps.readConnectionConfigValue(config, key);
  const resolve = (directKey: string, envKey: string) =>
    deps.resolveConnectionSecret(config, directKey, envKey, connection.catalogId, connection);
  const corpId = read("corpId");
  const agentId = read("agentId");
  const secret = resolve("secret", "secretEnv");
  if (!corpId || !agentId || !secret) {
    return {
      checks: [
        {
          key: "wecom_input",
          status: "fail" as const,
          message: "WeCom requires a corp id, an agent id and the application secret before probing.",
        },
      ],
    };
  }
  // The fixed host is checked before any request, because the corp secret travels in the gettoken query.
  if (!deps.isConnectionUrlAllowlisted(API_BASE)) {
    return {
      checks: [
        {
          key: "wecom_network",
          status: "fail" as const,
          message: "The WeCom host qyapi.weixin.qq.com is outside the network allowlist.",
        },
      ],
    };
  }
  const callbackToken = resolve("callbackToken", "callbackTokenEnv");
  const encodingAesKey = resolve("encodingAesKey", "encodingAesKeyEnv");
  return runWecomLiveChecks({
    corpId,
    agentId,
    secret,
    callbackConfigured: Boolean(callbackToken && encodingAesKey),
    target: resolveChannelConfigTarget("wecom", config),
    includeSandboxSend,
    fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
  });
}

export async function runWecomLiveChecks(input: {
  corpId: string;
  agentId: string;
  secret: string;
  callbackConfigured: boolean;
  target?: string;
  includeSandboxSend: boolean;
  fetcher: Fetcher;
}) {
  const probe: ChannelProbeReport = {
    kind: "wecom_application",
    mode: "server_api",
    checkedAt: new Date().toISOString(),
    steps: [],
  };
  let token: string;
  // Messages are fixed strings plus numeric codes; a provider errmsg is never echoed (it can carry the IP or ids).
  const scrub = (text: string) => redactSecretText(text.split(input.secret).join("[redacted]")).value;

  try {
    const response = await input.fetcher(
      `${API_BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(input.corpId)}&corpsecret=${encodeURIComponent(input.secret)}`,
      { method: "GET" },
    );
    if (!response.ok) {
      probe.steps.push({
        key: "wecom_auth",
        label: "Application credentials",
        status: "warn",
        disposition: "blocking",
        message: `WeCom returned HTTP ${response.status} for the access token request.`,
        failureCategory: "platform_unavailable",
      });
      return finish(probe);
    }
    const body = record(await readBoundedResponseJson(response, { ...READ_LIMITS, label: "WeCom gettoken probe" }));
    const errcode = Number(body.errcode);
    token = typeof body.access_token === "string" ? body.access_token.trim() : "";
    if (errcode !== 0 || !token) {
      probe.steps.push({
        key: "wecom_auth",
        label: "Application credentials",
        status: "fail",
        disposition: "blocking",
        message: `WeCom rejected the corp id or application secret (errcode ${Number.isInteger(errcode) ? errcode : "unknown"}).`,
        failureCategory: "credential_rejected",
      });
      return finish(probe);
    }
    probe.steps.push({
      key: "wecom_auth",
      label: "Application credentials",
      status: "pass",
      disposition: "blocking",
      message: "WeCom issued an access token for the corp id and secret.",
    });
  } catch {
    probe.steps.push({
      key: "wecom_auth",
      label: "Application credentials",
      status: "warn",
      disposition: "blocking",
      message: "The WeCom token endpoint could not be reached.",
      failureCategory: "platform_unavailable",
    });
    return finish(probe);
  }

  await checkApplication(input, token, probe, scrub);

  probe.steps.push(
    input.callbackConfigured
      ? {
          key: "wecom_callback",
          label: "Inbound callback",
          status: "pass",
          disposition: "advisory",
          message:
            "The callback token and EncodingAESKey are configured. Register the connection webhook URL in the application's message-receiving settings; inbound is default-deny by sender userid.",
        }
      : {
          key: "wecom_callback",
          label: "Inbound callback",
          status: "warn",
          disposition: "advisory",
          message:
            "The callback token or EncodingAESKey is missing, so inbound is disabled. Outbound sends still work.",
        },
  );

  if (!input.includeSandboxSend) {
    probe.steps.push({
      key: "wecom_sandbox_send",
      label: "Test send",
      status: "skipped",
      disposition: "deferred",
      message: "Run the explicit guided test to send a test message.",
    });
    return finish(probe);
  }
  await sandboxSend(input, token, probe);
  return finish(probe);
}

async function checkApplication(
  input: { agentId: string; fetcher: Fetcher },
  token: string,
  probe: ChannelProbeReport,
  scrub: (text: string) => string,
): Promise<void> {
  try {
    const response = await input.fetcher(
      `${API_BASE}/cgi-bin/agent/get?access_token=${encodeURIComponent(token)}&agentid=${encodeURIComponent(input.agentId)}`,
      { method: "GET" },
    );
    if (!response.ok) {
      probe.steps.push({
        key: "wecom_agent",
        label: "Application",
        status: "warn",
        disposition: "blocking",
        message: `WeCom returned HTTP ${response.status} when reading the application.`,
        failureCategory: "platform_unavailable",
      });
      return;
    }
    const body = record(await readBoundedResponseJson(response, { ...READ_LIMITS, label: "WeCom agent probe" }));
    const errcode = Number(body.errcode);
    if (errcode === 0) {
      const name =
        typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "the application";
      probe.steps.push({
        key: "wecom_agent",
        label: "Application",
        status: "pass",
        disposition: "blocking",
        message: scrub(`Found ${name}.`),
      });
      return;
    }
    probe.steps.push({
      key: "wecom_agent",
      label: "Application",
      status: "fail",
      disposition: "blocking",
      message:
        errcode === TRUSTED_IP_ERRCODE
          ? "WeCom refused this computer's public IP (errcode 60020). Add it to the application's trusted IP list."
          : `WeCom could not read the application (errcode ${Number.isInteger(errcode) ? errcode : "unknown"}). Verify the agent id.`,
      failureCategory: errcode === TRUSTED_IP_ERRCODE ? "permission_mismatch" : "destination_mismatch",
    });
  } catch {
    probe.steps.push({
      key: "wecom_agent",
      label: "Application",
      status: "warn",
      disposition: "blocking",
      message: "The WeCom application could not be read.",
      failureCategory: "platform_unavailable",
    });
  }
}

async function sandboxSend(
  input: { agentId: string; target?: string; fetcher: Fetcher },
  token: string,
  probe: ChannelProbeReport,
): Promise<void> {
  const steps = probe.steps;
  if (!input.target?.trim()) {
    steps.push({
      key: "wecom_sandbox_send",
      label: "Test send",
      status: "skipped",
      disposition: "deferred",
      message: "Test message skipped because no default target is configured.",
    });
    return;
  }
  // Same single-recipient rule as the runtime client: never broadcast (@all) or fan out (a|b) from a test send.
  let recipient: Record<string, string>;
  try {
    recipient = parseWecomTarget(input.target).field;
  } catch (error) {
    steps.push({
      key: "wecom_sandbox_send",
      label: "Test send",
      status: "fail",
      disposition: "blocking",
      message: `Test message refused: ${error instanceof Error ? error.message : "invalid default target."}`,
      failureCategory: "destination_mismatch",
    });
    return;
  }
  const agentid = Number(input.agentId);
  try {
    const response = await input.fetcher(`${API_BASE}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...recipient,
        msgtype: "text",
        agentid,
        text: { content: "GoatCitadel channel setup verification." },
      }),
    });
    if (!response.ok) {
      steps.push({
        key: "wecom_sandbox_send",
        label: "Test send",
        status: response.status >= 500 ? "warn" : "fail",
        disposition: "blocking",
        message: `WeCom rejected the test message (HTTP ${response.status}).`,
        failureCategory: "destination_mismatch",
      });
      return;
    }
    const body = record(await readBoundedResponseJson(response, { ...READ_LIMITS, label: "WeCom send probe" }));
    const errcode = Number(body.errcode);
    if (errcode !== 0) {
      steps.push({
        key: "wecom_sandbox_send",
        label: "Test send",
        status: "fail",
        disposition: "blocking",
        message: `WeCom refused the test message (errcode ${Number.isInteger(errcode) ? errcode : "unknown"}). Verify the recipient can see the application.`,
        failureCategory: errcode === TRUSTED_IP_ERRCODE ? "permission_mismatch" : "destination_mismatch",
      });
      return;
    }
    const invalid = readInvalidRecipient(body);
    if (invalid) {
      steps.push({
        key: "wecom_sandbox_send",
        label: "Test send",
        status: "fail",
        disposition: "blocking",
        message: `WeCom reported an invalid recipient for the test message (${invalid}). Verify the user, department or tag can see the application.`,
        failureCategory: "destination_mismatch",
      });
      return;
    }
    steps.push({
      key: "wecom_sandbox_send",
      label: "Test send",
      status: "pass",
      disposition: "blocking",
      ...(typeof body.msgid === "string" ? { providerMessageId: body.msgid } : {}),
      message: "WeCom accepted the test message. Check that it arrived.",
    });
  } catch {
    steps.push({
      key: "wecom_sandbox_send",
      label: "Test send",
      status: "warn",
      disposition: "blocking",
      message: "WeCom send outcome is uncertain. Inspect the conversation before running another send.",
      failureCategory: "platform_unavailable",
    });
  }
}

/** Same rule as the outbound client: errcode 0 with an invalid single recipient is a failure. */
function readInvalidRecipient(body: Record<string, unknown>): string | undefined {
  for (const key of ["invaliduser", "invalidparty", "invalidtag"] as const) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return key;
  }
  return undefined;
}

function finish(probe: ChannelProbeReport) {
  return { checks: mapProbeStepsToChecks(probe.steps), probe };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
