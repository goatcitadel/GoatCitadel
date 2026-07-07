import type { FastifyInstance } from "fastify";
import type { PersonalityCatalogResponse } from "@goatcitadel/contracts";
import { listPersonalityPresets } from "../services/channel-personalities.js";
import {
  buildChannelPersonalitySystemOverlay,
  handleTelegramChannelCommand,
} from "../services/telegram-channel-commands.js";
import { authorizeTelegramChannelActor } from "../services/telegram-channel-pairing.js";
import {
  applyTelegramChannelSessionRotation,
  resolveTelegramChannelSessionId,
} from "../services/telegram-channel-sessions.js";
import {
  deriveTelegramWebhookIdempotencyKey,
  normalizeTelegramWebhookPayload,
  verifyTelegramWebhookSecretToken,
} from "../services/telegram-webhook.js";
import { resolveTelegramWebhookSecret } from "./integration-webhooks-shared.js";
import {
  CHANNEL_INBOUND_MAX_BYTES,
  createIgnoredWebhookReply,
  createWebhookPreParsing,
  createWebhookHandler,
  dispatchInboundVoiceWebhookMessage,
  dispatchInboundWebhookMessage,
  readHeaderValue,
} from "./webhook-handler-factory.js";

type TelegramDispatchPayload = Exclude<ReturnType<typeof normalizeTelegramWebhookPayload>, { kind: "ignore" }>;

