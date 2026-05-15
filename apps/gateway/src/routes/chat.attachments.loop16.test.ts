import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerChatAttachmentRoutes } from "./chat.attachments.js";

describe("chat attachment routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
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
    expect(content.headers["content-type"]).toBe("text/plain");
    expect(content.headers["content-disposition"]).toBe('inline; filename="note%20with%20spaces.txt"');
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
});
