import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError } from "@goatcitadel/contracts";
import { filesRoutes } from "./files.js";

describe("files routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("rejects invalid upload payloads", async () => {
    app = Fastify();
    app.decorate("gateway", {
      uploadWorkspaceFile: vi.fn(),
    } as never);
    await app.register(filesRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/files/upload",
      payload: { relativePath: "", content: "x" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns download metadata provided by gateway service", async () => {
    app = Fastify();
    app.decorate("gateway", {
      downloadWorkspaceFile: vi.fn(async () => ({
        relativePath: "workspace/test.md",
        fullPath: "./workspace/test.md",
        size: 12,
        modifiedAt: "2026-03-04T18:00:00.000Z",
        contentType: "text/markdown",
        isText: true,
        content: "hello world!",
      })),
    } as never);
    await app.register(filesRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/files/download?relativePath=workspace/test.md",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      relativePath: "workspace/test.md",
      fullPath: "./workspace/test.md",
      encoding: "utf8",
      content: "hello world!",
    });
  });

  it("maps typed gateway download errors to their contract status", async () => {
    app = Fastify();
    app.decorate("gateway", {
      downloadWorkspaceFile: vi.fn(async () => {
        throw new NotFoundError({ entity: "File", id: "workspace/missing.md" });
      }),
    } as never);
    await app.register(filesRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/files/download?relativePath=workspace/missing.md",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: "File workspace/missing.md not found",
      code: "ENTITY_NOT_FOUND",
    });
  });
});
