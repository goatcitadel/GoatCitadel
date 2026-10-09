import {
  redactSecretText,
  type ChannelProbeReport,
  type ChannelSetupFailureCategory,
  type ConnectorDiagnosticReport,
} from "@goatcitadel/contracts";
import { readBoundedResponseText } from "./bounded-response-reader.js";

type WebhookChannelKey = "google-chat" | "teams" | "slack" | "discord";

interface RunWebhookLiveChecksInput {
  channelKey: WebhookChannelKey;
  webhookUrl?: string;
  includeSandboxSend: boolean;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  defaultThreadKey?: string;
  cardTitle?: string;
  checkedAt?: string;
}

export async function runWebhookDestinationLiveChecks(
  input: RunWebhookLiveChecksInput,
): Promise<{ checks: ConnectorDiagnosticReport["checks"]; probe: ChannelProbeReport }> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const prefix = input.channelKey.replace(/-/g, "_");
  const connectionLabel = input.channelKey === "google-chat" ? "Google Chat" : input.channelKey === "teams" ? "Teams" : input.channelKey === "slack" ? "Slack" : "Discord";
  const probe: ChannelProbeReport = {
    kind: `${prefix}_webhook`,
    mode: "webhook",
    checkedAt,
    steps: [],
  };

  if (!input.webhookUrl) {
    probe.steps.push({
      key: `${prefix}_sandbox_send`,
      label: "Sandbox send",
      status: "fail",
      message: "Webhook URL is missing, so the webhook probe could not run.",
      failureCategory: "missing_input",
    });
    return {
      checks: mapProbeStepsToChecks(probe.steps),
      probe,
    };
  }

  if (!input.includeSandboxSend) {
    probe.steps.push({
      key: `${prefix}_sandbox_send`,
      label: "Sandbox send",
      status: "skipped",
      message:
        "Non-destructive diagnostics skipped the sandbox post. Run the guided test or retest flow to send a webhook probe and confirm delivery manually.",
    });
    return {
      checks: [
        {
          key: `${prefix}_live_send`,
          status: "warn",
          message: `${connectionLabel} live send probe skipped because non-destructive diagnostics do not post webhook messages.`,
        },
      ],
      probe,
    };
  }

  try {
    const request = buildWebhookProbeRequest(input);
    const response = await input.fetcher(request.url, request.init);
    if (!response.ok) {
      const detail = await readWebhookProbeDetail(response, [input.webhookUrl, request.url]);
      probe.steps.push({
        key: `${prefix}_sandbox_send`,
        label: "Sandbox send",
        status: response.status >= 500 ? "warn" : "fail",
        message: detail
          ? `${connectionLabel} returned HTTP ${response.status}: ${detail}`
          : `${connectionLabel} returned HTTP ${response.status}.`,
        failureCategory: inferWebhookFailureCategory(response.status),
      });
      return {
        checks: mapProbeStepsToChecks(probe.steps),
        probe,
      };
    }

    probe.steps.push({
      key: `${prefix}_sandbox_send`,
      label: "Sandbox send",
      status: "pass",
      message: "Webhook accepted the sandbox message. Confirm it arrived in the intended destination.",
    });
    return {
      checks: mapProbeStepsToChecks(probe.steps),
      probe,
    };
  } catch (error) {
    probe.steps.push({
      key: `${prefix}_sandbox_send`,
      label: "Sandbox send",
      status: "warn",
      message: `Probe outcome is uncertain because ${connectionLabel} did not provide a response. Inspect the destination before sending again.`,
      failureCategory: "platform_unavailable",
    });
    return {
      checks: mapProbeStepsToChecks(probe.steps),
      probe,
    };
  }
}

function mapProbeStepsToChecks(steps: ChannelProbeReport["steps"]): ConnectorDiagnosticReport["checks"] {
  for (const step of steps) step.disposition ??= "blocking";
  return steps
    .filter((step) => step.status !== "skipped")
    .map((step) => ({
      key: step.key,
      status: step.status === "pass" ? "pass" : step.status === "fail" ? "fail" : "warn",
      message: `${step.label}: ${step.message}`,
    }));
}

