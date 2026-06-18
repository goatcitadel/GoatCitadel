import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerChatAttachmentRoutes } from "./chat.attachments.js";

describe("chat attachment routes", () => {
  let app: FastifyInstance | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("validates uploads and delegates successful attachment creation", async () => {
    const uploadChatAttachment = vi.fn(async (input: unknown) => ({ attachmentId: "attachment-1", input }));
    app = Fastify();
    app.decorate("services", { chatAttachments: { uploadChatAttachment } } as never);
    registerChatAttachmentRoutes(app);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/chat/attachments",
      payload: { sessionId: "", fileName: "", bytesBase64: "" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(uploadChatAttachment).not.toHaveBeenCalled();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/chat/attachments",
      payload: {
        sessionId: "session-1",
        projectId: "project-1",
        fileName: "note.txt",
        bytesBase64: Buffer.from("hello").toString("base64"),
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      attachmentId: "attachment-1",
      input: {
        sessionId: "session-1",
        projectId: "project-1",
        fileName: "note.txt",
        mimeType: "application/octet-stream",
        bytesBase64: Buffer.from("hello").toString("base64"),
      },
    });

    uploadChatAttachment.mockRejectedValueOnce(new Error("upload denied"));
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/chat/attachments",
      payload: {
        sessionId: "session-1",
        fileName: "note.txt",
        bytesBase64: Buffer.from("hello").toString("base64"),
      },
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toEqual({ error: "upload denied" });
  });

  it("reads attachment metadata and content with explicit disposition posture", async () => {
    const getChatAttachment = vi.fn((attachmentId: string) => ({ attachmentId, fileName: "note.txt" }));
    const readChatAttachmentContent = vi.fn(async (attachmentId: string) => ({
      record: { attachmentId, mimeType: "text/plain", fileName: "note with spaces.txt" },
      bytes: Buffer.from("hello"),
    }));
    app = Fastify();
    app.decorate("services", { chatAttachments: { getChatAttachment, readChatAttachmentContent } } as never);
    registerChatAttachmentRoutes(app);

    const metadata = await app.inject({ method: "GET", url: "/api/v1/chat/attachments/attachment-1" });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toEqual({ attachmentId: "attachment-1", fileName: "note.txt" });

    const invalidContent = await app.inject({
      method: "GET",
      url: "/api/v1/chat/attachments/attachment-1/content?disposition=bad",
    });
    expect(invalidContent.statusCode).toBe(400);

    const content = await app.inject({
      method: "GET",
      url: "/api/v1/chat/attachments/attachment-1/content?disposition=inline",
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("application/octet-stream");
    expect(content.headers["content-disposition"]).toBe('attachment; filename="note%20with%20spaces.txt"');
    expect(content.body).toBe("hello");

    getChatAttachment.mockImplementationOnce(() => {
      throw new Error("missing");
    });
    const missingMetadata = await app.inject({ method: "GET", url: "/api/v1/chat/attachments/missing" });
    expect(missingMetadata.statusCode).toBe(404);
    expect(missingMetadata.json()).toEqual({ error: "missing" });

    readChatAttachmentContent.mockRejectedValueOnce(new Error("content missing"));
    const missingContent = await app.inject({ method: "GET", url: "/api/v1/chat/attachments/missing/content" });
    expect(missingContent.statusCode).toBe(404);
    expect(missingContent.json()).toEqual({ error: "content missing" });
  });

  it("streams tokenized inline media with byte ranges and rejects unsafe playback", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-media-route-"));
    const videoBytes = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
      Buffer.from("abcdefghijklmnopqrstuvwxyz"),
    ]);
    const videoPath = path.join(tempDir, "clip.mp4");
    await fs.writeFile(videoPath, videoBytes);
    const resolveChatAttachmentContent = vi.fn(async () => ({
      record: {
        attachmentId: "video-1",
        mimeType: "video/mp4",
        mediaType: "video",
        fileName: "clip.mp4",
      },
      fullPath: videoPath,
      sizeBytes: videoBytes.length,
    }));
    const readChatAttachmentContent = vi.fn();
    const validateMediaPlaybackToken = vi.fn(() => true);
    app = Fastify();
    app.decorate("services", {
      chatAttachments: {
        getChatAttachment: vi.fn(),
        readChatAttachmentContent,
        resolveChatAttachmentContent,
      },
      media: {
        validateMediaPlaybackToken,
      },
    } as never);
    registerChatAttachmentRoutes(app);

    const ranged = await app.inject({
      method: "GET",
      url: "/api/v1/chat/attachments/video-1/content?disposition=inline&media_token=playback-token",
      headers: { range: "bytes=12-15" },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["accept-ranges"]).toBe("bytes");
    expect(ranged.headers["content-range"]).toBe(`bytes 12-15/${videoBytes.length}`);
    expect(ranged.headers["content-type"]).toContain("video/mp4");
    expect(ranged.body).toBe("abcd");
    expect(readChatAttachmentContent).not.toHaveBeenCalled();
    expect(validateMediaPlaybackToken).toHaveBeenCalledWith({
      token: "playback-token",
      source: { kind: "chat_attachment", attachmentId: "video-1" },
      variantId: "original",
    });

    const suffix = await app.inject({
      method: "GET",
      url: "/api/v1/chat/attachments/video-1/content?disposition=inline&media_token=playback-token",
      headers: { range: "bytes=-3" },
    });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.body).toBe("xyz");

    const invalidRange = await app.inject({
      method: "GET",
      url: "/api/v1/chat/attachments/video-1/content?disposition=inline&media_token=playback-token",
      headers: { range: `bytes=${videoBytes.length}-` },
    });
    expect(invalidRange.statusCode).toBe(416);
    expect(invalidRange.headers["content-range"]).toBe(`bytes */${videoBytes.length}`);

    validateMediaPlaybackToken.mockReturnValueOnce(false);
    const invalidToken = await app.inject({
      method: "GET",
      url: "/api/v1/chat/attachments/video-1/content?disposition=inline&media_token=bad-token",
    });
    expect(invalidToken.statusCode).toBe(401);

    const archivePath = path.join(tempDir, "archive-as-video.mp4");
    await fs.writeFile(archivePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    resolveChatAttachmentContent.mockResolvedValueOnce({
      record: {
        attachmentId: "video-1",
        mimeType: "video/mp4",
        mediaType: "video",
        fileName: "archive-as-video.mp4",
      },
      fullPath: archivePath,
      sizeBytes: 6,
    });
    const mismatch = await app.inject({
      method: "GET",
      url: "/api/v1/chat/attachments/video-1/content?disposition=inline&media_token=playback-token",
    });
    expect(mismatch.statusCode).toBe(415);
  });
});
