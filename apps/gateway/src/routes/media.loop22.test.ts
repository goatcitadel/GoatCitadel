import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mediaRoutes } from "./media.js";

describe("media route tails", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("preserves media route validation, success, and service failure responses", async () => {
    const media = {
      createMediaJob: vi
        .fn()
        .mockReturnValueOnce({ jobId: "job-1", type: "vision", status: "queued" })
        .mockImplementationOnce(() => {
          throw new Error("create failed");
        }),
      getMediaJob: vi
        .fn()
        .mockReturnValueOnce({ jobId: "job-1", type: "vision", status: "done" })
        .mockImplementationOnce(() => {
          throw new Error("job missing");
        }),
      listMediaJobs: vi.fn(() => [{ jobId: "job-1" }]),
      issueMediaPlaybackToken: vi
        .fn()
        .mockReturnValueOnce({
          token: "playback-token",
          expiresAt: "2026-06-18T00:00:00.000Z",
          source: { kind: "chat_attachment", attachmentId: "att-1" },
          variantId: "original",
          contentPath: "/api/v1/chat/attachments/att-1/content?disposition=inline&media_token=playback-token",
        })
        .mockImplementationOnce(() => {
          throw new Error("not playable");
        }),
      validateMediaPlaybackToken: vi.fn(() => true),
      getChatAttachmentPreview: vi
        .fn()
        .mockReturnValueOnce({ attachmentId: "att-1", preview: "ready" })
        .mockImplementationOnce(() => {
          throw new Error("attachment missing");
        }),
    };
    app = buildApp(media);

    await expect(
      app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { type: "unknown" } }),
    ).resolves.toMatchObject({ statusCode: 400 });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/media/jobs",
      payload: { type: "vision", sessionId: "session-1", input: { prompt: "inspect" } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ jobId: "job-1", type: "vision", status: "queued" });

    const createFailure = await app.inject({
      method: "POST",
      url: "/api/v1/media/jobs",
      payload: { type: "vision" },
    });
    expect(createFailure.statusCode).toBe(400);
    expect(createFailure.json()).toEqual({ error: "create failed" });

    const token = await app.inject({
      method: "POST",
      url: "/api/v1/media/playback-token",
      payload: { source: { kind: "chat_attachment", attachmentId: "att-1" } },
    });
    expect(token.statusCode).toBe(201);
    expect(token.json()).toMatchObject({
      token: "playback-token",
      source: { kind: "chat_attachment", attachmentId: "att-1" },
      variantId: "original",
    });
    expect(media.issueMediaPlaybackToken).toHaveBeenCalledWith({
      source: { kind: "chat_attachment", attachmentId: "att-1" },
    });

    const tokenFailure = await app.inject({
      method: "POST",
      url: "/api/v1/media/playback-token",
      payload: { source: { kind: "chat_attachment", attachmentId: "att-2" } },
    });
    expect(tokenFailure.statusCode).toBe(400);
    expect(tokenFailure.json()).toEqual({ error: "not playable" });

    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/media/playback-token",
        payload: { source: { kind: "chat_attachment" } },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });

    const fetched = await app.inject({ method: "GET", url: "/api/v1/media/jobs/job-1" });
    expect(fetched.json()).toEqual({ jobId: "job-1", type: "vision", status: "done" });

    const missingJob = await app.inject({ method: "GET", url: "/api/v1/media/jobs/job-404" });
    expect(missingJob.statusCode).toBe(404);
    expect(missingJob.json()).toEqual({ error: "job missing" });

    const listed = await app.inject({ method: "GET", url: "/api/v1/media/jobs?sessionId=session-1" });
    expect(listed.json()).toEqual({ items: [{ jobId: "job-1" }] });
    expect(media.listMediaJobs).toHaveBeenCalledWith("session-1");

    const preview = await app.inject({ method: "GET", url: "/api/v1/chat/attachments/att-1/preview" });
    expect(preview.json()).toEqual({ attachmentId: "att-1", preview: "ready" });

    const missingPreview = await app.inject({ method: "GET", url: "/api/v1/chat/attachments/att-404/preview" });
    expect(missingPreview.statusCode).toBe(404);
    expect(missingPreview.json()).toEqual({ error: "attachment missing" });
  });
});

function buildApp(media: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { media } as never);
  void next.register(mediaRoutes);
  return next;
}
