import type { FastifyInstance } from "fastify";
import type { PersonalityCatalogResponse } from "@goatcitadel/contracts";
import { listPersonalityPresets } from "../services/channel-personalities.js";
import { normalizeChannelCommandInput } from "../services/channel-command-contract.js";
import { buildChannelPersonalitySystemOverlay } from "../services/telegram-channel-commands.js";
import { authorizeTelegramChannelActor } from "../services/telegram-channel-pairing.js";
import { applyTelegramChannelSessionRotation } from "../services/telegram-channel-sessions.js";
import {
  deriveTelegramWebhookIdempotencyKey,
  normalizeTelegramWebhookPayload,
  verifyTelegramWebhookSecretToken,
} from "../services/telegram-webhook.js";
import {
  TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE,
  TELEGRAM_CHANNEL_COMMAND_EVENT_TYPE,
} from "../services/telegram-inbound-command-service.js";
import { createWebhookRouteOptions, resolveTelegramWebhookSecret } from "./integration-webhooks-shared.js";
import {
  createIgnoredWebhookReply,
  createWebhookHandler,
  dispatchInboundWebhookCommand,
  dispatchInboundVoiceWebhookMessage,
  dispatchInboundWebhookMessage,
  readHeaderValue,
} from "./webhook-handler-factory.js";

type TelegramDispatchPayload = Exclude<ReturnType<typeof normalizeTelegramWebhookPayload>, { kind: "ignore" }>;

