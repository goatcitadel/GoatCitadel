import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatAttachmentRecord, ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { ConflictError } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayRuntimeConfig } from "../config.js";
import {
  listChatArtifactRenders,
  renderChatGeneratedArtifact,
  type HtmlArtifactRenderDependencies,
} from "./html-artifact-render-service.js";

const now = "2026-10-12T10:00:00.000Z";
const CONTENT_HASH = "0123456789abcdef".repeat(4);
const HASH16 = CONTENT_HASH.slice(0, 16);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function artifactFixture(overrides: Partial<ChatGeneratedArtifactRecord> = {}): ChatGeneratedArtifactRecord {
  return {
    artifactId: "artifact-1",
    sessionId: "sess-1",
    workspaceId: "default",
    projectId: "project-1",
    turnId: "turn-1",
    title: "Landing page",
    kind: "html",
    content: "<!doctype html><html><head><title>Landing</title></head><body><h1>Hi</h1></body></html>",
    sourceSurface: "chat",
    version: 1,
    contentHash: CONTENT_HASH,
    createdAt: now,
    ...overrides,
  };
}

async function createDeps(artifact: ChatGeneratedArtifactRecord = artifactFixture()) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-html-render-"));
  const workspaceRoot = path.join(rootDir, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const uploads: ChatAttachmentRecord[] = [];
  const outputDirs: string[] = [];
  const renderHtmlSnapshot = vi.fn(async (input: { html: string; outputDir: string; writeJailRoots: string[] }) => {
    outputDirs.push(input.outputDir);
    await mkdir(input.outputDir, { recursive: true });
    const renders = [];
    for (const viewport of [
      { name: "desktop", width: 1440, height: 900 },
      { name: "phone", width: 390, height: 844 },
    ]) {
      const filePath = path.join(input.outputDir, `render-${viewport.name}.png`);
      const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from(viewport.name)]);
      await writeFile(filePath, bytes);
      renders.push({
        viewport: viewport.name,
        width: viewport.width,
        height: viewport.height,
        path: filePath,
        sha256: `sha-${viewport.name}`,
        bytes: bytes.byteLength,
        title: "Landing",
        blockedRequests: [],
      });
    }
    return { renders, contentSecurityPolicy: "default-src 'self'" };
  });
  const uploadChatAttachment = vi.fn(
    async (input: {
      sessionId: string;
      projectId?: string;
      fileName: string;
      mimeType: string;
      bytesBase64: string;
    }) => {
      const record: ChatAttachmentRecord = {
        attachmentId: `att-${uploads.length + 1}`,
        sessionId: input.sessionId,
        workspaceId: "default",
        projectId: input.projectId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        mediaType: "image",
        sizeBytes: Buffer.from(input.bytesBase64, "base64").byteLength,
        sha256: `sha-${input.fileName}`,
        storageRelPath: `chat/default/attachments/${input.fileName}`,
        extractStatus: "unsupported",
        analysisStatus: "skipped",
        createdAt: now,
      };
      uploads.push(record);
      return record;
    },
  );
  const deps: HtmlArtifactRenderDependencies = {
    config: {
      rootDir,
      assistant: { workspaceDir: "workspace" },
      toolPolicy: { sandbox: { writeJailRoots: [workspaceRoot], readOnlyRoots: [] } },
    } as unknown as GatewayRuntimeConfig,
    storage: {
      chatAttachments: {
        listBySession: vi.fn(async (sessionId: string) => uploads.filter((item) => item.sessionId === sessionId)),
      },
    } as unknown as HtmlArtifactRenderDependencies["storage"],
    getChatGeneratedArtifact: vi.fn(async () => artifact),
    uploadChatAttachment,
    renderHtmlSnapshot: renderHtmlSnapshot as unknown as HtmlArtifactRenderDependencies["renderHtmlSnapshot"],
  };
  return { deps, rootDir, workspaceRoot, uploads, outputDirs, renderHtmlSnapshot, uploadChatAttachment };
}

