export type ChannelParticipantRole = "human" | "bot" | "assistant" | "system" | "unknown";

export interface ChannelParticipantLike {
  readonly id?: string;
  readonly agentProfileId?: string;
  readonly userId?: string;
  readonly connectorType?: string;
  readonly kind?: string;
  readonly role?: string;
}

const BOT_CONNECTOR_RE = /-bot$|^bot-/i;

export function inferChannelParticipantRole(participant: ChannelParticipantLike): ChannelParticipantRole {
  if (participant.agentProfileId) {
    return "assistant";
  }
  if (participant.connectorType && BOT_CONNECTOR_RE.test(participant.connectorType)) {
    return "bot";
  }
  if (participant.userId) {
    return "human";
  }
  if (participant.kind === "system") {
    return "system";
  }
  return "unknown";
}

export function isBotAuthored(role: ChannelParticipantRole): boolean {
  return role === "bot" || role === "assistant";
}
