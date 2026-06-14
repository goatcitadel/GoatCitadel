import { createHash } from "node:crypto";
import type { SessionKind, SessionRouteInput } from "@goatcitadel/contracts";

export interface SessionRouteResolution {
  kind: SessionKind;
  sessionKey: string;
  sessionId: string;
}

export function resolveSessionRoute(input: SessionRouteInput): SessionRouteResolution {
  if (!input.channel || !input.account) {
    throw new Error("route.channel and route.account are required");
  }

  const channel = normalizeSegment(input.channel);
  const account = normalizeSegment(input.account);

  if (input.threadId) {
    if (!input.room) {
      throw new Error("route.room is required when route.threadId is provided");
    }
    const room = normalizeSegment(input.room);
    const threadId = normalizeSegment(input.threadId);
    const sessionKey = `${channel}:${account}:${room}:${threadId}`;
    return {
      kind: "thread",
      sessionKey,
      sessionId: deriveSessionId(sessionKey),
    };
  }

  if (input.room) {
    const room = normalizeSegment(input.room);
    const sessionKey = `${channel}:${account}:${room}`;
    return {
      kind: "group",
      sessionKey,
      sessionId: deriveSessionId(sessionKey),
    };
  }

  if (!input.peer) {
    throw new Error("route.peer is required for DM sessions");
  }

  const peer = normalizeSegment(input.peer);
  const sessionKey = `${channel}:${account}:${peer}`;
  return {
    kind: "dm",
    sessionKey,
    sessionId: deriveSessionId(sessionKey),
  };
}

function deriveSessionId(sessionKey: string): string {
  const hash = createHash("sha256").update(sessionKey).digest("hex");
  return `sess_${hash.slice(0, 24)}`;
}

function normalizeSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("session key segments cannot be empty");
  }
  // `:` is the session-key field separator, so it must not appear raw inside a
  // segment. The previous collapse `":" -> "_"` was lossy: distinct peers/rooms
  // such as `a:b` and `a_b` mapped to the same segment, colliding into one
  // session and cross-wiring transcripts. Percent-encode instead — encoding `%`
  // first keeps the transform reversible (no two inputs share an output).
  return trimmed.replaceAll("%", "%25").replaceAll(":", "%3A");
}