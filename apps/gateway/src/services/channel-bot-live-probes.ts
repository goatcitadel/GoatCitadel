import { randomUUID } from "node:crypto";
import type {
  ChannelProbeReport,
  ChannelSetupFailureCategory,
  ConnectorDiagnosticReport,
  DiscordRuntimeMode,
  DiscordRuntimeStatus,
} from "@goatcitadel/contracts";

type BotProbeChecks = { checks: ConnectorDiagnosticReport["checks"]; probe: ChannelProbeReport };

interface ProbeResponse {
  status: number;
  detail?: string;
  payload: Record<string, unknown>;
}

interface SlackProbeInput {
  token: string;
  channel?: string;
  threadTs?: string;
  includeSandboxSend: boolean;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  checkedAt?: string;
}

interface TelegramProbeInput {
  token: string;
  chatId?: string;
  parseMode?: string;
  includeSandboxSend: boolean;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  checkedAt?: string;
}

interface DiscordProbeInput {
  token?: string;
  channelId?: string;
  runtimeMode: DiscordRuntimeMode;
  webhookUrl?: string;
  includeSandboxSend: boolean;
  runtimeStatus?: Pick<DiscordRuntimeStatus, "ready" | "lastError" | "connectedBotTag">;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  checkedAt?: string;
}

