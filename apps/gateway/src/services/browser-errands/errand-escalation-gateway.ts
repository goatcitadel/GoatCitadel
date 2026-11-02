/** Builds the errand escalation from live Gateway pieces, so the errand composition only hands it over. */

import type {
  ChatSessionBindingRecord,
  ConnectorRecord,
  DiscordPairingRecord,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { buildGatewayConnectorRecords } from "../connector-registry.js";
import { enqueueMobilePushApprovalRefreshNow } from "../mobile-push-service.js";
import {
  deliverErrandApproval,
  type ErrandApprovalConversation,
  type ErrandApprovalDeliveryDeps,
  type ErrandApprovalDeliveryRecord,
} from "./errand-approval-delivery.js";
import { createErrandEscalation, type ErrandEscalate } from "./errand-escalation.js";
import { approvedDiscordActorIds } from "./errand-origin.js";
import { isErrandOwner } from "./errand-owner.js";

const INTEGRATION_CONNECTOR_PREFIX = "integration:";

export interface ErrandEscalationSources {
  /** The Gateway config; `browserErrands.approvalSessionId` names the PC errands' approval conversation. */
  config: object;
  storage: AsyncStorage;
  approvals: Pick<ErrandApprovalDeliveryDeps, "createApprovalRemoteActionToken">;
  /** The Gateway's Discord pairing records, for the owner rule on Discord connections; called on `sources`. */
  readDiscordPairings(): Promise<DiscordPairingRecord[]>;
}

/**
 * The bound conversation when it is the operator's own direct conversation on the connection: a direct conversation
 * whose other person passes the errand owner rule (marked "This is you" and still let in by the allowlist or an
 * approved pairing). A group, a conversation whose kind was never recorded, or someone else's direct conversation is
 * refused, so a PC errand's approval never goes to anyone but the operator.
 */
export function ownDirectConversation(
  binding: ChatSessionBindingRecord | undefined,
  connection: Pick<IntegrationConnection, "connectionId" | "key" | "config">,
  channelKey: string,
  discordPairings: readonly DiscordPairingRecord[],
): ErrandApprovalConversation | undefined {
  const connectionId = binding?.connectionId?.trim();
  const target = binding?.target?.trim();
  const counterpart = binding?.conversation?.kind === "direct" ? binding.conversation.counterpartActorId?.trim() : "";
  if (!binding || binding.transport !== "integration" || !connectionId || !target || !counterpart) {
    return undefined;
  }
  if (connection.connectionId !== connectionId) {
    return undefined;
  }
  const owner = isErrandOwner({
    channelKey: connection.key,
    config: connection.config,
    actorId: counterpart,
    ...(connection.key === "discord"
      ? { discordApprovedActorIds: approvedDiscordActorIds(discordPairings, connectionId) }
      : {}),
  });
  return owner ? { connectionId, channelKey, target, conversation: "direct" } : undefined;
}

/**
 * The conversation picked for PC errand approvals. Until the governed setting exists it is read from config
 * (`browserErrands.approvalSessionId`); anything but a non-empty string means none.
 */
export function readErrandApprovalSessionId(config: object): string | undefined {
  const section: unknown = (config as { browserErrands?: unknown }).browserErrands;
  const value: unknown =
    section && typeof section === "object" ? (section as { approvalSessionId?: unknown }).approvalSessionId : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * `errandService` is read only when an approval escalates; its `recordDelivery` adds each sent approval to the running
 * errand's delivery list, which text replies answer.
 */
export function createGatewayErrandEscalation(
  sources: ErrandEscalationSources,
  errandService: () => { recordDelivery(record: ErrandApprovalDeliveryRecord): void },
): ErrandEscalate {
  const { config, storage, approvals } = sources;
  const {
    approvals: approvalRecords,
    chatAttachments,
    chatSessionBindings,
    sessions,
    integrationConnections,
  } = storage;
  const delivery: ErrandApprovalDeliveryDeps = {
    requireConnectorRecord: async (connectorId) =>
      integrationConnectorRecord(connectorId, await integrationConnections.get(connectorIdToConnectionId(connectorId))),
    createApprovalRemoteActionToken: (approvalId, input) =>
      approvals.createApprovalRemoteActionToken(approvalId, input),
    recordDelivery: (record) => errandService().recordDelivery(record),
    attachmentSessionId: async (attachmentId) => (await chatAttachments.get(attachmentId)).sessionId,
    now: () => Date.now(),
  };
  return createErrandEscalation({
    readApproval: async (approvalId) => await approvalRecords.get(approvalId),
    deliver: (input) => deliverErrandApproval(delivery, input),
    approvalSessionId: () => readErrandApprovalSessionId(config),
    conversationFor: async (sessionId): Promise<ErrandApprovalConversation | undefined> => {
      const binding = await chatSessionBindings.get(sessionId);
      const connectionId = binding?.connectionId?.trim();
      if (!binding || !connectionId) {
        return undefined;
      }
      const connection = await integrationConnections.get(connectionId);
      const channelKey =
        (await sessions.getBySessionId(sessionId).then(
          (session) => session.channel?.trim(),
          () => undefined,
        )) || connection.key;
      const discordPairings = connection.key === "discord" ? await sources.readDiscordPairings() : [];
      return ownDirectConversation(binding, connection, channelKey, discordPairings);
    },
    pushToPhone: (approvalId) => enqueueMobilePushApprovalRefreshNow(storage, approvalId),
  });
}

function connectorIdToConnectionId(connectorId: string): string {
  if (!connectorId.startsWith(INTEGRATION_CONNECTOR_PREFIX)) {
    throw new Error("Errand approvals go only to integration connections.");
  }
  return connectorId.slice(INTEGRATION_CONNECTOR_PREFIX.length);
}

/** The connection's connector record, built the way the Gateway's connector list builds it. */
function integrationConnectorRecord(
  connectorId: string,
  connection: Parameters<typeof buildGatewayConnectorRecords>[0]["integrationConnections"][number],
): ConnectorRecord {
  const record = buildGatewayConnectorRecords({
    integrationConnections: [connection],
    mcpServers: [],
    mcpTools: [],
  }).find((item) => item.connectorId === connectorId);
  if (!record) {
    throw new Error("The errand approval connection has no connector record.");
  }
  return record;
}
