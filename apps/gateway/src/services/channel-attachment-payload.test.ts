import { describe, expect, it, vi } from "vitest";
import { resolveChannelSendAttachments } from "./channel-attachment-payload.js";

describe("resolveChannelSendAttachments", () => {
  it("hydrates uploaded attachment ids into inline comms attachments", async () => {
    const readChatAttachmentContent = vi.fn(async (attachmentId: string) => ({
      record: {
        attachmentId,
        sessionId: "sess-1",
        fileName: "report.png",
        mimeType: "image/png",
        sizeBytes: 4,
        sha256: "sha256",
        storageRelPath: "attachments/report.png",
        extractStatus: "ready" as const,
        createdAt: "2026-03-22T00:00:00.000Z",
      },
      bytes: Buffer.from("test"),
    }));

    const attachments = await resolveChannelSendAttachments(
      {
        attachmentIds: ["11111111-1111-4111-8111-111111111111"],
      },
      {
        readChatAttachmentContent,
      },
    );

    expect(readChatAttachmentContent).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(attachments).toEqual([
      {
        attachmentId: "11111111-1111-4111-8111-111111111111",
        title: "report.png",
        mimeType: "image/png",
        dataBase64: Buffer.from("test").toString("base64"),
      },
    ]);
  });

  it("merges explicit attachments and deduplicates hydrated attachment ids", async () => {
    const readChatAttachmentContent = vi.fn(async (attachmentId: string) => ({
      record: {
        attachmentId,
        sessionId: "sess-1",
        fileName: "inline.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        sha256: "sha256",
        storageRelPath: "attachments/inline.txt",
        extractStatus: "ready" as const,
        createdAt: "2026-03-22T00:00:00.000Z",
      },
      bytes: Buffer.from("hello"),
    }));

    const attachments = await resolveChannelSendAttachments(
      {
        attachments: [
          { url: "https://example.com/runbook", title: "Runbook" },
          { attachmentId: "22222222-2222-4222-8222-222222222222" },
        ],
        attachmentIds: ["22222222-2222-4222-8222-222222222222"],
      },
      {
        readChatAttachmentContent,
      },
    );

    expect(readChatAttachmentContent).toHaveBeenCalledTimes(1);
    expect(attachments).toEqual([
      { url: "https://example.com/runbook", title: "Runbook" },
      {
        attachmentId: "22222222-2222-4222-8222-222222222222",
        title: "inline.txt",
        mimeType: "text/plain",
        dataBase64: Buffer.from("hello").toString("base64"),
      },
    ]);
  });

  it("rejects unsafe external attachment URLs", async () => {
    await expect(
      resolveChannelSendAttachments(
        {
          attachments: [{ url: "file:///etc/passwd", title: "local file" }],
        },
        {
          readChatAttachmentContent: vi.fn(),
        },
      ),
    ).rejects.toThrow("http or https");
  });

  it("rejects oversized inline attachment payloads", async () => {
    const large = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");

    await expect(
      resolveChannelSendAttachments(
        {
          attachments: [{ dataBase64: large, title: "too-large.bin" }],
        },
        {
          readChatAttachmentContent: vi.fn(),
        },
      ),
    ).rejects.toThrow("exceeds");
  });

  it("rejects malformed persisted inline base64 before replay", async () => {
    await expect(
      resolveChannelSendAttachments(
        {
          attachments: [{ dataBase64: "not valid base64!", title: "tampered.bin" }],
        },
        {
          readChatAttachmentContent: vi.fn(),
        },
      ),
    ).rejects.toThrow("base64 alphabet");
  });
});
