import type {
  ChannelProbeReport,
  ChannelSetupFailureCategory,
  ConnectorDiagnosticReport,
} from "@goatcitadel/contracts";
import { readBoundedResponseText } from "./bounded-response-reader.js";

type WebhookChannelKey = "google-chat" | "teams";

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
  const connectionLabel = input.channelKey === "google-chat" ? "Google Chat" : "Teams";
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

  const request = buildWebhookProbeRequest(input);
  try {
    const response = await input.fetcher(request.url, request.init);
    if (!response.ok) {
      const detail = await readWebhookProbeDetail(response);
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
      message: `Probe failed before ${connectionLabel} responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return {
      checks: mapProbeStepsToChecks(probe.steps),
      probe,
    };
  }
}

function mapProbeStepsToChecks(steps: ChannelProbeReport["steps"]): ConnectorDiagnosticReport["checks"] {
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

async function readWebhookProbeDetail(response: Response): Promise<string | undefined> {
  const text = (
    await readBoundedResponseText(response, {
      maxBytes: 64 * 1024,
      timeoutMs: 5_000,
      label: "channel webhook probe",
    })
  ).trim();
  if (!text) {
    return undefined;
  }
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    for (const candidate of [payload.error, payload.description, payload.message]) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
  } catch {
    return text;
  }
  return text;
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
