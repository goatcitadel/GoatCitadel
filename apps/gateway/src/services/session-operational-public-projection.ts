import {
  redactStructuredSecrets,
  type GatewayEventResult,
  type SessionMeta,
  type SessionSummary,
  type SessionTimelineItem,
  type TranscriptEvent,
} from "@goatcitadel/contracts";

export function projectSessionMetaForPublic(session: SessionMeta): SessionMeta {
  return redactStructuredSecrets(session).value;
}

export function projectTranscriptEventForPublic(event: TranscriptEvent): TranscriptEvent {
  const { payload, ...envelope } = event;
  return {
    ...redactStructuredSecrets(envelope).value,
    payload: isUserAuthoredMessagePayload(event) ? structuredClone(payload) : redactStructuredSecrets(payload).value,
  };
}

export function projectSessionSummaryForPublic<T extends SessionSummary>(summary: T): T {
  return redactStructuredSecrets(summary).value;
}

export function projectSessionTimelineItemForPublic(item: SessionTimelineItem): SessionTimelineItem {
  const { payload, ...envelope } = item;
  return {
    ...redactStructuredSecrets(envelope).value,
    payload: isUserAuthoredMessagePayload(item) ? structuredClone(payload) : redactStructuredSecrets(payload).value,
  };
}

export function projectGatewayEventResultForPublic<T extends GatewayEventResult>(result: T): T {
  return redactStructuredSecrets(result).value;
}

function isUserAuthoredMessagePayload(input: {
  type: TranscriptEvent["type"];
  actorType: TranscriptEvent["actorType"];
  payload: Record<string, unknown>;
}): boolean {
  if (input.type !== "message.user" || input.actorType !== "user") {
    return false;
  }
  const message = input.payload.message;
  return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "user");
}
