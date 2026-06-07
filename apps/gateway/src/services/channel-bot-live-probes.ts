/* eslint-disable max-lines -- Live probe coverage stays in one file so probe heuristics and result shaping remain traceable together. */
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

interface MattermostProbeInput {
  serverUrl: string;
  token: string;
  defaultChannel?: string;
  defaultTeam?: string;
  includeSandboxSend: boolean;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  checkedAt?: string;
}

interface WhatsAppProbeInput {
  accessToken: string;
  phoneNumberId: string;
  defaultTarget?: string;
  baseUrl?: string;
  apiVersion?: string;
  includeSandboxSend: boolean;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  checkedAt?: string;
}

interface LineProbeInput {
  channelAccessToken: string;
  defaultTarget?: string;
  includeSandboxSend: boolean;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  checkedAt?: string;
}

interface IMessageProbeInput {
  bridgeUrl: string;
  password: string;
  defaultHandle?: string;
  includeSandboxSend: boolean;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  checkedAt?: string;
}

interface SignalProbeInput {
  baseUrl: string;
  accountId?: string;
  defaultTarget?: string;
  includeSandboxSend: boolean;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  checkedAt?: string;
}

interface ZaloProbeInput {
  accessToken: string;
  defaultTarget?: string;
  includeSandboxSend: boolean;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  checkedAt?: string;
}

interface ZalouserProbeInput {
  baseUrl: string;
  authorizationHeader?: string;
  profile?: string;
  defaultTarget?: string;
  includeSandboxSend: boolean;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  checkedAt?: string;
}

type MattermostProbeTarget =
  | { kind: "channel"; id: string }
  | { kind: "channel-name"; name: string }
  | { kind: "user"; id?: string; username?: string };

