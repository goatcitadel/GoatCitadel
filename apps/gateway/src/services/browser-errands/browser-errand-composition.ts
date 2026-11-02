import path from "node:path";
import type {
  ChannelSendInput,
  ChatAttachmentRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  DiscordPairingRecord,
  ModelUsageAttributionContext,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import { launchErrandBrowser } from "@goatcitadel/policy-engine";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../../config.js";
import type { ChatAttachmentUploadInput } from "../chat-attachment-service.js";
import { createUtilityModelUsageAttribution } from "../utility-model-usage-attribution.js";
import { BrowserErrandService } from "./browser-errand-service.js";
import type { ErrandApprovalRuntime } from "./errand-approval-gate.js";
import { createErrandPressGuard } from "./errand-approval-press-guard.js";
import {
  createErrandAwaitsAnswer,
  createErrandReplyHandler,
  type ErrandChannelReplies,
  type ErrandReplyHandlerOptions,
} from "./errand-channel-replies.js";
import { createGatewayErrandChannelNotices } from "./errand-channel-notices-gateway.js";
import { createErrandOriginDeps } from "./errand-origin.js";
import { createGatewayErrandEscalation, type ErrandEscalationSources } from "./errand-escalation-gateway.js";

export const BROWSER_ERRAND_UTILITY_KIND = "browser_errand";

export interface GatewayBrowserErrandInputs {
  config: GatewayRuntimeConfig;
  storage: AsyncStorage;
  /** Also issues the remote-action token an errand approval is sent to a channel conversation with. */
  approvals: ErrandApprovalRuntime & ErrandEscalationSources["approvals"];
  isEnabled(): Promise<boolean>;
  chatCompletions(
    request: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse>;
  uploadAttachment(input: ChatAttachmentUploadInput): Promise<ChatAttachmentRecord>;
  subscribeRealtime(listener: (event: RealtimeEvent) => void): () => void;
  /** The Gateway's Discord pairing records, for the owner rule on Discord connections. */
  readDiscordPairings(): Promise<DiscordPairingRecord[]>;
  /** Sends a channel message as GoatCitadel's own delivery. */
  sendChannelMessage(input: ChannelSendInput & { idempotencyKey?: string }): Promise<unknown>;
}

/** Where the errand browser keeps its own logins, apart from the operator's everyday Chrome. */
export function browserErrandProfileDir(config: Pick<GatewayRuntimeConfig, "rootDir" | "assistant">): string {
  return path.join(path.resolve(config.rootDir, config.assistant.dataDir), "browser-errands", "profile");
}

/** Builds the Gateway's errand service from live Gateway pieces; GatewayService only wires the result. */
export function createGatewayBrowserErrandService(inputs: GatewayBrowserErrandInputs): BrowserErrandService {
  const { config, approvals, sendChannelMessage } = inputs;
  const origin = createErrandOriginDeps(inputs);
  // Read only once an approval escalates, after the service below exists.
  const escalate = createGatewayErrandEscalation(inputs, () => errandService);
  const errandService: BrowserErrandService = new BrowserErrandService({
    isEnabled: () => inputs.isEnabled(),
    deploymentProfile: () => config.assistant.deploymentProfile,
    origin,
    // APPROVE / DENY / STOP replies: the service's own deliveries, the owner rule, the approval runtime, a plain send.
    channelReplies: (service): ErrandChannelReplies => {
      const pendingDeliveryFor: ErrandReplyHandlerOptions["pendingDeliveryFor"] = (connectionId, target, sentAt) =>
        service.pendingDeliveryFor(connectionId, target, sentAt);
      return {
        handle: createErrandReplyHandler({
          pendingDeliveryFor,
          assertOwner: createErrandPressGuard(origin),
          resolveApproval: (approvalId, decision, resolvedBy) =>
            approvals.resolveApproval(approvalId, { decision, resolvedBy }),
          stopErrand: (errandId, actorId) => service.stop(errandId, actorId),
        }),
        awaitsAnswer: createErrandAwaitsAnswer(pendingDeliveryFor),
        // The answer is fixed copy, sent without the channel's markup parsing.
        send: async (input) => void (await sendChannelMessage({ ...input, plainText: true })),
        notices: createGatewayErrandChannelNotices(inputs),
      };
    },
    launchBrowser: (signal) =>
      launchErrandBrowser({
        profileDir: browserErrandProfileDir(config),
        channel: "chrome",
        // Errands browse the public web like Chat's full-web mode; private and LAN addresses stay blocked.
        networkAllowlist: [...config.toolPolicy.sandbox.networkAllowlist, "*"],
        signal,
      }),
    callModel: (request, lineage) =>
      inputs.chatCompletions(
        request,
        createUtilityModelUsageAttribution({
          operationId: lineage.errandId,
          utilityKind: BROWSER_ERRAND_UTILITY_KIND,
          ...(request.providerId ? { requestedProviderId: request.providerId } : {}),
          ...(request.model ? { requestedModelId: request.model } : {}),
          lineage: {
            sessionId: lineage.sessionId,
            turnId: lineage.turnId,
            ...(lineage.workspaceId ? { workspaceId: lineage.workspaceId } : {}),
          },
        }),
      ),
    gate: {
      approvals,
      escalate,
      storage: inputs.storage,
      realtime: { subscribeRealtime: (listener) => inputs.subscribeRealtime(listener) },
      attachments: {
        // The record's sha256 is computed from exactly these bytes as they are stored.
        upload: async (input) => {
          const record = await inputs.uploadAttachment(input);
          return { attachmentId: record.attachmentId, sha256: record.sha256 };
        },
      },
    },
  });
  return errandService;
}
