import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "@goatcitadel/contracts";
import { projectTranscriptMessages, selectTranscriptMessageWindow } from "./chat-transcript-projection.js";

function event(eventId: string, type: TranscriptEvent["type"], payload: TranscriptEvent["payload"]): TranscriptEvent {
  return { eventId, type, sessionId: "session-1", actorType: "user", actorId: "operator-1",
    sourceAuthority: "operator", timestamp: "2026-09-30T00:00:00.000Z", payload };
}

describe("stored transcript message projection", () => {
  it("preserves evidence and canonical parsed content without projecting non-message or malformed records", () => {
    const source = [
      event("user", "message.user", { message: { role: "user", content: "question",
        parts: [{ type: "text", text: "question" }, { type: "unknown" }],
        attachments: [{ attachmentId: "a", fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 3 }] } }),
      { ...event("assistant", "message.assistant", { message: { role: "assistant", content: "answer" } }),
        actorType: "agent" as const, actorId: "agent-1", sourceAuthority: "agent_proposed" as const,
        tokenInput: 12, tokenOutput: 5, costUsd: 0.01 },
      event("tool", "tool.started", { message: { content: "must not appear" } }),
      event("malformed", "message.user", { message: { content: 42 } }),
    ];
    const before = structuredClone(source);
    const projected = projectTranscriptMessages(source);
    expect(projected.map((message) => message.messageId)).toEqual(["user", "assistant"]);
    expect(projected[0]).toMatchObject({ sessionId: "session-1", role: "user", actorId: "operator-1",
      sourceAuthority: "operator", parts: [{ type: "text", text: "question" }],
      attachments: [{ attachmentId: "a", fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 3 }] });
    expect(projected[1]).toMatchObject({ role: "assistant", actorType: "agent", actorId: "agent-1",
      sourceAuthority: "agent_proposed", tokenInput: 12, tokenOutput: 5, costUsd: 0.01 });
    expect(source).toEqual(before);
  });

  it("keeps cursor-exclusive order, unknown-cursor fallback and the bounded tail", () => {
    const source = Array.from({ length: 1005 }, (_, index) =>
      event(`message-${index}`, "message.user", { message: { content: `Content ${index}` } }));
    const ids = (limit: number, cursor?: string) => selectTranscriptMessageWindow(source, limit, cursor)
      .map((message) => message.messageId);
    expect(ids(2, "message-4")).toEqual(["message-2", "message-3"]);
    expect(ids(2, "missing")).toEqual(["message-1003", "message-1004"]);
    expect(ids(0)).toEqual(["message-1004"]);
    expect(ids(2000)).toHaveLength(1000);
    expect(ids(2000)[0]).toBe("message-5");
    expect(ids(10, "message-0")).toEqual([]);
  });
});
