import { connectEventStream } from "@goatcitadel/mission-control-shared/api/client";
import { ensure, pass, waitFor } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { createScratchSession } from "./context";

type RealtimeEvent = Parameters<Parameters<typeof connectEventStream>[0]>[0];
type RealtimeDelivery = Parameters<Parameters<typeof connectEventStream>[0]>[1];

interface ReceivedEvent {
  readonly event: RealtimeEvent;
  /** True when the event was a catch-up frame sent before the stream reported itself live. */
  readonly replayed: boolean;
}

export const REALTIME_EVENT_TIMEOUT_MS = 15_000;

/**
 * Owned by packages/mission-control-shared/src/api/client.ts. The shared client opens the stream with
 * `afterCursor` read from this key, the key is not scoped per gateway, and the gateway silently drops live
 * events at or below the cursor. A cursor left by an earlier sandbox runtime would therefore hide this
 * check's event forever. Clearing it is safe here: this check is `mutate`, so it only runs against the
 * verified sandbox, whose page origin (the launcher's own Vite port) only ever talks to sandbox gateways,
 * which means the stored cursor can only be a sandbox cursor.
 */
const EVENT_CURSOR_STORAGE_KEY = "goatcitadel.events.cursor.v1";

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
      const received: ReceivedEvent[] = [];
      const disconnect = await ctx.step("Open the event stream", async () => {
        clearStoredEventCursor();
        return connectEventStream((event: RealtimeEvent, delivery: RealtimeDelivery) => {
          received.push({ event, replayed: delivery.replayed });
        });
      });
      try {
        const session = await ctx.step("Create session", () => createScratchSession(ctx, "realtime"));
        const match = await ctx.step("Event arrives", () =>
          waitFor(
            async () => received.find((candidate) => isSessionCreated(candidate.event, session.sessionId)),
            (found) => found !== undefined,
            {
              signal: ctx.signal,
              timeoutMs: REALTIME_EVENT_TIMEOUT_MS,
              intervalMs: 200,
              label: "The chat_session_updated event",
            },
          ),
        );
        ensure(match !== undefined, "The chat_session_updated event was not captured.");
        return pass(`Received ${match.event.eventType} for ${session.sessionId} (sequence ${match.event.sequence}).`, {
          eventType: match.event.eventType,
          sequence: match.event.sequence,
          replayed: match.replayed,
        });
      } finally {
        disconnect();
      }
    },
  },
];

function clearStoredEventCursor(): void {
  try {
    globalThis.localStorage?.removeItem(EVENT_CURSOR_STORAGE_KEY);
  } catch {
    // best-effort: storage can be unavailable (privacy mode); the client then replays from its default window.
  }
}

function isSessionCreated(event: RealtimeEvent, sessionId: string): boolean {
  return (
    event.eventType === "chat_session_updated" &&
    event.payload.type === "chat_session_created" &&
    event.payload.sessionId === sessionId
  );
}
