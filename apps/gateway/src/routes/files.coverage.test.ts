import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { filesRoutes } from "./files.js";

describe("files routes additional coverage", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("lists templates, creates template files, lists files, suggests paths, and uploads content", async () => {
    const files = {
      listFileTemplates: vi.fn(() => [{ templateId: "note" }]),
      createWorkspaceFileFromTemplate: vi.fn(async () => ({ relativePath: "notes/new.md" })),
      listWorkspaceFiles: vi.fn(async () => [{ relativePath: "notes/new.md" }]),
      listWorkspacePathSuggestions: vi.fn(async () => [{ relativePath: "notes" }]),
      uploadWorkspaceFile: vi.fn(async () => ({ relativePath: "notes/upload.md", size: 5 })),
    };
    app = buildApp(files);

    await expect(app.inject({ method: "GET", url: "/api/v1/files/templates" })).resolves.toMatchObject({
      statusCode: 200,
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/files/templates/note/create",
      payload: { targetPath: "notes/new.md" },
    });
    const listed = await app.inject({ method: "GET", url: "/api/v1/files/list?dir=notes&limit=5" });
    const suggestions = await app.inject({ method: "GET", url: "/api/v1/files/path-suggestions?root=notes&limit=3" });
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/v1/files/upload",
      payload: { relativePath: "notes/upload.md", content: "hello" },
    });

    expect(created.statusCode).toBe(201);
    expect(listed.json()).toEqual({ items: [{ relativePath: "notes/new.md" }] });
    expect(suggestions.json()).toEqual({ items: [{ relativePath: "notes" }] });
    expect(uploaded.statusCode).toBe(201);
    expect(files.createWorkspaceFileFromTemplate).toHaveBeenCalledWith("note", "notes/new.md");
    expect(files.listWorkspaceFiles).toHaveBeenCalledWith("notes", 5);
    expect(files.listWorkspacePathSuggestions).toHaveBeenCalledWith("notes", 3);
    expect(files.uploadWorkspaceFile).toHaveBeenCalledWith("notes/upload.md", "hello");
  });

  it("returns binary downloads as base64 metadata and raw downloads with source content type", async () => {
    const downloadWorkspaceFile = vi
      .fn()
      .mockResolvedValueOnce({
        relativePath: "assets/logo.bin",
        fullPath: "F:/code/personal-ai/workspace/assets/logo.bin",
        size: 3,
        modifiedAt: "2026-05-14T00:00:00.000Z",
        contentType: "application/octet-stream",
        isText: false,
        content: Buffer.from([1, 2, 3]),
      })
      .mockResolvedValueOnce({
        relativePath: "notes/raw.txt",
        fullPath: "F:/code/personal-ai/workspace/notes/raw.txt",
        size: 4,
        modifiedAt: "2026-05-14T00:00:00.000Z",
        contentType: "text/plain",
        isText: true,
        content: "raw!",
      });
    app = buildApp({ downloadWorkspaceFile });

    const binary = await app.inject({ method: "GET", url: "/api/v1/files/download?relativePath=assets/logo.bin" });
    const raw = await app.inject({ method: "GET", url: "/api/v1/files/download?relativePath=notes/raw.txt&raw=true" });

    expect(binary.statusCode).toBe(200);
    expect(binary.json()).toMatchObject({
      relativePath: "assets/logo.bin",
      encoding: "base64",
      content: Buffer.from([1, 2, 3]).toString("base64"),
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers["content-type"]).toContain("text/plain");
    expect(raw.headers["content-length"]).toBe("4");
    expect(raw.body).toBe("raw!");
  });

  it("validates query/body shapes and maps service failures without changing route responses", async () => {
    const files = {
      createWorkspaceFileFromTemplate: vi.fn(async () => {
        throw new Error("template missing");
      }),
      listWorkspaceFiles: vi.fn(async () => {
        throw new Error("list failed");
      }),
      listWorkspacePathSuggestions: vi.fn(async () => {
        throw new Error("suggest failed");
      }),
      uploadWorkspaceFile: vi.fn(async () => {
        throw new Error("upload failed");
      }),
      downloadWorkspaceFile: vi.fn(async () => ({
        relativePath: "pages/index.html",
        fullPath: "F:/code/personal-ai/workspace/pages/index.html",
        size: 1,
        modifiedAt: "2026-05-14T00:00:00.000Z",
        contentType: "application/octet-stream",
        isText: false,
        content: Buffer.from([1]),
      })),
    };
    app = buildApp(files);

    await expect(
      app.inject({ method: "POST", url: "/api/v1/files/templates//create", payload: {} }),
    ).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/files/templates/note/create", payload: { targetPath: "" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/files/templates/note/create", payload: { targetPath: "x.md" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "GET", url: "/api/v1/files/list?limit=0" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/files/list?dir=notes" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/files/path-suggestions?limit=0" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/files/path-suggestions?root=notes" }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/files/upload",
        payload: { relativePath: "notes/upload.md", content: "hello" },
      }),
    ).resolves.toMatchObject({ statusCode: 500 });
    await expect(app.inject({ method: "GET", url: "/api/v1/files/download" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/files/preview" })).resolves.toMatchObject({
      statusCode: 400,
    });
    const nonHtmlPreview = await app.inject({
      method: "GET",
      url: "/api/v1/files/preview?relativePath=notes/readme.md",
    });
    expect(nonHtmlPreview.statusCode).toBe(400);
    expect(nonHtmlPreview.json()).toEqual({ error: "Only HTML files can be previewed" });

    const binaryPreview = await app.inject({
      method: "GET",
      url: "/api/v1/files/preview?relativePath=pages/index.html",
    });
    expect(binaryPreview.statusCode).toBe(400);
    expect(binaryPreview.json()).toEqual({ error: "Preview supports text HTML files only" });
  });
});

function buildApp(files: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { files } as never);
  void next.register(filesRoutes);
  return next;
}