export async function runSlackBotLiveChecks(input: SlackProbeInput): Promise<BotProbeChecks> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const probe: ChannelProbeReport = {
    kind: "slack_bot",
    mode: "bot_token",
    checkedAt,
    steps: [],
  };

  try {
    const auth = await readJsonResponse(
      await input.fetcher("https://slack.com/api/auth.test", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
        },
      }),
    );
    if (auth.status < 200 || auth.status >= 300 || auth.payload.ok === false) {
      probe.steps.push({
        key: "slack_token_auth",
        label: "Token auth",
        status: auth.status >= 500 ? "warn" : "fail",
        message: formatSlackProbeDetail(auth.detail) ?? `Slack returned HTTP ${auth.status}.`,
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
    const send = await readJsonResponse(
      await input.fetcher("https://slack.com/api/chat.postMessage", {
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
      }),
    );
    if (send.status < 200 || send.status >= 300 || send.payload.ok === false) {
      probe.steps.push({
        key: "slack_sandbox_send",
        label: "Sandbox send",
        status: send.status >= 500 ? "warn" : "fail",
        message: formatSlackProbeDetail(send.detail) ?? `Slack returned HTTP ${send.status}.`,
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

    const cleanup = await readJsonResponse(
      await input.fetcher("https://slack.com/api/chat.delete", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: channelId,
          ts: messageTs,
        }),
      }),
    );
    if (cleanup.status < 200 || cleanup.status >= 300 || cleanup.payload.ok === false) {
      probe.steps.push({
        key: "slack_sandbox_cleanup",
        label: "Sandbox cleanup",
        status: cleanup.status === 403 ? "warn" : cleanup.status >= 500 ? "warn" : "fail",
        message:
          formatSlackProbeDetail(cleanup.detail) ??
          `Slack returned HTTP ${cleanup.status} while deleting the sandbox message.`,
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
    const send = await readJsonResponse(
      await input.fetcher(`https://api.telegram.org/bot${input.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: input.chatId,
          text: `[GoatCitadel Telegram probe ${checkedAt}] Channel setup smoke check. Delete me if I remain.`,
        }),
      }),
    );
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
    const cleanup = await readJsonResponse(
      await input.fetcher(`https://api.telegram.org/bot${input.token}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: input.chatId,
          message_id: messageId,
        }),
      }),
    );
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
    const auth = await readJsonResponse(
      await input.fetcher("https://discord.com/api/v10/users/@me", {
        headers: {
          Authorization: `Bot ${input.token}`,
        },
      }),
    );
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
    const channel = await readJsonResponse(
      await input.fetcher(`https://discord.com/api/v10/channels/${encodeURIComponent(input.channelId)}`, {
        headers: {
          Authorization: `Bot ${input.token}`,
        },
      }),
    );
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
      const send = await readJsonResponse(
        await input.fetcher(`https://discord.com/api/v10/channels/${encodeURIComponent(input.channelId)}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bot ${input.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: `[GoatCitadel Discord probe ${checkedAt}] Bridge health check. Delete me if I remain.`,
          }),
        }),
      );
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

      const cleanup = await readJsonResponse(
        await input.fetcher(
          `https://discord.com/api/v10/channels/${encodeURIComponent(input.channelId)}/messages/${encodeURIComponent(messageId)}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bot ${input.token}`,
            },
          },
        ),
      );
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

export async function runMattermostBotLiveChecks(input: MattermostProbeInput): Promise<BotProbeChecks> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const probe: ChannelProbeReport = {
    kind: "mattermost_bot",
    mode: "bot_token",
    checkedAt,
    steps: [],
  };

  let botUserId: string | undefined;
  try {
    const auth = await readJsonResponse(
      await input.fetcher(`${input.serverUrl.replace(/\/+$/, "")}/api/v4/users/me`, {
        headers: {
          Authorization: `Bearer ${input.token}`,
        },
      }),
    );
    if (auth.status < 200 || auth.status >= 300) {
      probe.steps.push({
        key: "mattermost_token_auth",
        label: "Token auth",
        status: auth.status >= 500 ? "warn" : "fail",
        message: auth.detail ?? `Mattermost returned HTTP ${auth.status}.`,
        failureCategory: inferFailureCategory(auth.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    botUserId = asString(auth.payload.id);
    probe.steps.push({
      key: "mattermost_token_auth",
      label: "Token auth",
      status: "pass",
      message: "Bot token is valid.",
    });
  } catch (error) {
    probe.steps.push({
      key: "mattermost_token_auth",
      label: "Token auth",
      status: "warn",
      message: `Probe failed before Mattermost responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  if (!input.defaultChannel) {
    probe.steps.push({
      key: "mattermost_channel_access",
      label: "Channel access",
      status: "fail",
      message: "Default channel is missing.",
      failureCategory: "destination_mismatch",
    });
    if (input.includeSandboxSend) {
      probe.steps.push({
        key: "mattermost_sandbox_send",
        label: "Sandbox send",
        status: "fail",
        message: "Default channel is missing.",
        failureCategory: "destination_mismatch",
      });
    }
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  let channelId: string | undefined;
  try {
    channelId = await resolveMattermostProbeChannelId(
      input.serverUrl,
      input.token,
      parseMattermostProbeTarget(input.defaultChannel),
      requiredString(botUserId, "Mattermost bot user id"),
      input.defaultTeam,
      input.fetcher,
    );
    probe.steps.push({
      key: "mattermost_channel_access",
      label: "Channel access",
      status: "pass",
      message: "The configured channel target is reachable with the current bot permissions.",
    });
  } catch (error) {
    probe.steps.push({
      key: "mattermost_channel_access",
      label: "Channel access",
      status: "fail",
      message: (error as Error).message,
      failureCategory: "destination_mismatch",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  if (!input.includeSandboxSend) {
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  try {
    const send = await readJsonResponse(
      await input.fetcher(`${input.serverUrl.replace(/\/+$/, "")}/api/v4/posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel_id: channelId,
          message: `[GoatCitadel Mattermost probe ${checkedAt}] Channel setup smoke check. Delete me if I remain.`,
        }),
      }),
    );
    if (send.status < 200 || send.status >= 300) {
      probe.steps.push({
        key: "mattermost_sandbox_send",
        label: "Sandbox send",
        status: send.status >= 500 ? "warn" : "fail",
        message: send.detail ?? `Mattermost returned HTTP ${send.status}.`,
        failureCategory: inferFailureCategory(send.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "mattermost_sandbox_send",
      label: "Sandbox send",
      status: "pass",
      message: "Sandbox post succeeded.",
    });
    const postId = asString(send.payload.id);
    if (!postId) {
      probe.steps.push({
        key: "mattermost_sandbox_cleanup",
        label: "Sandbox cleanup",
        status: "warn",
        message: "Post was created, but Mattermost did not return a post id for cleanup.",
        failureCategory: "unknown",
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }

    const cleanup = await input.fetcher(
      `${input.serverUrl.replace(/\/+$/, "")}/api/v4/posts/${encodeURIComponent(postId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${input.token}`,
        },
      },
    );
    if (cleanup.status < 200 || cleanup.status >= 300) {
      probe.steps.push({
        key: "mattermost_sandbox_cleanup",
        label: "Sandbox cleanup",
        status: cleanup.status === 403 ? "warn" : cleanup.status >= 500 ? "warn" : "fail",
        message: `Sandbox post succeeded, but cleanup delete failed with HTTP ${cleanup.status}.`,
        failureCategory: cleanup.status === 403 ? "permission_mismatch" : inferFailureCategory(cleanup.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "mattermost_sandbox_cleanup",
      label: "Sandbox cleanup",
      status: "pass",
      message: "Sandbox cleanup delete succeeded.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  } catch (error) {
    probe.steps.push({
      key: "mattermost_sandbox_send",
      label: "Sandbox send",
      status: "warn",
      message: `Probe failed before Mattermost responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }
}

export async function runWhatsAppCloudLiveChecks(input: WhatsAppProbeInput): Promise<BotProbeChecks> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const baseUrl = normalizeWhatsAppProbeBaseUrl(input.baseUrl, input.apiVersion);
  const probe: ChannelProbeReport = {
    kind: "whatsapp_cloud",
    mode: "cloud_api",
    checkedAt,
    steps: [],
  };

  try {
    const authUrl = new URL(`${baseUrl}/${encodeURIComponent(input.phoneNumberId)}`);
    authUrl.searchParams.set("fields", "id,display_phone_number,verified_name");
    const auth = await readJsonResponse(
      await input.fetcher(authUrl.toString(), {
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
        },
      }),
    );
    if (auth.status < 200 || auth.status >= 300) {
      probe.steps.push({
        key: "whatsapp_token_auth",
        label: "Token auth",
        status: auth.status >= 500 ? "warn" : "fail",
        message: auth.detail ?? `WhatsApp returned HTTP ${auth.status}.`,
        failureCategory: inferFailureCategory(auth.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "whatsapp_token_auth",
      label: "Token auth",
      status: "pass",
      message: "Access token and sender phone-number id are valid.",
    });
  } catch (error) {
    probe.steps.push({
      key: "whatsapp_token_auth",
      label: "Token auth",
      status: "warn",
      message: `Probe failed before WhatsApp responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  if (!input.includeSandboxSend) {
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  const recipient = normalizeWhatsAppProbeTarget(input.defaultTarget);
  if (!recipient) {
    probe.steps.push({
      key: "whatsapp_sandbox_send",
      label: "Sandbox send",
      status: "fail",
      message: "Default recipient is missing or not a direct-recipient target.",
      failureCategory: "destination_mismatch",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  try {
    const send = await readJsonResponse(
      await input.fetcher(`${baseUrl}/${encodeURIComponent(input.phoneNumberId)}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: normalizeWhatsAppProbeRecipient(recipient),
          type: "text",
          text: {
            body: `[GoatCitadel WhatsApp probe ${checkedAt}] Channel setup smoke check.`,
          },
        }),
      }),
    );
    if (send.status < 200 || send.status >= 300) {
      probe.steps.push({
        key: "whatsapp_sandbox_send",
        label: "Sandbox send",
        status: send.status >= 500 ? "warn" : "fail",
        message: send.detail ?? `WhatsApp returned HTTP ${send.status}.`,
        failureCategory: inferFailureCategory(send.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "whatsapp_sandbox_send",
      label: "Sandbox send",
      status: "pass",
      message: "Sandbox message post succeeded.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  } catch (error) {
    probe.steps.push({
      key: "whatsapp_sandbox_send",
      label: "Sandbox send",
      status: "warn",
      message: `Probe failed before WhatsApp responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }
}

export async function runLineBotLiveChecks(input: LineProbeInput): Promise<BotProbeChecks> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const probe: ChannelProbeReport = {
    kind: "line_bot",
    mode: "channel_access_token",
    checkedAt,
    steps: [],
  };

  try {
    const auth = await readJsonResponse(
      await input.fetcher("https://api.line.me/v2/bot/info", {
        headers: {
          Authorization: `Bearer ${input.channelAccessToken}`,
        },
      }),
    );
    if (auth.status < 200 || auth.status >= 300) {
      probe.steps.push({
        key: "line_token_auth",
        label: "Token auth",
        status: auth.status >= 500 ? "warn" : "fail",
        message: auth.detail ?? `LINE returned HTTP ${auth.status}.`,
        failureCategory: inferFailureCategory(auth.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "line_token_auth",
      label: "Token auth",
      status: "pass",
      message: "Channel access token is valid.",
    });
  } catch (error) {
    probe.steps.push({
      key: "line_token_auth",
      label: "Token auth",
      status: "warn",
      message: `Probe failed before LINE responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  if (!input.includeSandboxSend) {
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  const target = normalizeLineProbeTarget(input.defaultTarget);
  if (!target) {
    probe.steps.push({
      key: "line_sandbox_send",
      label: "Sandbox send",
      status: "fail",
      message: "Default target is missing.",
      failureCategory: "destination_mismatch",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  try {
    const send = await input.fetcher("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.channelAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: target,
        messages: [
          {
            type: "text",
            text: `[GoatCitadel LINE probe ${checkedAt}] Channel setup smoke check.`,
          },
        ],
      }),
    });
    if (send.status < 200 || send.status >= 300) {
      const failure = await readJsonResponse(send);
      probe.steps.push({
        key: "line_sandbox_send",
        label: "Sandbox send",
        status: send.status >= 500 ? "warn" : "fail",
        message: failure.detail ?? `LINE returned HTTP ${send.status}.`,
        failureCategory: inferFailureCategory(send.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "line_sandbox_send",
      label: "Sandbox send",
      status: "pass",
      message: "Sandbox push request succeeded.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  } catch (error) {
    probe.steps.push({
      key: "line_sandbox_send",
      label: "Sandbox send",
      status: "warn",
      message: `Probe failed before LINE responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }
}

export async function runIMessageBridgeLiveChecks(input: IMessageProbeInput): Promise<BotProbeChecks> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const baseUrl = normalizeBridgeProbeBaseUrl(input.bridgeUrl);
  const probe: ChannelProbeReport = {
    kind: "imessage_bridge",
    mode: "bluebubbles",
    checkedAt,
    steps: [],
  };

  try {
    const auth = await input.fetcher(buildBlueBubblesProbeApiUrl(baseUrl, "/api/v1/chat/query", input.password), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: 1,
        offset: 0,
        with: ["participants"],
      }),
    });
    if (auth.status < 200 || auth.status >= 300) {
      const failure = await readJsonResponse(auth);
      probe.steps.push({
        key: "imessage_bridge_auth",
        label: "Bridge auth",
        status: auth.status >= 500 ? "warn" : "fail",
        message: failure.detail ?? `BlueBubbles returned HTTP ${auth.status}.`,
        failureCategory: inferFailureCategory(auth.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "imessage_bridge_auth",
      label: "Bridge auth",
      status: "pass",
      message: "Bridge query succeeded.",
    });
  } catch (error) {
    probe.steps.push({
      key: "imessage_bridge_auth",
      label: "Bridge auth",
      status: "warn",
      message: `Probe failed before BlueBubbles responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  if (!input.includeSandboxSend) {
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  if (!input.defaultHandle) {
    probe.steps.push({
      key: "imessage_sandbox_send",
      label: "Sandbox send",
      status: "fail",
      message: "Default handle is missing.",
      failureCategory: "destination_mismatch",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  const target = parseIMessageProbeTarget(input.defaultHandle);
  const probeText = `[GoatCitadel iMessage probe ${checkedAt}] Channel setup smoke check.`;
  try {
    const send = await input.fetcher(
      buildBlueBubblesProbeApiUrl(
        baseUrl,
        target.kind === "chat_guid" ? "/api/v1/message/text" : "/api/v1/chat/new",
        input.password,
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          target.kind === "chat_guid"
            ? {
                chatGuid: target.chatGuid,
                message: probeText,
              }
            : {
                addresses: [target.address],
                message: probeText,
              },
        ),
      },
    );
    if (send.status < 200 || send.status >= 300) {
      const failure = await readJsonResponse(send);
      probe.steps.push({
        key: "imessage_sandbox_send",
        label: "Sandbox send",
        status: send.status >= 500 ? "warn" : "fail",
        message: failure.detail ?? `BlueBubbles returned HTTP ${send.status}.`,
        failureCategory: inferFailureCategory(send.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }

    const sendPayload = await readJsonValueResponse(send);
    probe.steps.push({
      key: "imessage_sandbox_send",
      label: "Sandbox send",
      status: "pass",
      message: "Sandbox send succeeded.",
    });
    const messageId = extractBlueBubblesProbeMessageId(sendPayload.payload);
    if (!messageId) {
      probe.steps.push({
        key: "imessage_sandbox_cleanup",
        label: "Sandbox cleanup",
        status: "warn",
        message: "Message was sent, but BlueBubbles did not return a message id for cleanup.",
        failureCategory: "unknown",
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }

    const cleanup = await input.fetcher(
      buildBlueBubblesProbeApiUrl(
        baseUrl,
        `/api/v1/message/${encodeBlueBubblesMessageId(messageId)}/unsend`,
        input.password,
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    if (cleanup.status < 200 || cleanup.status >= 300) {
      const failure = await readJsonResponse(cleanup);
      probe.steps.push({
        key: "imessage_sandbox_cleanup",
        label: "Sandbox cleanup",
        status: cleanup.status === 403 ? "warn" : cleanup.status >= 500 ? "warn" : "fail",
        message: failure.detail ?? `BlueBubbles returned HTTP ${cleanup.status} while unsending the sandbox message.`,
        failureCategory: cleanup.status === 403 ? "permission_mismatch" : inferFailureCategory(cleanup.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "imessage_sandbox_cleanup",
      label: "Sandbox cleanup",
      status: "pass",
      message: "Sandbox cleanup unsend succeeded.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  } catch (error) {
    probe.steps.push({
      key: "imessage_sandbox_send",
      label: "Sandbox send",
      status: "warn",
      message: `Probe failed before BlueBubbles responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }
}

export async function runSignalBridgeLiveChecks(input: SignalProbeInput): Promise<BotProbeChecks> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const baseUrl = normalizeBridgeProbeBaseUrl(input.baseUrl);
  const probe: ChannelProbeReport = {
    kind: "signal_bridge",
    mode: "json_rpc",
    checkedAt,
    steps: [],
  };

  if (!input.includeSandboxSend) {
    probe.steps.push({
      key: "signal_sandbox_send",
      label: "Sandbox send",
      status: "skipped",
      message: "Sandbox send skipped for non-destructive probe mode.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  const target = normalizeSignalProbeTarget(input.defaultTarget);
  if (!target) {
    probe.steps.push({
      key: "signal_sandbox_send",
      label: "Sandbox send",
      status: "fail",
      message: "Default Signal recipient is missing.",
      failureCategory: "missing_input",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  try {
    const send = await readJsonResponse(
      await input.fetcher(`${baseUrl}/api/v1/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "send",
          params: buildSignalProbeParams(
            target,
            input.accountId,
            `[GoatCitadel Signal probe ${checkedAt}] Channel setup smoke check.`,
          ),
          id: randomUUID(),
        }),
      }),
    );
    if (send.status < 200 || send.status >= 300 || asRecord(send.payload).error) {
      probe.steps.push({
        key: "signal_sandbox_send",
        label: "Sandbox send",
        status: send.status >= 500 ? "warn" : "fail",
        message: send.detail ?? `Signal bridge returned HTTP ${send.status}.`,
        failureCategory: inferFailureCategory(send.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "signal_sandbox_send",
      label: "Sandbox send",
      status: "pass",
      message: "Sandbox bridge send succeeded.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  } catch (error) {
    probe.steps.push({
      key: "signal_sandbox_send",
      label: "Sandbox send",
      status: "warn",
      message: `Probe failed before Signal bridge responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }
}

export async function runZaloBotLiveChecks(input: ZaloProbeInput): Promise<BotProbeChecks> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const probe: ChannelProbeReport = {
    kind: "zalo_oa",
    mode: "official_account",
    checkedAt,
    steps: [],
  };

  if (!input.includeSandboxSend) {
    probe.steps.push({
      key: "zalo_sandbox_send",
      label: "Sandbox send",
      status: "skipped",
      message: "Sandbox send skipped for non-destructive probe mode.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  const target = normalizeZaloProbeTarget(input.defaultTarget);
  if (!target) {
    probe.steps.push({
      key: "zalo_sandbox_send",
      label: "Sandbox send",
      status: "fail",
      message: "Default Zalo recipient is missing.",
      failureCategory: "missing_input",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  try {
    const send = await readJsonResponse(
      await input.fetcher("https://openapi.zalo.me/v2.0/oa/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", access_token: input.accessToken },
        body: JSON.stringify({
          recipient: { user_id: target },
          message: { text: `[GoatCitadel Zalo probe ${checkedAt}] Channel setup smoke check.` },
        }),
      }),
    );
    if (send.status < 200 || send.status >= 300 || isZaloApiErrorPayload(send.payload)) {
      probe.steps.push({
        key: "zalo_sandbox_send",
        label: "Sandbox send",
        status: send.status >= 500 ? "warn" : "fail",
        message: send.detail ?? `Zalo returned HTTP ${send.status}.`,
        failureCategory: inferFailureCategory(send.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "zalo_sandbox_send",
      label: "Sandbox send",
      status: "pass",
      message: "Sandbox OA send succeeded.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  } catch (error) {
    probe.steps.push({
      key: "zalo_sandbox_send",
      label: "Sandbox send",
      status: "warn",
      message: `Probe failed before Zalo responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }
}

export async function runZaloUserBridgeLiveChecks(input: ZalouserProbeInput): Promise<BotProbeChecks> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const baseUrl = normalizeBridgeProbeBaseUrl(input.baseUrl);
  const probe: ChannelProbeReport = {
    kind: "zalouser_bridge",
    mode: "zca",
    checkedAt,
    steps: [],
  };

  if (!input.includeSandboxSend) {
    probe.steps.push({
      key: "zalouser_sandbox_send",
      label: "Sandbox send",
      status: "skipped",
      message: "Sandbox send skipped for non-destructive probe mode.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  const target = parseZalouserProbeTarget(input.defaultTarget);
  if (!target) {
    probe.steps.push({
      key: "zalouser_sandbox_send",
      label: "Sandbox send",
      status: "fail",
      message: "Default Zalo User recipient is missing.",
      failureCategory: "missing_input",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  if (input.authorizationHeader) {
    headers.set("Authorization", input.authorizationHeader);
  }
  const profilePrefix = input.profile ? `/${encodeURIComponent(input.profile)}` : "";
  try {
    const send = await readJsonResponse(
      await input.fetcher(`${baseUrl}${profilePrefix}/messages/text`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          threadId: target.threadId,
          message: `[GoatCitadel Zalo User probe ${checkedAt}] Channel setup smoke check.`,
          isGroup: target.isGroup,
        }),
      }),
    );
    if (send.status < 200 || send.status >= 300) {
      probe.steps.push({
        key: "zalouser_sandbox_send",
        label: "Sandbox send",
        status: send.status >= 500 ? "warn" : "fail",
        message: send.detail ?? `Zalo User bridge returned HTTP ${send.status}.`,
        failureCategory: inferFailureCategory(send.status),
      });
      return { checks: mapProbeStepsToChecks(probe.steps), probe };
    }
    probe.steps.push({
      key: "zalouser_sandbox_send",
      label: "Sandbox send",
      status: "pass",
      message: "Sandbox personal-session send succeeded.",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
  } catch (error) {
    probe.steps.push({
      key: "zalouser_sandbox_send",
      label: "Sandbox send",
      status: "warn",
      message: `Probe failed before Zalo User bridge responded: ${(error as Error).message}`,
      failureCategory: "platform_unavailable",
    });
    return { checks: mapProbeStepsToChecks(probe.steps), probe };
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

async function readJsonResponse(response: Response): Promise<ProbeResponse> {
  const text = await response.text();
  const payload = parseJsonRecord(text);
  return {
    status: response.status,
    detail: readProbeDetail(payload) ?? (text.trim() || undefined),
    payload,
  };
}

async function readJsonValueResponse(
  response: Response,
): Promise<{ status: number; detail?: string; payload: unknown }> {
  const text = await response.text();
  const payload = parseJsonValue(text);
  return {
    status: response.status,
    detail: readProbeDetail(payload) ?? (text.trim() || undefined),
    payload,
  };
}

function readProbeDetail(payload: unknown): string | undefined {
  const recordPayload = asRecord(payload);
  for (const candidate of [recordPayload.error, recordPayload.description, recordPayload.message]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  const errorRecord = asRecord(recordPayload.error);
  for (const candidate of [errorRecord.message, errorRecord.error_user_msg, errorRecord.details]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function formatSlackProbeDetail(detail: string | undefined): string | undefined {
  switch (detail) {
    case "not_in_channel":
      return "The Slack app is not in that channel yet. Invite the app to the channel or choose a public channel it can post to.";
    case "channel_not_found":
      return "Slack could not find that channel. Use a channel name like #ops or paste the channel ID.";
    case "missing_scope":
      return "The Slack app is missing a required permission scope. Reconnect Slack so GoatCitadel can request the current scopes.";
    case "invalid_auth":
    case "token_revoked":
      return "Slack rejected the stored bot token. Reconnect Slack to refresh the workspace install.";
    case "is_archived":
      return "That Slack channel is archived. Choose an active channel target.";
    case "no_permission":
    case "restricted_action":
      return "Slack blocked this action for the app. Check workspace app permissions or ask a Slack admin to approve the app.";
    default:
      return detail;
  }
}

function parseJsonRecord(text: string): Record<string, unknown> {
  const payload = parseJsonValue(text);
  return asRecord(payload);
}

function parseZaloErrorCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function isZaloApiErrorPayload(payload: unknown): boolean {
  const body = asRecord(payload);
  const code = parseZaloErrorCode(body.error);
  if (code !== undefined) {
    return code !== 0;
  }
  return body.error !== undefined && body.error !== null && body.error !== "";
}

function parseJsonValue(text: string): unknown {
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
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

function buildDiscordProbeFailure(key: string, label: string, statusCode: number): ChannelProbeReport["steps"][number] {
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
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function requiredString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

function validateWhatsAppBaseUrl(url: string): void {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const isAllowedMetaHost =
      hostname === "graph.facebook.com" ||
      hostname.endsWith(".facebook.com") ||
      hostname === "facebook.com" ||
      hostname.endsWith(".meta.com") ||
      hostname === "meta.com";

    const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

    if (!isAllowedMetaHost && !isLoopback) {
      throw new Error(`WhatsApp outbound URL host "${parsed.hostname}" is not an allowed Meta or localhost domain.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("is not an allowed Meta or localhost domain")) {
      throw error;
    }
    throw new Error(`Invalid WhatsApp baseUrl: ${url}`, { cause: error });
  }
}

function normalizeWhatsAppProbeBaseUrl(baseUrl: string | undefined, apiVersion: string | undefined): string {
  const trimmedBaseUrl = asString(baseUrl);
  let result: string;
  if (trimmedBaseUrl) {
    result = trimmedBaseUrl.replace(/\/+$/, "");
  } else {
    const normalizedVersion = asString(apiVersion) ?? "v23.0";
    result = `https://graph.facebook.com/${normalizedVersion.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  }
  validateWhatsAppBaseUrl(result);
  return result;
}

function normalizeWhatsAppProbeTarget(target: string | undefined): string | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  let candidate = trimmed;
  for (;;) {
    const next = candidate.replace(/^whatsapp:/i, "").trim();
    if (next === candidate) {
      break;
    }
    candidate = next;
  }
  if (!candidate || candidate.includes("@")) {
    return undefined;
  }
  const digits = candidate.replace(/[^\d]/g, "");
  return digits.length >= 2 ? `+${digits}` : undefined;
}

function normalizeWhatsAppProbeRecipient(target: string): string {
  return target.replace(/[^\d]/g, "");
}

function normalizeLineProbeTarget(target: string | undefined): string | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^line:(?:user|group|room):/i, "")
    .replace(/^line:/i, "")
    .trim();
}

function normalizeSignalProbeTarget(target: string | undefined): string | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^signal:/i, "").trim();
}

function buildSignalProbeParams(
  target: string,
  accountId: string | undefined,
  message: string,
): Record<string, unknown> {
  return {
    ...buildSignalProbeTargetParams(target),
    message,
    ...(asString(accountId) ? { account: asString(accountId) } : {}),
  };
}

function buildSignalProbeTargetParams(target: string): Record<string, unknown> {
  const trimmed = target.trim();
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("group:")) {
    return { groupId: trimmed.slice("group:".length).trim() };
  }
  if (lowered.startsWith("username:")) {
    return { username: [trimmed.slice("username:".length).trim()] };
  }
  if (lowered.startsWith("u:")) {
    return { username: [trimmed.slice("u:".length).trim()] };
  }
  return { recipient: [trimmed] };
}

function normalizeZaloProbeTarget(target: string | undefined): string | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^zalo:(?:oa:)?/i, "")
    .replace(/^oa:/i, "")
    .replace(/^chat:/i, "")
    .trim();
}

function normalizeBridgeProbeBaseUrl(baseUrl: string | undefined): string {
  const trimmed = asString(baseUrl);
  if (!trimmed) {
    throw new Error("Bridge URL is missing.");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed}`.replace(/\/+$/, "");
}

function buildBlueBubblesProbeApiUrl(baseUrl: string, path: string, password: string): string {
  const url = new URL(path, `${baseUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("password", password);
  return url.toString();
}

function parseIMessageProbeTarget(
  target: string,
): { kind: "handle"; address: string } | { kind: "chat_guid"; chatGuid: string } {
  const trimmed = target
    .trim()
    .replace(/^bluebubbles:/i, "")
    .trim();
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("chat_guid:") || lowered.startsWith("chatguid:") || lowered.startsWith("guid:")) {
    return {
      kind: "chat_guid",
      chatGuid: trimmed.replace(/^(chat_guid:|chatguid:|guid:)/i, "").trim(),
    };
  }
  let candidate = trimmed;
  for (;;) {
    const next = candidate.replace(/^(imessage:|sms:|auto:)/i, "").trim();
    if (next === candidate) {
      break;
    }
    candidate = next;
  }
  if (candidate.includes("@")) {
    return {
      kind: "handle",
      address: candidate.toLowerCase(),
    };
  }
  return {
    kind: "handle",
    address: candidate.replace(/\s+/g, ""),
  };
}

function extractBlueBubblesProbeMessageId(payload: unknown): string | undefined {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  for (const source of [data, root]) {
    for (const candidate of [source.guid, source.messageGuid, source.message_id, source.messageId, source.id]) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return undefined;
}

function encodeBlueBubblesMessageId(messageId: string): string {
  return messageId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseMattermostProbeTarget(target: string): MattermostProbeTarget {
  const trimmed = target.trim();
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("channel:")) {
    const channelTarget = trimmed.slice("channel:".length).trim();
    if (channelTarget.startsWith("#")) {
      return { kind: "channel-name", name: channelTarget.slice(1).trim() };
    }
    return looksLikeMattermostProbeId(channelTarget)
      ? { kind: "channel", id: channelTarget }
      : { kind: "channel-name", name: channelTarget };
  }
  if (lowered.startsWith("user:")) {
    return { kind: "user", id: trimmed.slice("user:".length).trim() };
  }
  if (lowered.startsWith("mattermost:")) {
    return { kind: "user", id: trimmed.slice("mattermost:".length).trim() };
  }
  if (trimmed.startsWith("@")) {
    return { kind: "user", username: trimmed.slice(1).trim() };
  }
  if (trimmed.startsWith("#")) {
    return { kind: "channel-name", name: trimmed.slice(1).trim() };
  }
  return looksLikeMattermostProbeId(trimmed)
    ? { kind: "channel", id: trimmed }
    : { kind: "channel-name", name: trimmed };
}

function parseZalouserProbeTarget(target: string | undefined): { threadId: string; isGroup: boolean } | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed
    .replace(/^zalouser:/i, "")
    .replace(/^zca:/i, "")
    .trim();
  const lowered = normalized.toLowerCase();
  if (lowered.startsWith("group:")) {
    return {
      threadId: normalized.slice("group:".length).trim(),
      isGroup: true,
    };
  }
  if (lowered.startsWith("user:")) {
    return {
      threadId: normalized.slice("user:".length).trim(),
      isGroup: false,
    };
  }
  return {
    threadId: normalized,
    isGroup: false,
  };
}

function looksLikeMattermostProbeId(value: string): boolean {
  return /^[a-z0-9]{26}$/i.test(value.trim());
}

async function resolveMattermostProbeChannelId(
  serverUrl: string,
  token: string,
  target: MattermostProbeTarget,
  botUserId: string,
  defaultTeam: string | undefined,
  fetcher: MattermostProbeInput["fetcher"],
): Promise<string> {
  if (target.kind === "channel") {
    return target.id;
  }
  if (target.kind === "user") {
    const userId = target.id ?? (await resolveMattermostProbeUserId(serverUrl, token, target.username, fetcher));
    const channel = await mattermostProbeRequest(serverUrl, token, "/channels/direct", fetcher, {
      method: "POST",
      body: JSON.stringify([botUserId, userId]),
    });
    return requiredString(asString(channel.id), "Mattermost DM channel id");
  }

  const teamIds = defaultTeam
    ? [await resolveMattermostProbeTeamId(serverUrl, token, defaultTeam, fetcher)]
    : await resolveMattermostProbeTeamIds(serverUrl, token, botUserId, fetcher);

  for (const teamId of teamIds) {
    try {
      const channel = await mattermostProbeRequest(
        serverUrl,
        token,
        `/teams/${encodeURIComponent(teamId)}/channels/name/${encodeURIComponent(target.name)}`,
        fetcher,
      );
      return requiredString(asString(channel.id), "Mattermost channel id");
    } catch (error) {
      if (error instanceof Error && error.message.includes("(404)")) {
        continue;
      }
      throw error;
    }
  }

  if (teamIds.length === 0) {
    throw new Error("Mattermost bot is not a member of any team.");
  }
  throw new Error(`Mattermost channel "#${target.name}" could not be resolved.`);
}

async function resolveMattermostProbeUserId(
  serverUrl: string,
  token: string,
  username: string | undefined,
  fetcher: MattermostProbeInput["fetcher"],
): Promise<string> {
  const user = await mattermostProbeRequest(
    serverUrl,
    token,
    `/users/username/${encodeURIComponent(requiredString(username, "Mattermost username"))}`,
    fetcher,
  );
  return requiredString(asString(user.id), "Mattermost user id");
}

async function resolveMattermostProbeTeamId(
  serverUrl: string,
  token: string,
  teamName: string,
  fetcher: MattermostProbeInput["fetcher"],
): Promise<string> {
  const team = await mattermostProbeRequest(serverUrl, token, `/teams/name/${encodeURIComponent(teamName)}`, fetcher);
  return requiredString(asString(team.id), "Mattermost team id");
}

async function resolveMattermostProbeTeamIds(
  serverUrl: string,
  token: string,
  botUserId: string,
  fetcher: MattermostProbeInput["fetcher"],
): Promise<string[]> {
  const teams = await mattermostProbeRequestValue(
    serverUrl,
    token,
    `/users/${encodeURIComponent(botUserId)}/teams`,
    fetcher,
  );
  return asRecordArray(teams)
    .map((team) => asString(team.id))
    .filter((teamId): teamId is string => Boolean(teamId));
}

async function mattermostProbeRequest(
  serverUrl: string,
  token: string,
  apiPath: string,
  fetcher: MattermostProbeInput["fetcher"],
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const value = await mattermostProbeRequestValue(serverUrl, token, apiPath, fetcher, init);
  return asRecord(value);
}

async function mattermostProbeRequestValue(
  serverUrl: string,
  token: string,
  apiPath: string,
  fetcher: MattermostProbeInput["fetcher"],
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetcher(`${serverUrl.replace(/\/+$/, "")}/api/v4${apiPath}`, {
    ...init,
    headers,
  });
  const parsed = await readJsonValueResponse(response);
  if (parsed.status < 200 || parsed.status >= 300) {
    throw new Error(`Mattermost returned HTTP ${parsed.status}${parsed.detail ? `: ${parsed.detail}` : ""}`);
  }
  return parsed.payload;
}