export function registerTelegramWebhookRoutes(fastify: FastifyInstance): void {
  fastify.post(
    "/api/v1/integrations/connections/:connectionId/telegram/webhook",
    {
      bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
      preParsing: createWebhookPreParsing("telegramRawBody"),
      config: {
        rateLimit: {
          max: 500,
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
              fastify.services.integrationWebhooks.updateIntegrationConnection(connectionId, {
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
          const result = await fastify.services.integrationWebhooks.resolveApprovalWithRemoteToken({
            token: approval.token,
            decision: approval.decision,
            resolvedBy: `telegram:${parsed.actorId}`,
          });
          return {
            method: "answerCallbackQuery",
            callback_query_id: parsed.callbackQueryId,
            text:
              approval.decision === "approve"
                ? `Approved ${result.approval.approvalId}.`
                : `Rejected ${result.approval.approvalId}.`,
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
              fastify.services.integrationWebhooks.updateIntegrationConnection(connectionId, {
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
        const command = commandEligible
          ? await handleTelegramChannelCommand({
              connection: {
                connectionId,
                label: connection.label ?? "Telegram",
                enabled: connection.enabled !== false,
                status: connection.status ?? "connected",
                config: connection.config,
              },
              chatId: commandEligible,
              threadId: parsed.threadId,
              actorId: parsed.actorId,
              actorDisplayName: readTelegramMetadataString(parsed.metadata, "actorDisplayName"),
              content: parsed.content,
              personalityCatalog: resolveRoutePersonalityCatalog(fastify),
              isActiveRun: () => {
                const sessionId = resolveTelegramChannelSessionId(connection.config, {
                  account: parsed.account,
                  peer: parsed.peer,
                  room: parsed.room,
                  threadId: parsed.threadId,
                });
                return sessionId ? fastify.services.integrationWebhooks.hasRunningTurn(sessionId) : false;
              },
              runChatCommand: async (commandText) => {
                const sessionId = resolveTelegramChannelSessionId(connection.config, {
                  account: parsed.account,
                  peer: parsed.peer,
                  room: parsed.room,
                  threadId: parsed.threadId,
                });
                if (!sessionId) {
                  return {
                    message:
                      "Channel lookup needs an active Telegram channel session. Send a normal message first or use /new to start one.",
                  };
                }
                const result = await fastify.services.integrationWebhooks.parseChatCommand(sessionId, commandText, {
                  resolvedBy: `telegram:${parsed.actorId}`,
                  source: "channel",
                  channelContext: {
                    platform: "telegram",
                    account: parsed.account,
                    actorId: parsed.actorId,
                  },
                });
                return { message: result.message };
              },
              cancelActiveSession: async () => {
                const sessionId = resolveTelegramChannelSessionId(connection.config, {
                  account: parsed.account,
                  peer: parsed.peer,
                  room: parsed.room,
                  threadId: parsed.threadId,
                });
                if (!sessionId) {
                  return { status: "no_active_run" as const };
                }
                return fastify.services.integrationWebhooks.cancelLatestActiveChatTurnForSession(
                  sessionId,
                  `telegram:${parsed.actorId}`,
                );
              },
              resolveApprovalToken: async (token, decision) => {
                const result = await fastify.services.integrationWebhooks.resolveApprovalWithRemoteToken({
                  token,
                  decision,
                  resolvedBy: `telegram:${parsed.actorId}`,
                });
                return {
                  approvalId: result.approval.approvalId,
                  status: result.approval.status,
                };
              },
            })
          : { handled: false };
        if (command.handled) {
          if (command.configPatch) {
            fastify.services.integrationWebhooks.updateIntegrationConnection(connectionId, {
              config: {
                ...connection.config,
                ...command.configPatch,
              },
              lastSyncAt: new Date().toISOString(),
              lastError: null,
            });
          }
          return (
            command.response ?? {
              accepted: true,
              replied: false,
              eventType: parsed.eventType,
              command: command.command,
            }
          );
        }
        const routedTelegramMessage = applyTelegramChannelSessionRotation(connection.config, {
          peer: parsed.peer,
          room: parsed.room,
          threadId: parsed.threadId,
        });
        const activeSessionId = resolveTelegramChannelSessionId(connection.config, {
          account: parsed.account,
          peer: parsed.peer,
          room: parsed.room,
          threadId: parsed.threadId,
        });
        if (activeSessionId && fastify.services.integrationWebhooks.hasRunningTurn(activeSessionId)) {
          return {
            method: "sendMessage",
            chat_id: target ?? parsed.peer,
            text: "A GoatCitadel run is already active for this chat. Use /status to inspect it or /stop to cancel it before starting another request.",
          };
        }
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
              ? buildChannelPersonalitySystemOverlay(connection.config, target, resolveRoutePersonalityCatalog(fastify))
              : undefined,
          },
        };
        const voiceMedia = parsed.voiceMedia;
        if (voiceMedia) {
          const transcribeChannelVoice = fastify.services.integrationWebhooks.transcribeChannelVoice;
          if (typeof transcribeChannelVoice !== "function") {
            return dispatchInboundWebhookMessage(fastify.services.integrationWebhooks, dispatchOptions);
          }
          // channelVoiceInboundV1Enabled path (voiceMedia only exists when the
          // flag is on): the trust gate runs first inside the voice dispatch,
          // the webhook is acked fast, and download/transcription/ingest run
          // asynchronously. Transcription failure falls back to ingesting the
          // parser placeholder so the message is never silently dropped.
          return dispatchInboundVoiceWebhookMessage(fastify.services.integrationWebhooks, {
            ...dispatchOptions,
            voice: {
              transcribe: () =>
                transcribeChannelVoice({
                  channel: "telegram",
                  connectionConfig: connection.config,
                  fileId: voiceMedia.fileId,
                  mimeType: voiceMedia.mimeType,
                }),
              fallbackContent: parsed.content,
            },
          });
        }
        return dispatchInboundWebhookMessage(fastify.services.integrationWebhooks, dispatchOptions);
      },
    }),
  );
}

function resolveRoutePersonalityCatalog(fastify: FastifyInstance): PersonalityCatalogResponse {
  const settings = (
    fastify.services as {
      settings?: { getPersonalityCatalog?: () => PersonalityCatalogResponse };
    }
  ).settings;
  return settings?.getPersonalityCatalog?.() ?? { items: listPersonalityPresets(), defaultPersonalityId: "default" };
}

function readTelegramMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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
