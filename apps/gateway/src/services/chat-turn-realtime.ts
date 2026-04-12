import type { RealtimeEvent } from "@goatcitadel/contracts";

export function buildChatTurnRealtimeOptions(input: {
  sessionId: string;
  turnId: string;
  runId?: string;
}): Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links"> {
  return {
    eventClass: "domain_fact",
    eventAuthority: "retained_stream",
    links: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId: input.runId,
    },
  };
}