export function registerTelegramWebhookRoutes(fastify: FastifyInstance): void {
  const routeOptions = createWebhookRouteOptions("telegramRawBody");
  fastify.post(
    "/api/v1/integrations/connections/:connectionId/telegram/webhook",
    {
      ...routeOptions,
      config: {
        ...routeOptions.config,
        rateLimit: {
          ...routeOptions.config.rateLimit,
          max: routeOptions.config.rateLimit.max,
        },
      },
    },
    createWebhookHandler<TelegramDispatchPayload>(fastify, {
      source: "telegram",
      connectorKey: "telegram",
      connectorLabel: "Telegram",
      rawBodyKey: "telegramRawBody",
      missingRawBodyError: "Missing Telegram raw request body",
      verifySignature: ({ request, connection }) => {
        const webhookSecret = resolveTelegramWebhookSecret(connection.config);
        if (!webhookSecret) {
          return { ok: false as const, statusCode: 400, error: "Telegram connection is missing a webhook secret" };
        }
        const secretTokenHeader = readHeaderValue(request.headers["x-telegram-bot-api-secret-token"]);
        if (!verifyTelegramWebhookSecretToken(secretTokenHeader, webhookSecret)) {
          return { ok: false as const, statusCode: 401, error: "Invalid Telegram webhook secret token" };
        }
        return { ok: true as const };
      },
      parsePayload: ({ connectionId, request }) => {
        const normalized = normalizeTelegramWebhookPayload({
          connectionId,
          payload: request.body,
          voiceInboundEnabled: fastify.services.integrationWebhooks.isVoiceInboundEnabled?.() === true,
        });
        if (normalized.kind === "ignore") {
          return {
            kind: "reply" as const,
            payload: createIgnoredWebhookReply(normalized.eventType, normalized.reason),
          };
        }
        return {
          kind: "dispatch" as const,
          parsed: normalized,
        };
      },
      dispatch: async ({ connectionId, connection, request, rawBody, parsed }) => {
        const target = parsed.room ?? parsed.peer;
        if (parsed.kind === "callback") {
          const approval = parseTelegramApprovalCallback(parsed.content);
          if (!approval) {
            return {
              method: "answerCallbackQuery",
              callback_query_id: parsed.callbackQueryId,
              text: "GoatCitadel did not recognize that channel action.",
            };
          }
          const auth = target
            ? authorizeTelegramChannelActor({
                config: connection.config,
                chatId: target,
                actorId: parsed.actorId,
                actorDisplayName: readTelegramMetadataString(parsed.metadata, "actorDisplayName"),
              })
            : { authorized: false };
          if (!auth.authorized) {
            if (auth.configPatch) {
              await fastify.services.integrationWebhooks.updateIntegrationConnection(connectionId, {
                config: {
                  ...connection.config,
                  ...auth.configPatch,
                },
                lastSyncAt: new Date().toISOString(),
                lastError: null,
              });
            }
            return {
              method: "answerCallbackQuery",
              callback_query_id: parsed.callbackQueryId,
              text: "Approve this Telegram user in GoatCitadel before resolving channel approvals.",
              show_alert: true,
            };
          }
          const approvalActionId = await fastify.services.integrationWebhooks.findRemoteActionTokenId?.(approval.token);
          const callbackIdempotencyKey = deriveTelegramWebhookIdempotencyKey(connectionId, request.body, rawBody);
          const command = await dispatchInboundWebhookCommand(fastify.services.integrationWebhooks, {
            channel: "telegram",
            connectionId,
            idempotencyKey: callbackIdempotencyKey,
            eventType: TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE,
            bindingTarget: target,
            inboundAccessConfig: connection.config,
            message: {
              // The callback query id is an ephemeral provider reply handle.
              // Use the secret-free durable admission identity for settlement.
              eventId: callbackIdempotencyKey,
              account: parsed.account,
              peer: parsed.peer,
              room: parsed.room,
              threadId: parsed.threadId,
              actorId: parsed.actorId,
              actorType: parsed.actorType,
              content: `/${approval.decision}`,
              displayName: readTelegramMetadataString(parsed.metadata, "actorDisplayName"),
              metadata: {
                ...withoutTelegramEphemeralCallbackMetadata(parsed.metadata),
                approvalActionId,
                approvalActionLookupFailed: !approvalActionId,
                approvalDecision: approval.decision,
              },
            },
          });
          const resultText = renderDurableCommandResult(command.result);
          return {
            method: "answerCallbackQuery",
            callback_query_id: parsed.callbackQueryId,
            text: resultText.slice(0, 200),
            show_alert: command.result.status !== "completed",
          };
        }

        if (target) {
          const auth = authorizeTelegramChannelActor({
            config: connection.config,
            chatId: target,
            actorId: parsed.actorId,
            actorDisplayName: readTelegramMetadataString(parsed.metadata, "actorDisplayName"),
          });
          if (!auth.authorized) {
            if (auth.configPatch) {
              await fastify.services.integrationWebhooks.updateIntegrationConnection(connectionId, {
                config: {
                  ...connection.config,
                  ...auth.configPatch,
                },
                lastSyncAt: new Date().toISOString(),
                lastError: null,
              });
            }
            return auth.response ?? createIgnoredWebhookReply(parsed.eventType, "Telegram actor is not paired");
          }
        }

        // Voice messages never participate in channel command handling or
        // approval-token resolution: transcripts are spoofable auto-generated
        // text, and commands require typed text. The voice branch below routes
        // straight to the trust-gated voice dispatch.
        const commandEligible = target && !parsed.voiceMedia ? target : undefined;
        const normalizedCommand = commandEligible
          ? normalizeChannelCommandInput(parsed.content, { platform: "telegram" })
          : undefined;
        if (commandEligible && normalizedCommand?.handled && normalizedCommand.command && normalizedCommand.name) {
          const approvalActionId = normalizedCommand.approvalToken
            ? await fastify.services.integrationWebhooks.findRemoteActionTokenId?.(normalizedCommand.approvalToken)
            : undefined;
          const approvalCommand =
            normalizedCommand.name === "approve" || normalizedCommand.name === "deny"
              ? normalizedCommand.approvalDecision
              : undefined;
          const command = await dispatchInboundWebhookCommand(fastify.services.integrationWebhooks, {
            channel: "telegram",
            connectionId,
            idempotencyKey: deriveTelegramWebhookIdempotencyKey(connectionId, request.body, rawBody),
            eventType: TELEGRAM_CHANNEL_COMMAND_EVENT_TYPE,
            bindingTarget: commandEligible,
            inboundAccessConfig: connection.config,
            message: {
              eventId: parsed.eventId,
              account: parsed.account,
              peer: parsed.peer,
              room: parsed.room,
              threadId: parsed.threadId,
              actorId: parsed.actorId,
              actorType: parsed.actorType,
              content: approvalCommand ? `/${normalizedCommand.name}` : parsed.content,
              displayName: readTelegramMetadataString(parsed.metadata, "actorDisplayName"),
              metadata: {
                ...withoutTelegramEphemeralCallbackMetadata(parsed.metadata),
                approvalActionId,
                approvalActionLookupFailed: Boolean(normalizedCommand.approvalToken && !approvalActionId),
                approvalDecision: approvalCommand,
              },
            },
          });
          return {
            method: "sendMessage",
            chat_id: commandEligible,
            text: renderDurableCommandResult(command.result),
          };
        }
        const routedTelegramMessage = applyTelegramChannelSessionRotation(connection.config, {
          peer: parsed.peer,
          room: parsed.room,
          threadId: parsed.threadId,
        });
        const dispatchOptions = {
          channel: "telegram",
          connectionId,
          idempotencyKey: deriveTelegramWebhookIdempotencyKey(connectionId, request.body, rawBody),
          eventType: parsed.eventType,
          bindingTarget: target,
          inboundAccessConfig: connection.config,
          message: {
            eventId: parsed.eventId,
            account: parsed.account,
            peer: routedTelegramMessage.peer,
            room: routedTelegramMessage.room,
            threadId: routedTelegramMessage.threadId,
            actorId: parsed.actorId,
            actorType: parsed.actorType,
            content: parsed.content,
            metadata: parsed.metadata,
          },
          responseOptions: {
            deliveryReplyToMessageId: parsed.deliveryReplyToMessageId,
            channelSystemInstruction: target
              ? buildChannelPersonalitySystemOverlay(
                  connection.config,
                  target,
                  await resolveRoutePersonalityCatalog(fastify),
                )
              : undefined,
          },
        };
        const voiceMedia = parsed.voiceMedia;
        if (voiceMedia) {
          // Voice media is accepted as a bounded secret-free reference before
          // ACK. Download/transcription/ingest are owned by the durable worker.
          return dispatchInboundVoiceWebhookMessage(fastify.services.integrationWebhooks, {
            ...dispatchOptions,
            voice: {
              request: {
                channel: "telegram",
                connectionConfig: {},
                fileId: voiceMedia.fileId,
                mimeType: voiceMedia.mimeType,
              },
              fallbackContent: parsed.content,
            },
          });
        }
        return dispatchInboundWebhookMessage(fastify.services.integrationWebhooks, dispatchOptions);
      },
    }),
  );
}

