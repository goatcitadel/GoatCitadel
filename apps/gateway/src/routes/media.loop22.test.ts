import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mediaRoutes } from "./media.js";

describe("media route tails", () => {
  let app: FastifyInstance | null = null;
  const roots: string[] = [];

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    await Promise.all(roots.splice(0).map((rootDir) => fs.rm(rootDir, { recursive: true, force: true })));
  });

  it("preserves media route validation, success, and service failure responses", async () => {
    const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-media-route-"));
    roots.push(mediaRoot);
    const artifactPath = path.join(mediaRoot, "artifact-standard.mp4");
    await fs.writeFile(artifactPath, Buffer.from("0123456789"));
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
      resolveMediaArtifactContent: vi.fn(async () => ({
        artifactId: "artifact-1",
        attachmentId: "att-1",
        mimeType: "video/mp4",
        fullPath: artifactPath,
        sizeBytes: 10,
      })),
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

    const artifactContent = await app.inject({
      method: "GET",
      url: "/api/v1/media/artifacts/artifact-1/content?media_token=artifact-token",
      headers: { range: "bytes=2-5" },
    });
    expect(artifactContent.statusCode).toBe(206);
    expect(artifactContent.headers["content-range"]).toBe("bytes 2-5/10");
    expect(artifactContent.headers["content-type"]).toBe("video/mp4");
    expect(artifactContent.body).toBe("2345");
    expect(media.validateMediaPlaybackToken).toHaveBeenCalledWith({
      token: "artifact-token",
      source: { kind: "media_artifact", artifactId: "artifact-1" },
    });
    expect(media.resolveMediaArtifactContent).toHaveBeenCalledWith("artifact-1");

    media.validateMediaPlaybackToken.mockReturnValueOnce(false);
    const artifactDenied = await app.inject({
      method: "GET",
      url: "/api/v1/media/artifacts/artifact-1/content?media_token=bad-token",
    });
    expect(artifactDenied.statusCode).toBe(401);

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