function buildWebhookProbeRequest(input: RunWebhookLiveChecksInput): { url: string; init: RequestInit } {
  const probeMessage = `[GoatCitadel probe ${input.checkedAt ?? new Date().toISOString()}] Channel setup smoke check. Confirm this arrived, then delete or ignore it.`;
  if (input.channelKey === "google-chat") {
    const url = new URL(input.webhookUrl ?? "");
    const threadKey = input.defaultThreadKey?.trim();
    if (threadKey) {
      url.searchParams.set("threadKey", threadKey);
    }
    return {
      url: url.toString(),
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: probeMessage,
        }),
      },
    };
  }

  if (input.channelKey === "slack" || input.channelKey === "discord") return { url: input.webhookUrl ?? "", init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.channelKey === "slack" ? { text: probeMessage } : { content: probeMessage }) } };

  const title = input.cardTitle?.trim() || "GoatCitadel";
  return {
    url: input.webhookUrl ?? "",
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            contentUrl: null,
            content: {
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                {
                  type: "TextBlock",
                  text: title,
                  weight: "Bolder",
                  wrap: true,
                },
                {
                  type: "TextBlock",
                  text: probeMessage,
                  wrap: true,
                },
              ],
            },
          },
        ],
      }),
    },
  };
}

async function readWebhookProbeDetail(response: Response, webhookUrls: readonly string[]): Promise<string | undefined> {
  let text: string;
  try {
    text = (await readBoundedResponseText(response, {
      maxBytes: 64 * 1024,
      timeoutMs: 5_000,
      label: "channel webhook probe",
    })).trim();
  } catch {
    // The HTTP status is already known even when the optional body is unreadable.
    return undefined;
  }
  if (!text) return undefined;
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    for (const candidate of [payload.error, payload.description, payload.message]) {
      if (typeof candidate === "string" && candidate.trim()) return sanitizeWebhookProbeDetail(candidate.trim(), webhookUrls);
    }
  } catch { return sanitizeWebhookProbeDetail(text, webhookUrls); }
  return sanitizeWebhookProbeDetail(text, webhookUrls);
}

function sanitizeWebhookProbeDetail(text: string, webhookUrls: readonly string[]): string {
  const secrets = new Set<string>();
  const addForms = (value: string) => {
    if (!value) return;
    secrets.add(value);
    secrets.add(value.replaceAll("/", "\\/"));
    try { secrets.add(encodeURIComponent(value)); secrets.add(encodeURI(value)); } catch { secrets.add(JSON.stringify(value).slice(1, -1)); }
    try { secrets.add(decodeURIComponent(value)); } catch { secrets.add(JSON.stringify(value).slice(1, -1)); }
    secrets.add(new URLSearchParams({ credential: value }).toString().slice("credential=".length));
  };
  for (const value of webhookUrls) {
    addForms(value);
    try {
      const url = new URL(value);
      addForms(url.toString());
      for (const [key, credential] of url.searchParams) {
        if (/^(?:sig|signature|key|api[_-]?key|token|access[_-]?token|auth|authorization|code|secret|client[_-]?secret)$/i.test(key)) addForms(credential);
      }
      for (const part of url.search.slice(1).split("&")) {
        const separator = part.indexOf("=");
        const key = new URLSearchParams(part).keys().next().value;
        if (separator >= 0 && key && /^(?:sig|signature|key|api[_-]?key|token|access[_-]?token|auth|authorization|code|secret|client[_-]?secret)$/i.test(key)) addForms(part.slice(separator + 1));
      }
      // Slack and Discord callback credentials can live in the path rather than a query.
      const pathCredential = url.pathname.match(/\/(?:api\/(?:v[0-9]+\/)?webhooks\/[^/]+|services\/[^/]+\/[^/]+)\/([^/]+)\/?$/i)?.[1];
      if (pathCredential) addForms(pathCredential);
    } catch { continue; }
  }
  let safe = text;
  for (const credential of [...secrets].sort((left, right) => right.length - left.length)) {
    if (credential) safe = safe.split(credential).join("[REDACTED]");
  }
  // Redact before bounding, so truncation cannot retain a partial known credential.
  // Leave room for the HTTP status and diagnostic label in the 2048-character public field.
  return redactSecretText(safe).value.slice(0, 1800);
}

function inferWebhookFailureCategory(statusCode: number): ChannelSetupFailureCategory {
  if (statusCode === 401) {
    return "credential_rejected";
  }
  if (statusCode === 403) {
    return "permission_mismatch";
  }
  if (statusCode === 404) {
    return "destination_mismatch";
  }
  if (statusCode >= 500) {
    return "platform_unavailable";
  }
  return "unknown";
}
