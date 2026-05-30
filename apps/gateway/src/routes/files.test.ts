import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError, PayloadTooLargeError } from "@goatcitadel/contracts";
import { __internal as appInternal } from "../app.js";
import { MAX_HTML_PREVIEW_BYTES, MAX_INLINE_FILE_DOWNLOAD_BYTES } from "../services/files-route-service.js";
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
    app.decorate("services", {
      files: { uploadWorkspaceFile: vi.fn() },
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
    const downloadWorkspaceFile = vi.fn(async () => ({
      relativePath: "workspace/test.md",
      fullPath: "./workspace/test.md",
      size: 12,
      modifiedAt: "2026-03-04T18:00:00.000Z",
      contentType: "text/markdown",
      isText: true,
      content: "hello world!",
    }));
    app = Fastify();
    app.decorate("services", {
      files: {
        downloadWorkspaceFile,
      },
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
    expect(downloadWorkspaceFile).toHaveBeenCalledWith("workspace/test.md", {
      maxBytes: MAX_INLINE_FILE_DOWNLOAD_BYTES,
    });
  });

  it("maps typed gateway download errors to their contract status", async () => {
    app = Fastify();
    app.decorate("services", {
      files: {
        downloadWorkspaceFile: vi.fn(async () => {
          throw new NotFoundError({ entity: "File", id: "workspace/missing.md" });
        }),
      },
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

  it("maps oversized download errors to 413", async () => {
    app = Fastify();
    app.decorate("services", {
      files: {
        downloadWorkspaceFile: vi.fn(async () => {
          throw new PayloadTooLargeError("File is too large to read inline", {
            limitBytes: 4,
            receivedBytes: 10,
          });
        }),
      },
    } as never);
    await app.register(filesRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/files/download?relativePath=workspace/large.bin",
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: "File is too large to read inline",
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("uses the HTML preview cap and tight preview CSP", async () => {
    const downloadWorkspaceFile = vi.fn(async () => ({
      relativePath: "workspace/report.html",
      fullPath: "./workspace/report.html",
      size: 32,
      modifiedAt: "2026-03-04T18:00:00.000Z",
      contentType: "text/html",
      isText: true,
      content: "<h1>Report</h1>",
    }));
    app = Fastify();
    app.decorate("services", {
      files: {
        downloadWorkspaceFile,
      },
    } as never);
    await app.register(filesRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/files/preview?relativePath=workspace/report.html",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("script-src 'none'");
    expect(response.headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(downloadWorkspaceFile).toHaveBeenCalledWith("workspace/report.html", { maxBytes: MAX_HTML_PREVIEW_BYTES });
  });

  // Regression coverage for GWROUTES-001: the global onSend security-headers
  // hook used to unconditionally set a baseline CSP (`script-src 'self'`),
  // clobbering the preview route's hardened sandbox (`script-src 'none'`). This
  // wires the real hook ahead of the route so the production ordering — route
  // sets CSP, then onSend runs — is reproduced.
  it("keeps the preview sandbox CSP after the global security-headers hook runs", async () => {
    const downloadWorkspaceFile = vi.fn(async () => ({
      relativePath: "workspace/report.html",
      fullPath: "./workspace/report.html",
      size: 32,
      modifiedAt: "2026-03-04T18:00:00.000Z",
      contentType: "text/html",
      isText: true,
      content: "<h1>Report</h1>",
    }));
    app = Fastify();
    app.addHook("onSend", async (_request, reply) => {
      appInternal.applyBaselineSecurityHeaders(reply, { isNonLoopbackBind: false });
    });
    app.decorate("services", {
      files: {
        downloadWorkspaceFile,
        listFileTemplates: vi.fn(() => []),
      },
    } as never);
    await app.register(filesRoutes);

    const previewResponse = await app.inject({
      method: "GET",
      url: "/api/v1/files/preview?relativePath=workspace/report.html",
    });

    // The route's hardened CSP survives the global hook.
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.headers["content-security-policy"]).toContain("script-src 'none'");
    expect(previewResponse.headers["content-security-policy"]).not.toContain("script-src 'self'");
    expect(previewResponse.headers["content-security-policy"]).not.toBe(appInternal.BASELINE_CONTENT_SECURITY_POLICY);

    // An ordinary response that does not set its own CSP still receives the baseline.
    const listResponse = await app.inject({ method: "GET", url: "/api/v1/files/templates" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.headers["content-security-policy"]).toBe(appInternal.BASELINE_CONTENT_SECURITY_POLICY);
    expect(listResponse.headers["content-security-policy"]).toContain("script-src 'self'");
  });
});