describe("html-artifact-render-service", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
  });

  it("renders an html artifact into hash-named PNG attachments with analysis skipped, inside the jail, once", async () => {
    const fixture = await createDeps();
    roots.push(fixture.rootDir);

    const first = await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");

    expect(fixture.deps.getChatGeneratedArtifact).toHaveBeenCalledWith("artifact-1", { workspaceId: "default" });
    expect(first).toEqual({
      artifactId: "artifact-1",
      contentHash: CONTENT_HASH,
      renders: [
        {
          artifactId: "artifact-1",
          contentHash: CONTENT_HASH,
          viewport: "desktop",
          attachmentId: "att-1",
          sha256: `sha-render-${HASH16}-desktop.png`,
          width: 1440,
          height: 900,
          createdAt: now,
        },
        {
          artifactId: "artifact-1",
          contentHash: CONTENT_HASH,
          viewport: "phone",
          attachmentId: "att-2",
          sha256: `sha-render-${HASH16}-phone.png`,
          width: 390,
          height: 844,
          createdAt: now,
        },
      ],
    });
    expect(fixture.uploadChatAttachment).toHaveBeenCalledTimes(2);
    expect(fixture.uploadChatAttachment.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        sessionId: "sess-1",
        projectId: "project-1",
        fileName: `render-${HASH16}-desktop.png`,
        mimeType: "image/png",
        analysis: "skip",
      }),
    );
    const uploadedBytes = Buffer.from(fixture.uploadChatAttachment.mock.calls[0]?.[0].bytesBase64 ?? "", "base64");
    expect(uploadedBytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

    const renderInput = fixture.renderHtmlSnapshot.mock.calls[0]?.[0];
    expect(renderInput?.html).toBe(artifactFixture().content);
    expect(renderInput?.writeJailRoots).toEqual([fixture.workspaceRoot]);
    expect(path.relative(fixture.workspaceRoot, renderInput?.outputDir ?? "").startsWith("..")).toBe(false);
    await expect(stat(fixture.outputDirs[0] ?? "")).rejects.toThrow();

    const second = await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");
    expect(second).toEqual(first);
    expect(fixture.renderHtmlSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.uploadChatAttachment).toHaveBeenCalledTimes(2);
  });

  it("re-renders when the stored renders belong to an older content hash", async () => {
    const fixture = await createDeps();
    roots.push(fixture.rootDir);
    fixture.uploads.push({
      attachmentId: "att-old",
      sessionId: "sess-1",
      workspaceId: "default",
      fileName: "render-ffffffffffffffff-desktop.png",
      mimeType: "image/png",
      mediaType: "image",
      sizeBytes: 10,
      sha256: "old",
      storageRelPath: "chat/default/attachments/old.png",
      extractStatus: "unsupported",
      analysisStatus: "skipped",
      createdAt: now,
    });

    const result = await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");

    expect(fixture.renderHtmlSnapshot).toHaveBeenCalledTimes(1);
    expect(result.renders.map((render) => render.attachmentId)).toEqual(["att-2", "att-3"]);
    expect(result.renders.some((render) => render.attachmentId === "att-old")).toBe(false);
  });

  it("rejects non-html artifacts and redacted projections with a conflict", async () => {
    const markdown = await createDeps(artifactFixture({ kind: "markdown" }));
    roots.push(markdown.rootDir);
    await expect(renderChatGeneratedArtifact(markdown.deps, "artifact-1", "default")).rejects.toBeInstanceOf(
      ConflictError,
    );

    const redacted = await createDeps(
      artifactFixture({
        publicProjection: {
          contentRedacted: true,
          redactionCount: 1,
          redactedPaths: ["content"],
          canonicalContentHashRefersToStoredArtifact: true,
        },
      }),
    );
    roots.push(redacted.rootDir);
    await expect(renderChatGeneratedArtifact(redacted.deps, "artifact-1", "default")).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(markdown.renderHtmlSnapshot).not.toHaveBeenCalled();
    expect(redacted.renderHtmlSnapshot).not.toHaveBeenCalled();
  });

  it("lists stored renders for the current content hash without rendering", async () => {
    const fixture = await createDeps();
    roots.push(fixture.rootDir);

    await expect(listChatArtifactRenders(fixture.deps, "artifact-1", "default")).resolves.toEqual({
      artifactId: "artifact-1",
      contentHash: CONTENT_HASH,
      renders: [],
    });

    await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");
    const listed = await listChatArtifactRenders(fixture.deps, "artifact-1", "default");
    expect(listed.renders.map((render) => [render.viewport, render.attachmentId])).toEqual([
      ["desktop", "att-1"],
      ["phone", "att-2"],
    ]);
    expect(fixture.renderHtmlSnapshot).toHaveBeenCalledTimes(1);
  });

  it("maps renderer diagnostics to typed errors the route can surface", async () => {
    const missingChromium = await createDeps();
    roots.push(missingChromium.rootDir);
    missingChromium.renderHtmlSnapshot.mockRejectedValueOnce(
      new Error(
        "browser_chromium_manual_install_required: Playwright Chromium is unavailable. Automatic installation is disabled.",
      ),
    );
    await expect(renderChatGeneratedArtifact(missingChromium.deps, "artifact-1", "default")).rejects.toMatchObject({
      httpStatus: 503,
      message: expect.stringContaining("browser_chromium_manual_install_required"),
    });

    const oversize = await createDeps();
    roots.push(oversize.rootDir);
    oversize.renderHtmlSnapshot.mockRejectedValueOnce(
      new Error("html_render_too_large: the HTML is 600000 bytes; the render limit is 524288 bytes."),
    );
    await expect(renderChatGeneratedArtifact(oversize.deps, "artifact-1", "default")).rejects.toMatchObject({
      httpStatus: 409,
      message: expect.stringContaining("html_render_too_large"),
    });
  });

  it("falls back to hashing the content when the artifact carries no content hash", async () => {
    const fixture = await createDeps(artifactFixture({ contentHash: undefined }));
    roots.push(fixture.rootDir);

    const result = await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");

    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.renders[0]?.attachmentId).toBe("att-1");
  });
});