async function resolveRoutePersonalityCatalog(fastify: FastifyInstance): Promise<PersonalityCatalogResponse> {
  const settings = (
    fastify.services as {
      settings?: { getPersonalityCatalog?: () => PersonalityCatalogResponse | Promise<PersonalityCatalogResponse> };
    }
  ).settings;
  return (
    (await settings?.getPersonalityCatalog?.()) ?? { items: listPersonalityPresets(), defaultPersonalityId: "default" }
  );
}

function readTelegramMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function withoutTelegramEphemeralCallbackMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const safeMetadata = { ...metadata };
  delete safeMetadata.callbackData;
  delete safeMetadata.callbackQueryId;
  return safeMetadata;
}

function parseTelegramApprovalCallback(data: string): { token: string; decision: "approve" | "reject" } | undefined {
  const match = /^gca:([^:]+):(a|r)$/i.exec(data.trim());
  if (!match) {
    return undefined;
  }
  return {
    token: match[1] ?? "",
    decision: (match[2]?.toLowerCase() === "a" ? "approve" : "reject") as "approve" | "reject",
  };
}

function renderDurableCommandResult(
  result:
    | { status: "completed"; resultText: string }
    | { status: "manual_reconciliation_required" | "failed"; message: string },
): string {
  if (result.status === "completed") {
    return result.resultText;
  }
  if (result.status === "manual_reconciliation_required") {
    return [
      "GoatCitadel retained this command for manual reconciliation because execution may have started.",
      "It was not replayed automatically.",
    ].join(" ");
  }
  return result.message;
}
