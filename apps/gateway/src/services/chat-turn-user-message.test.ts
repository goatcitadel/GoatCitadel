import { describe, expect, it, vi } from "vitest";
import type { ChatAttachmentRecord, ChatMessageRecord } from "@goatcitadel/contracts";
import {
  buildAttachmentMessageParts,
  buildAttachmentPromptContext,
  buildUserMessageContent,
  buildUserMessagePrompt,
  resolveMessageAttachments,
  type ChatTurnUserMessageDependencies,
} from "./chat-turn-user-message.js";

describe("chat-turn-user-message", () => {
  it("combines base content with text parts without duplicating the first text part", () => {
    expect(buildUserMessagePrompt(createMessage({ content: "Base only" }))).toBe("Base only");
    expect(
      buildUserMessagePrompt(
        createMessage({
          content: "Draft this",
          parts: [
            { type: "text", text: "Draft this" },
            { type: "text", text: "Use a direct tone." },
          ],
        }),
      ),
    ).toBe("Draft this\n\nUse a direct tone.");
    expect(
      buildUserMessagePrompt(
        createMessage({
          content: "System note",
          parts: [{ type: "text", text: "User request" }],
        }),
      ),
    ).toBe("System note\n\nUser request");
  });

  it("resolves unique attachment references from metadata and non-text parts", async () => {
    const deps = createDeps([
      createAttachment({ attachmentId: "file-1", fileName: "notes.txt", mimeType: "text/plain" }),
      createAttachment({ attachmentId: "file-2", fileName: "diagram.png", mimeType: "image/png" }),
    ]);

    expect(
      (
        await resolveMessageAttachments(
          deps,
          createMessage({
            attachments: [
              { attachmentId: "file-1", fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 12 },
              { attachmentId: "file-1", fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 12 },
            ],
            parts: [
              { type: "image_ref", attachmentId: "file-2", mimeType: "image/png" },
              { type: "text", text: "Ignore text parts for attachment lookup." },
            ],
          }),
        )
      ).map((attachment) => attachment.attachmentId),
    ).toEqual(["file-1", "file-2"]);
    expect(deps.storage.chatAttachments.listByIds).toHaveBeenCalledWith(["file-1", "file-2"]);
  });

  it("builds prompt context with previews, unavailable notices, and vision markers", async () => {
    const deps = createDeps([
      createAttachment({
        attachmentId: "file-1",
        fileName: "brief.txt",
        mimeType: "text/plain",
        sizeBytes: 80,
        extractPreview: "Line 1\n\n\nLine 2",
      }),
      createAttachment({
        attachmentId: "file-2",
        fileName: "photo.png",
        mimeType: "image/png",
        sizeBytes: 120,
        extractPreview: "",
      }),
    ]);

    expect(await buildAttachmentPromptContext(deps, [], false)).toBeUndefined();

    const context = await buildAttachmentPromptContext(
      deps,
      [{ attachmentId: "file-1" }, { attachmentId: "file-2" }],
      true,
    );

    expect(context).toContain("Attached file context");
    expect(context).toContain("- brief.txt (text/plain, 80 bytes)");
    expect(context).toContain("Line 1\n\nLine 2");
    expect(context).toContain("Preview: sent directly to a vision-capable model.");
  });

  it("builds direct vision parts only for loadable small image attachments", async () => {
    const deps = createDeps([
      createAttachment({ attachmentId: "image-small", fileName: "small.png", mimeType: "image/png" }),
      createAttachment({ attachmentId: "image-large", fileName: "large.png", mimeType: "image/png" }),
      createAttachment({ attachmentId: "pdf-1", fileName: "brief.pdf", mimeType: "application/pdf" }),
      createAttachment({ attachmentId: "image-missing", fileName: "missing.png", mimeType: "image/png" }),
    ]);
    deps.readChatAttachmentContent = vi.fn(async (attachmentId: string) => {
      if (attachmentId === "image-large") {
        return { bytes: Buffer.alloc(5 * 1024 * 1024 + 1) };
      }
      if (attachmentId === "image-missing") {
        throw new Error("missing blob");
      }
      return { bytes: Buffer.from("png-bytes") };
    });

    const parts = await buildAttachmentMessageParts(
      deps,
      [
        { attachmentId: "image-small" },
        { attachmentId: "image-large" },
        { attachmentId: "pdf-1" },
        { attachmentId: "image-missing" },
      ],
      "Describe the upload.",
      true,
    );

    expect(parts).toEqual([
      { type: "text", text: "Describe the upload." },
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
        },
      },
    ]);
  });

  it("falls back to attachment context when vision parts are unavailable", async () => {
    const deps = createDeps([
      createAttachment({
        attachmentId: "doc-1",
        fileName: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 64,
        extractPreview: "Extracted notes",
      }),
    ]);

    const content = await buildUserMessageContent(
      deps,
      createMessage({
        content: "Summarize this",
        attachments: [{ attachmentId: "doc-1", fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 64 }],
      }),
      false,
    );

    expect(content).toContain("Summarize this");
    expect(content).toContain("Attached file context");
    expect(content).toContain("Extracted notes");
  });
});

function createMessage(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    messageId: "message-1",
    sessionId: "session-1",
    role: "user",
    actorType: "user",
    actorId: "operator",
    content: "",
    timestamp: "2026-05-14T20:00:00.000Z",
    ...overrides,
  };
}

function createAttachment(overrides: Partial<ChatAttachmentRecord>): ChatAttachmentRecord {
  return {
    attachmentId: "attachment-1",
    sessionId: "session-1",
    fileName: "file.txt",
    mimeType: "text/plain",
    sizeBytes: 32,
    sha256: "sha256",
    storageRelPath: "uploads/file.txt",
    extractStatus: "ready",
    createdAt: "2026-05-14T20:00:00.000Z",
    ...overrides,
  };
}

function createDeps(attachments: ChatAttachmentRecord[]): ChatTurnUserMessageDependencies {
  return {
    storage: {
      chatAttachments: {
        listByIds: vi.fn((ids: string[]) =>
          ids
            .map((id) => attachments.find((attachment) => attachment.attachmentId === id))
            .filter((attachment): attachment is ChatAttachmentRecord => Boolean(attachment)),
        ),
      },
    },
    readChatAttachmentContent: vi.fn(async () => ({ bytes: Buffer.from("content") })),
  };
}
