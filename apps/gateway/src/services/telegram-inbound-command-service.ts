import type { IntegrationConnectionUpdateInput, PersonalityCatalogResponse } from "@goatcitadel/contracts";
import { normalizeChannelCommandInput } from "./channel-command-contract.js";
import type { InboundChannelCommandExecutionInput } from "./inbound-channel-event-service.js";
import { handleTelegramChannelCommand } from "./telegram-channel-commands.js";
import { resolveTelegramChannelSessionId } from "./telegram-channel-sessions.js";

export const TELEGRAM_CHANNEL_COMMAND_EVENT_TYPE = "telegram-channel-command";
export const TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE = "telegram-approval-callback";

export interface TelegramInboundCommandHost {
  storage: {
    integrationConnections: {
      get(connectionId: string): Promise<{
        connectionId: string;
        label: string;
        enabled: boolean;
        status: "connected" | "disconnected" | "error" | "paused";
        config: Record<string, unknown>;
      }>;
      update(connectionId: string, input: IntegrationConnectionUpdateInput): Promise<unknown>;
    };
  };
  getPersonalityCatalog(): Promise<PersonalityCatalogResponse>;
  hasRunningTurn(sessionId: string): Promise<boolean>;
  parseChatCommand(
    sessionId: string,
    commandText: string,
    options: {
      resolvedBy: string;
      source: "channel";
      channelContext: { platform: "telegram"; account: string; actorId: string };
    },
  ): Promise<{ message: string }>;
  cancelLatestActiveChatTurnForSession(
    sessionId: string,
    cancelledBy: string,
  ): Promise<{
    status: "cancelled" | "no_active_run" | "failed";
    sessionId?: string;
    turnId?: string;
    durableRunId?: string;
    durableCancelled?: boolean;
    error?: string;
  }>;
  resolveApprovalWithRemoteTokenId(input: {
    tokenId: string;
    connectorId: string;
    decision: "approve" | "reject";
    resolvedBy: string;
  }): Promise<{ approval: { approvalId: string; status: string } }>;
}

export async function executeTelegramInboundCommand(
  host: TelegramInboundCommandHost,
  input: InboundChannelCommandExecutionInput,
): Promise<{ resultText: string }> {
  if (
    input.channel !== "telegram" ||
    (input.eventType !== TELEGRAM_CHANNEL_COMMAND_EVENT_TYPE &&
      input.eventType !== TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE)
  ) {
    throw new Error(`Unsupported Telegram durable command event: ${input.channel}:${input.eventType}`);
  }
  if (input.operationKey !== input.idempotencyKey) {
    throw new Error("Durable Telegram command operation identity does not match its acceptance identity.");
  }
  const target = input.bindingTarget ?? input.message.room ?? input.message.peer;
  if (!target) {
    throw new Error("Telegram durable command is missing its chat target.");
  }
  const approvalDecision = readApprovalDecision(input.message.metadata?.approvalDecision);
  const approvalActionId = readString(input.message.metadata?.approvalActionId);
  const approvalLookupFailed = input.message.metadata?.approvalActionLookupFailed === true;
  if (input.eventType === TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE || approvalDecision) {
    if (approvalLookupFailed) {
      return { resultText: "GoatCitadel could not match that approval action. It may be expired or already used." };
    }
    if (!approvalDecision || !approvalActionId) {
      return { resultText: "Use an approval action issued by GoatCitadel for this Telegram connection." };
    }
    const normalizedApproval = normalizeChannelCommandInput(input.message.content, { platform: "telegram" });
    if (normalizedApproval.approvalDecision !== approvalDecision || normalizedApproval.approvalToken) {
      throw new Error("Durable Telegram approval command does not match its secret-free command metadata.");
    }
    const result = await host.resolveApprovalWithRemoteTokenId({
      tokenId: approvalActionId,
      connectorId: `integration:${input.connectionId}`,
      decision: approvalDecision,
      resolvedBy: `telegram:${input.message.actorId}`,
    });
    return {
      resultText:
        approvalDecision === "approve"
          ? `Approved ${result.approval.approvalId}. GoatCitadel will resume any waiting work it can safely resume.`
          : `Rejected ${result.approval.approvalId}. GoatCitadel will keep the requested action blocked.`,
    };
  }

  const connection = await host.storage.integrationConnections.get(input.connectionId);
  const resolveSessionId = () =>
    resolveTelegramChannelSessionId(connection.config, {
      account: input.message.account,
      peer: input.message.peer,
      room: input.message.room,
      threadId: input.message.threadId,
    });
  const result = await handleTelegramChannelCommand({
    connection,
    chatId: target,
    threadId: input.message.threadId,
    actorId: input.message.actorId,
    actorDisplayName: input.message.displayName,
    content: input.message.content,
    personalityCatalog: await host.getPersonalityCatalog(),
    isActiveRun: async () => {
      const sessionId = resolveSessionId();
      return sessionId ? await host.hasRunningTurn(sessionId) : false;
    },
    runChatCommand: async (commandText) => {
      const sessionId = resolveSessionId();
      if (!sessionId) {
        return {
          message:
            "Channel lookup needs an active Telegram channel session. Send a normal message first or use /new to start one.",
        };
      }
      return host.parseChatCommand(sessionId, commandText, {
        resolvedBy: `telegram:${input.message.actorId}`,
        source: "channel",
        channelContext: {
          platform: "telegram",
          account: input.message.account,
          actorId: input.message.actorId,
        },
      });
    },
    cancelActiveSession: async () => {
      const sessionId = resolveSessionId();
      if (!sessionId) {
        return { status: "no_active_run" as const };
      }
      return host.cancelLatestActiveChatTurnForSession(sessionId, `telegram:${input.message.actorId}`);
    },
  });
  if (!result.handled) {
    return { resultText: "Command is not available on this Telegram route." };
  }
  if (result.configPatch) {
    await host.storage.integrationConnections.update(input.connectionId, {
      config: { ...connection.config, ...result.configPatch },
      lastSyncAt: new Date().toISOString(),
      lastError: null,
    });
  }
  return { resultText: result.response?.text ?? `Accepted ${result.command ?? "Telegram command"}.` };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readApprovalDecision(value: unknown): "approve" | "reject" | undefined {
  return value === "approve" || value === "reject" ? value : undefined;
}
