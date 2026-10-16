import {
  NTFY_OUTBOUND_MARKER_TAG,
  redactSecretText,
  type ChannelProbeReport,
  type ConnectorDiagnosticReport,
} from "@goatcitadel/contracts";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import { mapProbeStepsToChecks, parseJsonRecord, inferFailureCategory, asString } from "./channel-probe-result.js";
type BotProbeChecks = { checks: ConnectorDiagnosticReport["checks"]; probe: ChannelProbeReport };
interface NtfyProbeInput {
  baseUrl: string;
  topic: string;
  token?: string;
  priority?: string;
  dryRun?: boolean;
  includeSandboxSend: boolean;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  checkedAt?: string;
}

export async function runNtfyLiveChecks(input: NtfyProbeInput): Promise<BotProbeChecks> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const probe: ChannelProbeReport = {
    kind: "ntfy_publish",
    mode: input.dryRun ? "dry_run" : "http_publish",
    checkedAt,
    steps: [],
  };

  if (!input.includeSandboxSend || input.dryRun) {
    probe.steps.push({
      key: "ntfy_sandbox_send",
      label: "Sandbox send",
      status: "skipped",
      disposition: input.dryRun ? "deferred" : "blocking",
      message: input.dryRun
        ? "Sandbox publish skipped because this connection is configured for dry-run validation."
        : "Sandbox publish skipped for non-destructive probe mode; ntfy has no separate auth-only endpoint.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  let publishStarted = false;
  try {
    const url = buildNtfyProbeUrl(input.baseUrl, input.topic);
    publishStarted = true;
    const response = await input.fetcher(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Title: "GoatCitadel channel setup probe",
        // Marks the probe so the inbound stream never echoes it back as a turn.
        "X-Tags": NTFY_OUTBOUND_MARKER_TAG,
        Priority: normalizeNtfyProbePriority(input.priority),
        ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
      },
      body: `[GoatCitadel ntfy probe ${checkedAt}] Channel setup smoke check.`,
    });
    const detail = sanitizeNtfyProbeText(
      await readBoundedResponseText(response, {
        maxBytes: 32 * 1024,
        timeoutMs: 5_000,
        label: "ntfy channel probe",
      }),
      input.token,
    );
    if (!response.ok) {
      probe.steps.push({
        key: "ntfy_sandbox_send",
        label: "Sandbox send",
        status: response.status >= 500 ? "warn" : "fail",
        message: detail || `ntfy returned HTTP ${response.status}.`,
        failureCategory: inferFailureCategory(response.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "ntfy_sandbox_send",
      label: "Sandbox send",
      status: "pass",
      providerMessageId: asString(parseJsonRecord(detail).id),
      message: "Sandbox notification publish was accepted by ntfy; confirm receipt on the configured topic.",
    });
    probe.steps.push({
      key: "ntfy_sandbox_cleanup",
      label: "Sandbox cleanup",
      status: "skipped",
      disposition: "deferred",
      cleanupStatus: "unsupported",
      message: "ntfy does not expose a portable delete operation for a published notification.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  } catch (error) {
    probe.steps.push({
      key: "ntfy_sandbox_send",
      label: "Sandbox send",
      status: publishStarted ? "warn" : "fail",
      message: `${
        publishStarted
          ? "Publish outcome may be unknown; confirm the topic manually."
          : "Probe failed before the ntfy publish request started."
      } ${sanitizeNtfyProbeText(error instanceof Error ? error.message : String(error), input.token)}`,
      failureCategory: publishStarted ? "platform_unavailable" : "malformed_value",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }
}

function buildNtfyProbeUrl(baseUrl: string, topic: string): string {
  const normalizedTopic = topic.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(normalizedTopic)) {
    throw new Error("ntfy topic must contain only letters, numbers, dots, underscores, and dashes.");
  }
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("ntfy base URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("ntfy base URL must not embed credentials; use the token field instead.");
  }
  const prefix = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${prefix}/${encodeURIComponent(normalizedTopic)}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function normalizeNtfyProbePriority(priority: string | undefined): string {
  const normalized = priority?.trim();
  return normalized && /^[1-5]$/.test(normalized) ? normalized : "3";
}

function sanitizeNtfyProbeText(value: string, token: string | undefined): string {
  let sanitized = redactSecretText(value).value;
  const normalizedToken = token?.trim();
  if (normalizedToken) {
    sanitized = sanitized.split(normalizedToken).join("[REDACTED]");
  }
  return sanitized.trim();
}
