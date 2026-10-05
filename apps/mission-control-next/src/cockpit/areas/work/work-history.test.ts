import type { ChatSessionRecord, RealtimeEvent } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { projectWorkHistory } from "./work-history";

const conversation = {
  sessionId: "session-a",
  workspaceId: "workspace-a",
  title: "Draft a release note",
  lastActivityAt: "2026-09-28T12:00:00Z",
  updatedAt: "2026-09-28T12:00:00Z",
} as ChatSessionRecord;
const scopedEvent = {
  eventId: "event-a",
  eventType: "approval_created",
  timestamp: "2026-09-28T13:00:00Z",
  links: { workspaceId: "workspace-a", sessionId: "session-a" },
} as RealtimeEvent;

describe("work history", () => {
  it("orders scoped owner links and omits foreign or unbound signals", () => {
    const history = projectWorkHistory(
      [
        conversation,
        { ...conversation, sessionId: "foreign", workspaceId: "workspace-b" },
        { ...conversation, sessionId: "unbound", workspaceId: undefined },
      ],
      [
        scopedEvent,
        { ...scopedEvent, eventId: "foreign", links: { workspaceId: "workspace-b" } },
        { ...scopedEvent, eventId: "unbound", links: undefined },
      ],
      "workspace-a",
    );
    expect(history.omittedUnscopedEvents).toBe(2);
    expect(history.entries.map((entry) => entry.id)).toEqual(["activity:event-a", "conversation:session-a"]);
    expect(history.entries[0]?.href).toContain("sessionId=session-a");
  });
});
