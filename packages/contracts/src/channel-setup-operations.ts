import type { ChannelCapabilities, ChannelRuntimeStatus } from "./channels.js";
import type { ChannelSetupTestResult } from "./channel-wizard.js";
import type { ChannelSetupEvidence } from "./channel-setup-evidence.js";

export type ChannelSetupDiscoveryInput =
  | { source: "draft"; draftId: string; expectedRevision: number; setupCode?: string }
  | { source: "connection"; connectionId: string; expectedConnectionRevision: string; setupCode?: string };
export interface ChannelSetupDiscoveredTarget {
  id: string;
  label: string;
  chatId: string;
  kind: "private" | "group" | "supergroup" | "channel" | "unknown";
  source: "recent_update" | "connection_config" | "accepted_ingress" | "pending_pairing";
  setupCodeMatched?: boolean;
}
export interface ChannelSetupDiscoveryResult {
  items: ChannelSetupDiscoveredTarget[];
  warnings: string[];
  webhookActive: boolean;
  botIdentity?: { id: string; username?: string; label?: string };
}
export interface TelegramChannelPairingList {
  connectionId: string;
  connectionRevision: string;
  inboundAccessMode: "allowlist" | "open_legacy";
  allowedSenders: string[];
  legacyOpenWarning?: string;
  items: Array<{ actorId: string; status: "pending" | "approved"; code?: string; chatId?: string; displayName?: string; createdAt?: string; expiresAt?: string; approvedAt?: string }>;
}
export interface TelegramChannelPairingApproveInput { code: string; expectedConnectionRevision: string }
export interface TelegramChannelPairingRevokeInput { expectedConnectionRevision: string }
export interface ChannelSetupAcknowledgementInput { expectedRevision: number; evidenceId: string; acknowledgement: "cleanup" | "receipt" }
export type ChannelSetupProofState = "pending" | "verified" | "failed" | "unknown" | "unsupported";
export interface ChannelSetupJourney {
  connectionId: string;
  connectionRevision: string;
  channelKey: string;
  capabilities: ChannelCapabilities;
  runtime: ChannelRuntimeStatus;
  setupEvidence: ChannelSetupEvidence[];
  states: Record<"configuration" | "activation" | "outbound" | "inbound" | "reply", ChannelSetupProofState> & Partial<Record<"credentials" | "destination" | "access" | "transport", ChannelSetupProofState>>;
  latestInbound?: { eventId: string; status: string; acceptedAt: string; sessionId?: string; turnId?: string; durableRunId?: string; deliveryId?: string };
  latestReply?: { deliveryId: string; status: string; providerMessageId?: string; updatedAt: string };
  /** Latest delivery observation, separate from completed first-conversation proof. */
  latestReplyState?: ChannelSetupProofState;
}
export type ChannelSetupAcknowledgementResult = ChannelSetupTestResult;

/** Exact read snapshot. Historical records keep their original tested revision. */
export interface ChannelSetupDraftEvidence {
  draftId: string;
  draftRevision: number;
  items: ChannelSetupEvidence[];
  /** Latest matching fresh proof; Gateway recomputes its eligibility for current requirements. */
  currentTest?: ChannelSetupTestResult;
}