export async function runSlackBotLiveChecks(input: SlackProbeInput): Promise<BotProbeChecks> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const probe: ChannelProbeReport = {
    kind: "slack_bot",
    mode: "bot_token",
    checkedAt,
    steps: [],
  };

  try {
    const auth = await readJsonResponse(await input.fetcher("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
      },
    }));
    if (auth.status < 200 || auth.status >= 300 || auth.payload.ok === false) {
      probe.steps.push({
        key: "slack_token_auth",
        label: "Token auth",
        status: auth.status >= 500 ? "warn" : "fail",
        message: auth.detail ?? `Slack returned HTTP ${auth.status}.`,
        failureCategory: inferFailureCategory(auth.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "slack_token_auth",
      label: "Token auth",
      status: "pass",
      message: "Bot token is valid.",
    });
  } catch (error) {
    probe.steps.push({
      key: "slack_token_auth",
      label: "Token auth",
      status: "warn",
      message: `Probe failed before Slack responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  if (!input.includeSandboxSend) {
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }
  if (!input.channel) {
    probe.steps.push({
      key: "slack_sandbox_send",
      label: "Sandbox send",
      status: "fail",
      message: "Default channel is missing.",
      failureCategory: "missing_input",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  try {
    const send = await readJsonResponse(await input.fetcher("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: input.channel,
        text: `[GoatCitadel Slack probe ${checkedAt}] Channel setup smoke check. Delete me if I remain.`,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      }),
    }));
    if (send.status < 200 || send.status >= 300 || send.payload.ok === false) {
      probe.steps.push({
        key: "slack_sandbox_send",
        label: "Sandbox send",
        status: send.status >= 500 ? "warn" : "fail",
        message: send.detail ?? `Slack returned HTTP ${send.status}.`,
        failureCategory: inferFailureCategory(send.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "slack_sandbox_send",
      label: "Sandbox send",
      status: "pass",
      message: "Sandbox message post succeeded.",
    });
    const messageTs = asString(send.payload.ts);
    const channelId = asString(send.payload.channel) ?? input.channel;
    if (!messageTs) {
      probe.steps.push({
        key: "slack_sandbox_cleanup",
        label: "Sandbox cleanup",
        status: "warn",
        message: "Message posted, but Slack did not return a message timestamp for cleanup.",
        failureCategory: "unknown",
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }

    const cleanup = await readJsonResponse(await input.fetcher("https://slack.com/api/chat.delete", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: channelId,
        ts: messageTs,
      }),
    }));
    if (cleanup.status < 200 || cleanup.status >= 300 || cleanup.payload.ok === false) {
      probe.steps.push({
        key: "slack_sandbox_cleanup",
        label: "Sandbox cleanup",
        status: cleanup.status === 403 ? "warn" : cleanup.status >= 500 ? "warn" : "fail",
        message: cleanup.detail ?? `Slack returned HTTP ${cleanup.status} while deleting the sandbox message.`,
        failureCategory: inferFailureCategory(cleanup.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "slack_sandbox_cleanup",
      label: "Sandbox cleanup",
      status: "pass",
      message: "Sandbox cleanup delete succeeded.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  } catch (error) {
    probe.steps.push({
      key: "slack_sandbox_send",
      label: "Sandbox send",
      status: "warn",
      message: `Probe failed before Slack responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }
}

export async function runTelegramBotLiveChecks(input: TelegramProbeInput): Promise<BotProbeChecks> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const probe: ChannelProbeReport = {
    kind: "telegram_bot",
    mode: "bot_token",
    checkedAt,
    steps: [],
  };

  try {
    const auth = await readJsonResponse(await input.fetcher(`https://api.telegram.org/bot${input.token}/getMe`));
    if (auth.status < 200 || auth.status >= 300 || auth.payload.ok === false) {
      probe.steps.push({
        key: "telegram_token_auth",
        label: "Token auth",
        status: auth.status >= 500 ? "warn" : "fail",
        message: auth.detail ?? `Telegram returned HTTP ${auth.status}.`,
        failureCategory: inferFailureCategory(auth.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "telegram_token_auth",
      label: "Token auth",
      status: "pass",
      message: "Bot token is valid.",
    });
  } catch (error) {
    probe.steps.push({
      key: "telegram_token_auth",
      label: "Token auth",
      status: "warn",
      message: `Probe failed before Telegram responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  if (!input.includeSandboxSend) {
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }
  if (!input.chatId) {
    probe.steps.push({
      key: "telegram_sandbox_send",
      label: "Sandbox send",
      status: "fail",
      message: "Default chat target is missing.",
      failureCategory: "missing_input",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  try {
    const send = await readJsonResponse(await input.fetcher(`https://api.telegram.org/bot${input.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: `[GoatCitadel Telegram probe ${checkedAt}] Channel setup smoke check. Delete me if I remain.`,
      }),
    }));
    if (send.status < 200 || send.status >= 300 || send.payload.ok === false) {
      probe.steps.push({
        key: "telegram_sandbox_send",
        label: "Sandbox send",
        status: send.status >= 500 ? "warn" : "fail",
        message: send.detail ?? `Telegram returned HTTP ${send.status}.`,
        failureCategory: inferFailureCategory(send.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "telegram_sandbox_send",
      label: "Sandbox send",
      status: "pass",
      message: "Sandbox message post succeeded.",
    });
    const messageId = asNumber(send.payload.result && asRecord(send.payload.result).message_id);
    if (!messageId) {
      probe.steps.push({
        key: "telegram_sandbox_cleanup",
        label: "Sandbox cleanup",
        status: "warn",
        message: "Message posted, but Telegram did not return a message id for cleanup.",
        failureCategory: "unknown",
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    const cleanup = await readJsonResponse(await input.fetcher(`https://api.telegram.org/bot${input.token}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: input.chatId,
        message_id: messageId,
      }),
    }));
    if (cleanup.status < 200 || cleanup.status >= 300 || cleanup.payload.ok === false) {
      probe.steps.push({
        key: "telegram_sandbox_cleanup",
        label: "Sandbox cleanup",
        status: cleanup.status === 403 ? "warn" : cleanup.status >= 500 ? "warn" : "fail",
        message: cleanup.detail ?? `Telegram returned HTTP ${cleanup.status} while deleting the sandbox message.`,
        failureCategory: inferFailureCategory(cleanup.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "telegram_sandbox_cleanup",
      label: "Sandbox cleanup",
      status: "pass",
      message: "Sandbox cleanup delete succeeded.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  } catch (error) {
    probe.steps.push({
      key: "telegram_sandbox_send",
      label: "Sandbox send",
      status: "warn",
      message: `Probe failed before Telegram responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }
}

export async function runDiscordBotLiveChecks(input: DiscordProbeInput): Promise<BotProbeChecks> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const probe: ChannelProbeReport = {
    kind: input.runtimeMode === "gateway" ? "discord_gateway" : "discord_bridge",
    mode: input.runtimeMode,
    checkedAt,
    steps: [],
  };

  if (!input.token) {
    probe.steps.push({
      key: "discord_token_auth",
      label: "Token auth",
      status: input.webhookUrl ? "skipped" : "fail",
      message: input.webhookUrl
        ? "Webhook-only bridge path configured, so bot-token auth probe was skipped."
        : "Discord bot token is missing, so auth and channel probes could not run.",
      failureCategory: input.webhookUrl ? undefined : "credential_rejected",
    });
    probe.steps.push({
      key: "discord_channel_access",
      label: "Channel access",
      status: "skipped",
      message: "Channel access probe requires a Discord bot token.",
    });
    if (input.includeSandboxSend) {
      probe.steps.push({
        key: "discord_sandbox_send",
        label: "Sandbox send",
        status: "skipped",
        message: "Sandbox send probe requires a Discord bot token.",
      });
    }
    if (input.runtimeMode === "gateway") {
      probe.steps.push(buildDiscordRuntimeProbeStep(input.runtimeStatus));
    }
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  try {
    const auth = await readJsonResponse(await input.fetcher("https://discord.com/api/v10/users/@me", {
      headers: {
        Authorization: `Bot ${input.token}`,
      },
    }));
    if (auth.status < 200 || auth.status >= 300) {
      probe.steps.push(buildDiscordProbeFailure("discord_token_auth", "Token auth", auth.status));
      if (input.runtimeMode === "gateway") {
        probe.steps.push(buildDiscordRuntimeProbeStep(input.runtimeStatus));
      }
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "discord_token_auth",
      label: "Token auth",
      status: "pass",
      message: "Bot token is valid.",
    });
  } catch (error) {
    probe.steps.push({
      key: "discord_token_auth",
      label: "Token auth",
      status: "warn",
      message: `Probe failed before Discord responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    if (input.runtimeMode === "gateway") {
      probe.steps.push(buildDiscordRuntimeProbeStep(input.runtimeStatus));
    }
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  if (!input.channelId) {
    probe.steps.push({
      key: "discord_channel_access",
      label: "Channel access",
      status: "fail",
      message: "Default channel ID is missing.",
      failureCategory: "destination_mismatch",
    });
    if (input.includeSandboxSend) {
      probe.steps.push({
        key: "discord_sandbox_send",
        label: "Sandbox send",
        status: "fail",
        message: "Default channel ID is missing.",
        failureCategory: "destination_mismatch",
      });
    }
    if (input.runtimeMode === "gateway") {
      probe.steps.push(buildDiscordRuntimeProbeStep(input.runtimeStatus));
    }
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  try {
    const channel = await readJsonResponse(await input.fetcher(
      `https://discord.com/api/v10/channels/${encodeURIComponent(input.channelId)}`,
      {
        headers: {
          Authorization: `Bot ${input.token}`,
        },
      },
    ));
    if (channel.status < 200 || channel.status >= 300) {
      probe.steps.push(buildDiscordProbeFailure("discord_channel_access", "Channel access", channel.status));
      if (input.runtimeMode === "gateway") {
        probe.steps.push(buildDiscordRuntimeProbeStep(input.runtimeStatus));
      }
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "discord_channel_access",
      label: "Channel access",
      status: "pass",
      message: "The configured channel is reachable with the current bot permissions.",
    });
  } catch (error) {
    probe.steps.push({
      key: "discord_channel_access",
      label: "Channel access",
      status: "warn",
      message: `Probe failed before Discord responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    if (input.runtimeMode === "gateway") {
      probe.steps.push(buildDiscordRuntimeProbeStep(input.runtimeStatus));
    }
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  if (input.includeSandboxSend) {
    try {
      const send = await readJsonResponse(await input.fetcher(
        `https://discord.com/api/v10/channels/${encodeURIComponent(input.channelId)}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${input.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: `[GoatCitadel Discord probe ${checkedAt}] Bridge health check. Delete me if I remain.`,
          }),
        },
      ));
      if (send.status < 200 || send.status >= 300) {
        probe.steps.push(buildDiscordProbeFailure("discord_sandbox_send", "Sandbox send", send.status));
        if (input.runtimeMode === "gateway") {
          probe.steps.push(buildDiscordRuntimeProbeStep(input.runtimeStatus));
        }
        return { checks: mapProbeStepsToChecks(probe.steps), probe };
      }

      probe.steps.push({
        key: "discord_sandbox_send",
        label: "Sandbox send",
        status: "pass",
        message: "Sandbox message post succeeded.",
      });

      const messageId = asString(send.payload.id);
      if (!messageId) {
        probe.steps.push({
          key: "discord_sandbox_cleanup",
          label: "Sandbox cleanup",
          status: "warn",
          message: "Message was posted, but Discord did not return a message id for automatic cleanup.",
          failureCategory: "unknown",
        });
        if (input.runtimeMode === "gateway") {
          probe.steps.push(buildDiscordRuntimeProbeStep(input.runtimeStatus));
        }
        return { checks: mapProbeStepsToChecks(probe.steps), probe };
      }

      const cleanup = await readJsonResponse(await input.fetcher(
        `https://discord.com/api/v10/channels/${encodeURIComponent(input.channelId)}/messages/${encodeURIComponent(messageId)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bot ${input.token}`,
          },
        },
      ));
      if (cleanup.status < 200 || cleanup.status >= 300) {
        probe.steps.push({
          key: "discord_sandbox_cleanup",
          label: "Sandbox cleanup",
          status: cleanup.status === 403 ? "warn" : cleanup.status >= 500 ? "warn" : "fail",
          message: `Sandbox message posted successfully, but cleanup delete failed with HTTP ${cleanup.status}.`,
          failureCategory: cleanup.status === 403 ? "permission_mismatch" : inferFailureCategory(cleanup.status),
        });
        if (input.runtimeMode === "gateway") {
          probe.steps.push(buildDiscordRuntimeProbeStep(input.runtimeStatus));
        }
        return { checks: mapProbeStepsToChecks(probe.steps), probe };
      }
      probe.steps.push({
        key: "discord_sandbox_cleanup",
        label: "Sandbox cleanup",
        status: "pass",
        message: "Sandbox cleanup delete succeeded.",
      });
    } catch (error) {
      probe.steps.push({
        key: "discord_sandbox_send",
        label: "Sandbox send",
        status: "warn",
        message: `Probe failed before Discord responded: ${(error as Error).message}`,
        failureCategory: "platform_unavailable",
      });
      if (input.runtimeMode === "gateway") {
        probe.steps.push(buildDiscordRuntimeProbeStep(input.runtimeStatus));
      }
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
  }

  if (input.runtimeMode === "gateway") {
    probe.steps.push(buildDiscordRuntimeProbeStep(input.runtimeStatus));
  }
  return { checks: mapProbeStepsToChecks(probe.steps), probe };
}

