import { connectEventStream } from "@goatcitadel/mission-control-shared/api/client";
import { pass, waitFor } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { createScratchSession } from "./context";

type RealtimeEvent = Parameters<Parameters<typeof connectEventStream>[0]>[0];

export const REALTIME_EVENT_TIMEOUT_MS = 15_000;

export const realtimeChecks: readonly CheckDef[] = [
  {
    id: "events.session-created",
    kind: "journey",
    domain: "events",
    title: "Session creation reaches the event stream",
    tier: "mutate",
    needsWorkspace: true,
    routes: ["GET /api/v1/events/stream", "POST /api/v1/chat/sessions"],
    steps: ["Open the event stream", "Create session", "Event arrives"],
    async run(ctx) {
      const received: RealtimeEvent[] = [];
      const disconnect = await ctx.step("Open the event stream", async () =>
        connectEventStream((event) => {
          received.push(event);
        }),
      );
      try {
        const session = await ctx.step("Create session", () => createScratchSession(ctx, "realtime"));
        const event = await ctx.step("Event arrives", () =>
          waitFor(
            async () => received.find((candidate) => isSessionCreated(candidate, session.sessionId)),
            (found) => found !== undefined,
            {
              signal: ctx.signal,
              timeoutMs: REALTIME_EVENT_TIMEOUT_MS,
              intervalMs: 200,
              label: "The chat_session_updated event",
            },
          ),
        );
        return pass(`Received ${event?.eventType} for ${session.sessionId} (sequence ${event?.sequence}).`);
      } finally {
        disconnect();
      }
    },
  },
];

function isSessionCreated(event: RealtimeEvent, sessionId: string): boolean {
  return (
    event.eventType === "chat_session_updated" &&
    event.payload.type === "chat_session_created" &&
    event.payload.sessionId === sessionId
  );
}
