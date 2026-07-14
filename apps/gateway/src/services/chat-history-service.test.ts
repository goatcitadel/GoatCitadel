import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { ChatMessageRecord } from "@goatcitadel/contracts";
import type { ChatMessageAnchoredWindow, ChatMessageHistoryContinuationPage } from "@goatcitadel/storage";

import { projectAndCapChatHistoryWindow, projectChatHistoryContinuation } from "./chat-history-service.js";

function message(messageId: string, content: string): ChatMessageRecord {
  return {
    messageId,
    sessionId: "session-1",
    role: "assistant",
    actorType: "agent",
    actorId: "assistant",
    content,
    timestamp: "2026-07-13T00:00:00.000Z",
  };
}

describe("chat history projection and byte caps", () => {
  it("returns continuation cursors from the actual capped window boundaries", () => {
    const raw: ChatMessageAnchoredWindow = {
      anchor: {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        messageId: "m3",
        sequence: 3,
        state: "found",
      },
      items: Array.from({ length: 5 }, (_, index) => ({
        sequence: index + 1,
        message: message(`m${index + 1}`, index === 2 ? "anchor" : "x".repeat(700)),
        isAnchor: index === 2,
      })),
      snapshotMaxSequence: 8,
      hasOlder: true,
      hasNewer: true,
    };

    const projected = projectAndCapChatHistoryWindow(raw, 1_024, (item) => item);

    expect(projected.items.some((entry) => entry.isAnchor)).toBe(true);
    expect(projected.byteLength).toBeLessThanOrEqual(1_024);
    expect(projected.olderCursor).toMatchObject({
      messageId: projected.items[0]?.message.messageId,
      sequence: projected.items[0]?.sequence,
      snapshotMaxSequence: 8,
    });
    expect(projected.newerCursor).toMatchObject({
      messageId: projected.items.at(-1)?.message.messageId,
      sequence: projected.items.at(-1)?.sequence,
      snapshotMaxSequence: 8,
    });
  });

  it("caps continuation pages after projection and advances from the last returned boundary", () => {
    const raw: ChatMessageHistoryContinuationPage = {
      direction: "older",
      cursorState: "valid",
      items: [1, 2, 3].map((sequence) => ({
        sequence,
        message: {
          ...message(`m${sequence}`, "😀".repeat(6_000)),
          parts: [{ type: "text", text: "oversized private structured payload" }],
        },
        isAnchor: false,
      })),
      snapshotMaxSequence: 9,
      hasMore: false,
    };

    const projected = projectChatHistoryContinuation(raw, 2_048, (item) => item);

    expect(projected.items).toHaveLength(1);
    expect(projected.items[0]?.message.messageId).toBe("m3");
    expect(projected.items[0]?.message.parts).toBeUndefined();
    expect(projected.contentTruncated).toBe(true);
    expect(projected.truncated).toBe(true);
    expect(projected.droppedItems).toBe(2);
    expect(projected.hasMore).toBe(true);
    expect(projected.nextCursor).toEqual({ messageId: "m3", sequence: 3, snapshotMaxSequence: 9 });
    expect(projected.byteLength).toBeLessThanOrEqual(2_048);
    expect(Buffer.byteLength(JSON.stringify(projected.items), "utf8")).toBe(projected.byteLength);
    expect(JSON.stringify(projected.items)).not.toContain("�");
  });

  it("strictly caps a multibyte anchor while preserving exact minimal identity", () => {
    const raw: ChatMessageAnchoredWindow = {
      anchor: {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        messageId: "anchor-large",
        sequence: 4,
        state: "found",
      },
      items: [
        {
          sequence: 4,
          message: {
            ...message("anchor-large", `${"😀".repeat(8_000)} Bearer abcdefghijklmnopqrstuvwxyz`),
            actorId: "private-actor",
            parts: [{ type: "text", text: "private part" }],
            attachments: [
              { attachmentId: "private-attachment", fileName: "secret.txt", mimeType: "text/plain", sizeBytes: 10 },
            ],
          },
          isAnchor: true,
        },
      ],
      snapshotMaxSequence: 4,
      hasOlder: false,
      hasNewer: false,
    };
    const projected = projectAndCapChatHistoryWindow(raw, 1_024, (item) => ({
      messageId: item.messageId,
      sessionId: item.sessionId,
      role: item.role,
      content: item.content.replace(/Bearer\s+\S+/, "[REDACTED]"),
      timestamp: item.timestamp,
    }));

    expect(projected.byteLength).toBeLessThanOrEqual(1_024);
    expect(projected.contentTruncated).toBe(true);
    expect(projected.items).toHaveLength(1);
    expect(projected.items[0]).toMatchObject({ sequence: 4, isAnchor: true, message: { messageId: "anchor-large" } });
    expect(Object.keys(projected.items[0]!.message).sort()).toEqual([
      "content",
      "messageId",
      "role",
      "sessionId",
      "timestamp",
    ]);
    expect(JSON.stringify(projected.items)).not.toContain("private-actor");
    expect(JSON.stringify(projected.items)).not.toContain("private-attachment");
    expect(JSON.stringify(projected.items)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(projected.items)).not.toContain("�");
  });

  it("fails closed when an anchored legacy identity cannot fit the minimum byte budget", () => {
    const oversizedMessageId = "m".repeat(1_500);
    const raw: ChatMessageAnchoredWindow = {
      anchor: {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        messageId: oversizedMessageId,
        sequence: 1,
        state: "found",
      },
      items: [
        {
          sequence: 1,
          message: message(oversizedMessageId, "legacy content"),
          isAnchor: true,
        },
      ],
      snapshotMaxSequence: 1,
      hasOlder: false,
      hasNewer: false,
    };

    expect(() => projectAndCapChatHistoryWindow(raw, 1_024, (item) => item)).toThrow(
      /identity metadata exceeds maxBytes/,
    );
  });

  it("fails closed when a continuation boundary identity cannot fit the minimum byte budget", () => {
    const oversizedMessageId = "m".repeat(1_500);
    const raw: ChatMessageHistoryContinuationPage = {
      direction: "newer",
      cursorState: "valid",
      items: [
        {
          sequence: 2,
          message: message(oversizedMessageId, "legacy content"),
          isAnchor: false,
        },
      ],
      snapshotMaxSequence: 2,
      hasMore: false,
    };

    expect(() => projectChatHistoryContinuation(raw, 1_024, (item) => item)).toThrow(
      /identity metadata exceeds maxBytes/,
    );
  });

  it("caps a multibyte continuation at the exact 1024-byte minimum without splitting a surrogate pair", () => {
    const raw: ChatMessageHistoryContinuationPage = {
      direction: "newer",
      cursorState: "valid",
      items: [
        {
          sequence: 2,
          message: message("message-2", "😀".repeat(8_000)),
          isAnchor: false,
        },
      ],
      snapshotMaxSequence: 2,
      hasMore: false,
    };

    const projected = projectChatHistoryContinuation(raw, 1_024, (item) => item);

    expect(projected.items).toHaveLength(1);
    expect(projected.contentTruncated).toBe(true);
    expect(projected.byteLength).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(JSON.stringify(projected.items), "utf8")).toBe(projected.byteLength);
    expect(JSON.stringify(projected.items)).not.toContain("�");
  });
});