function mapProbeStepsToChecks(
  steps: ChannelProbeReport["steps"],
): ConnectorDiagnosticReport["checks"] {
  return steps
    .filter((step) => step.status !== "skipped")
    .map((step) => ({
      key: step.key,
      status: step.status === "pass"
        ? "pass"
        : step.status === "fail"
          ? "fail"
          : "warn",
      message: `${step.label}: ${step.message}`,
    }));
}

async function readJsonResponse(response: Response): Promise<ProbeResponse> {
  const text = await response.text();
  const payload = parseJsonRecord(text);
  return {
    status: response.status,
    detail: readProbeDetail(payload) ?? (text.trim() || undefined),
    payload,
  };
}

function readProbeDetail(payload: Record<string, unknown>): string | undefined {
  for (const candidate of [payload.error, payload.description, payload.message]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function parseJsonRecord(text: string): Record<string, unknown> {
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function inferFailureCategory(statusCode: number): ChannelSetupFailureCategory {
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

function buildDiscordProbeFailure(
  key: string,
  label: string,
  statusCode: number,
): ChannelProbeReport["steps"][number] {
  return {
    key,
    label,
    status: statusCode >= 500 ? "warn" : "fail",
    message: `Discord returned HTTP ${statusCode}.`,
    failureCategory: inferFailureCategory(statusCode),
  };
}

function buildDiscordRuntimeProbeStep(
  runtimeStatus?: Pick<DiscordRuntimeStatus, "ready" | "lastError" | "connectedBotTag">,
): ChannelProbeReport["steps"][number] {
  if (!runtimeStatus) {
    return {
      key: "discord_runtime_ready",
      label: "Gateway runtime",
      status: "fail",
      message: "Gateway runtime is not configured for this connection yet.",
      failureCategory: "bridge_unavailable",
    };
  }
  if (!runtimeStatus.ready) {
    return {
      key: "discord_runtime_ready",
      label: "Gateway runtime",
      status: "warn",
      message: runtimeStatus.lastError?.trim()
        ? `Gateway runtime is not ready: ${runtimeStatus.lastError}`
        : "Gateway runtime has not reached Discord ready state yet.",
      failureCategory: "bridge_unavailable",
    };
  }
  return {
    key: "discord_runtime_ready",
    label: "Gateway runtime",
    status: "pass",
    message: runtimeStatus.connectedBotTag?.trim()
      ? `Gateway runtime is ready as ${runtimeStatus.connectedBotTag}.`
      : "Gateway runtime is ready.",
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
