import { Readable } from "node:stream";
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
    expect(files.uploadWorkspaceFile).toHaveBeenCalledWith("notes/upload.md", "hello", { expectAbsent: undefined });
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
    expect(raw.headers["content-disposition"]).toBeUndefined();
    expect(raw.headers["x-content-type-options"]).toBe("nosniff");
    expect(raw.headers["content-security-policy"]).toContain("script-src 'none'");
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

describe("files list paging (LB-08)", () => {
  it("keeps plain listings unchanged and pages only when query, cursor or paged is sent", async () => {
    const page = { items: [{ relativePath: "a.md" }], folders: ["docs"], nextCursor: "1", complete: true };
    const files = {
      listWorkspaceFiles: vi.fn(async () => [{ relativePath: "a.md" }]),
      pageWorkspaceFiles: vi.fn(async () => page),
    };
    const app = buildApp(files);
    try {
      const plain = await app.inject({ method: "GET", url: "/api/v1/files/list?dir=docs&limit=5" });
      expect(plain.json()).toEqual({ items: [{ relativePath: "a.md" }] });
      expect(files.pageWorkspaceFiles).not.toHaveBeenCalled();

      const searched = await app.inject({ method: "GET", url: "/api/v1/files/list?dir=docs&limit=5&query=read" });
      expect(searched.json()).toEqual(page);
      expect(files.pageWorkspaceFiles).toHaveBeenLastCalledWith("docs", 5, { query: "read", cursor: undefined });

      await app.inject({ method: "GET", url: "/api/v1/files/list?paged=1&cursor=5&limit=5" });
      expect(files.pageWorkspaceFiles).toHaveBeenLastCalledWith(".", 5, { query: undefined, cursor: "5" });
      expect(files.listWorkspaceFiles).toHaveBeenCalledTimes(1);

      const tooLong = await app.inject({ method: "GET", url: `/api/v1/files/list?query=${"x".repeat(201)}` });
      expect(tooLong.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("streamed file uploads", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("hands an octet-stream body to the service unread, with its declared length, flag and hash", async () => {
    const seen: Array<{ path: string; text: string; options: unknown }> = [];
    const uploadWorkspaceFileStream = vi.fn(async (path: string, body: AsyncIterable<Buffer>, options: unknown) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk);
      seen.push({ path, text: Buffer.concat(chunks).toString(), options });
      return { relativePath: path, fullPath: path, bytes: 5 };
    });
    app = buildApp({ uploadWorkspaceFileStream, uploadWorkspaceFile: vi.fn() });
    const sha = "A".repeat(64);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/files/upload?relativePath=notes%2Fbig.md&expectAbsent=true",
      headers: { "content-type": "application/octet-stream", "x-content-sha256": sha },
      payload: Buffer.from("hello"),
    });

    expect(response.statusCode).toBe(201);
    expect(seen).toEqual([
      {
        path: "notes/big.md",
        text: "hello",
        options: { declaredBytes: 5, expectAbsent: true, contentSha256: sha.toLowerCase() },
      },
    ]);
  });

  it("refuses a streamed upload without a length or with bad metadata, and caps JSON uploads at 1 MiB", async () => {
    const uploadWorkspaceFileStream = vi.fn();
    const uploadWorkspaceFile = vi.fn(async () => ({ relativePath: "a.md", fullPath: "a.md", bytes: 1 }));
    app = buildApp({ uploadWorkspaceFileStream, uploadWorkspaceFile });
    const stream = { "content-type": "application/octet-stream" };

    const chunked = await app.inject({
      method: "POST",
      url: "/api/v1/files/upload?relativePath=a.md",
      headers: stream,
      payload: Readable.from([Buffer.from("no length")]),
    });
    const noPath = await app.inject({ method: "POST", url: "/api/v1/files/upload", headers: stream, payload: "x" });
    const badHash = await app.inject({
      method: "POST",
      url: "/api/v1/files/upload?relativePath=a.md",
      headers: { ...stream, "x-content-sha256": "not-a-hash" },
      payload: "x",
    });
    const largeJson = await app.inject({
      method: "POST",
      url: "/api/v1/files/upload",
      payload: { relativePath: "a.md", content: "x".repeat(1024 * 1024) },
    });
    const smallJson = await app.inject({
      method: "POST",
      url: "/api/v1/files/upload",
      payload: { relativePath: "a.md", content: "x" },
    });

    expect(chunked.statusCode).toBe(411);
    expect(noPath.statusCode).toBe(400);
    expect(badHash.statusCode).toBe(400);
    expect(largeJson.statusCode).toBe(413);
    expect(smallJson.statusCode).toBe(201);
    expect(uploadWorkspaceFileStream).not.toHaveBeenCalled();
    expect(uploadWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  it("keeps the stream parser to the upload route", async () => {
    app = buildApp({ createWorkspaceFileFromTemplate: vi.fn() });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/files/templates/note/create",
      headers: { "content-type": "application/octet-stream" },
      payload: "x",
    });
    expect(response.statusCode).toBe(415);
  });
});

function buildApp(files: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { files } as never);
  void next.register(filesRoutes);
  return next;
}
