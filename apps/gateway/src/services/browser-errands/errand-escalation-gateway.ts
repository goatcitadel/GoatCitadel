/** Builds the errand escalation from live Gateway pieces, so the errand composition only hands it over. */

import {
  NotFoundError,
  readErrandApprovalSessionId,
  type ChatSessionBindingRecord,
  type ConnectorRecord,
  type DiscordPairingRecord,
  type DurableRunRecord,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../../config.js";
import { buildGatewayConnectorRecords } from "../connector-registry.js";
import { enqueueMobilePushApprovalRefreshNow } from "../mobile-push-service.js";
import {
  deliverErrandApproval,
  type ErrandApprovalConversation,
  type ErrandApprovalDeliveryDeps,
  type ErrandTrackedDelivery,
} from "./errand-approval-delivery.js";
import { connectorDeliveryProviderMessageId } from "./errand-approval-buttons.js";
import { createErrandEscalation, type ErrandEscalate } from "./errand-escalation.js";
import { approvedDiscordActorIds } from "./errand-origin.js";
import { isErrandOwner } from "./errand-owner.js";

const INTEGRATION_CONNECTOR_PREFIX = "integration:";

export interface ErrandEscalationSources {
  /**
   * The live Gateway config; the governed setting `assistant.browserErrands.approvalSessionId` names the PC errands'
   * approval conversation. A settings change replaces its values in place, so each escalation reads the current one.
   */
  config: Pick<GatewayRuntimeConfig, "assistant">;
  storage: AsyncStorage;
  approvals: Pick<ErrandApprovalDeliveryDeps, "createApprovalRemoteActionToken">;
  /** The Gateway's Discord pairing records, for the owner rule on Discord connections; called on `sources`. */
  readDiscordPairings(): Promise<DiscordPairingRecord[]>;
}

/** What the operator's own private conversation lookup reads: the stored bindings and the Discord pairings. */
export type OwnErrandConversationSources = Pick<ErrandEscalationSources, "storage" | "readDiscordPairings">;

/** The operator's own private conversation behind a Chat session, and the name Messaging shows for it. */
export interface OwnErrandConversation {
  conversation: ErrandApprovalConversation;
  title: string;
}

const OWN_CONVERSATION_TITLE_MAX_LENGTH = 80;

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
  if (
    !binding ||
    binding.transport !== "integration" ||
    !binding.writable ||
    !connectionId ||
    !target ||
    !counterpart
  ) {
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

/** The conversation picked for PC errand approvals, from the governed setting; anything but a session id means none. */
export function readPickedErrandApprovalSessionId(config: Pick<GatewayRuntimeConfig, "assistant">): string | undefined {
  return readErrandApprovalSessionId(config.assistant.browserErrands?.approvalSessionId);
}

/**
 * Finds the operator's own private conversation behind a Chat session: a writable channel binding to a direct
 * conversation whose other person passes the errand owner rule. The same lookup answers the Settings check when the
 * conversation is picked and the send when an approval escalates, so the two never disagree.
 */
export function createOwnErrandConversationLookup({
  storage,
  readDiscordPairings,
}: OwnErrandConversationSources): (sessionId: string) => Promise<OwnErrandConversation | undefined> {
  const { chatSessionBindings, chatSessionMeta, integrationConnections, sessions } = storage;
  return async (sessionId) => {
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
    const discordPairings = connection.key === "discord" ? await readDiscordPairings() : [];
    const conversation = ownDirectConversation(binding, connection, channelKey, discordPairings);
    if (!conversation) {
      return undefined;
    }
    const meta = await chatSessionMeta.get(sessionId);
    return { conversation, title: conversationTitle(binding.conversation?.title || meta?.title) };
  };
}

/** Messaging's name for a direct conversation, kept to one short line of printable text. */
function conversationTitle(value: string | undefined): string {
  const printable = [...(value ?? "")]
    .map((character) => (character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f ? " " : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!printable) return "Direct message";
  const characters = [...printable];
  return characters.length > OWN_CONVERSATION_TITLE_MAX_LENGTH
    ? `${characters.slice(0, OWN_CONVERSATION_TITLE_MAX_LENGTH - 1).join("")}…`
    : printable;
}

/**
 * `errandService` is read only when an approval escalates; its `recordDelivery` adds each queued approval to the running
 * errand's delivery list, which text replies answer once its durable connector delivery has completed the send.
 */
export function createGatewayErrandEscalation(
  sources: ErrandEscalationSources,
  errandService: () => { recordDelivery(record: ErrandTrackedDelivery): void },
): ErrandEscalate {
  const { config, storage, approvals } = sources;
  const { approvals: approvalRecords, chatAttachments, integrationConnections, durableRuns } = storage;
  const ownConversation = createOwnErrandConversationLookup(sources);
  const delivery: ErrandApprovalDeliveryDeps = {
    requireConnectorRecord: async (connectorId) =>
      integrationConnectorRecord(connectorId, await integrationConnections.get(connectorIdToConnectionId(connectorId))),
    createApprovalRemoteActionToken: (approvalId, input) =>
      approvals.createApprovalRemoteActionToken(approvalId, input),
    recordDelivery: (record) =>
      errandService().recordDelivery({
        ...record,
        sentAt: () => connectorDeliverySentAt(durableRuns, record.deliveryRunId),
        providerMessageId: () => connectorDeliveryProviderMessageId(durableRuns, record.deliveryRunId),
      }),
    attachmentSessionId: async (attachmentId) => (await chatAttachments.get(attachmentId)).sessionId,
    now: () => Date.now(),
  };
  return createErrandEscalation({
    readApproval: async (approvalId) => await approvalRecords.get(approvalId),
    deliver: (input) => deliverErrandApproval(delivery, input),
    approvalSessionId: () => readPickedErrandApprovalSessionId(config),
    conversationFor: async (sessionId) => (await ownConversation(sessionId))?.conversation,
    pushToPhone: (approvalId) => enqueueMobilePushApprovalRefreshNow(storage, approvalId),
  });
}

/**
 * When the durable connector delivery finished its provider send (epoch ms): only a completed `connector.delivery` run
 * counts. A run that is queued, running, failed or missing reads as undefined.
 */
export async function connectorDeliverySentAt(
  runs: { getRun(runId: string): Promise<DurableRunRecord> },
  runId: string,
): Promise<number | undefined> {
  const run = await runs.getRun(runId).catch((error: unknown) => {
    if (error instanceof NotFoundError) {
      return undefined;
    }
    throw error;
  });
  if (run?.workflowKey !== "connector.delivery" || run.status !== "completed") {
    return undefined;
  }
  const finishedAt = Date.parse(run.finishedAt ?? run.updatedAt);
  return Number.isFinite(finishedAt) ? finishedAt : undefined;
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
