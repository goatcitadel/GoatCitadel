import { mkdtemp, mkdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import path from "node:path";
import type { ChatAttachmentRecord, ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayRuntimeConfig } from "../config.js";
import { MAX_CHAT_ATTACHMENT_BYTES } from "./chat-attachment-service.js";
import {
  listChatArtifactRenders,
  renderChatGeneratedArtifact,
  type HtmlArtifactRenderDependencies,
} from "./html-artifact-render-service.js";

const now = "2026-10-12T10:00:00.000Z";
const CONTENT_HASH = "0123456789abcdef".repeat(4);
const HASH16 = CONTENT_HASH.slice(0, 16);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const pngCache = new Map<string, Buffer>();
function pngBytes(width: number, height: number): Buffer {
  const key = `${width}:${height}`;
  const cached = pngCache.get(key);
  if (cached) return cached;
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const bytes = Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
  pngCache.set(key, bytes);
  return bytes;
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
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
  type ReceiptInput = Parameters<HtmlArtifactRenderDependencies["storage"]["chatAttachments"]["recordArtifactRender"]>[0];
  type Receipt = ReceiptInput & { createdAt: string };
  const receipts = new Map<string, Receipt>();
  const publicReceipt = (receipt: Receipt) => ({ artifactId: receipt.artifactId, contentHash: receipt.contentHash,
    viewport: receipt.viewport, width: receipt.width, height: receipt.height, attachmentId: receipt.attachmentId,
    sha256: receipt.sha256, createdAt: receipt.createdAt });
  const receiptKey = (input: ReceiptInput) => JSON.stringify([input.artifactId, input.artifactVersion, input.sessionId,
    input.workspaceId, input.contentHash, input.rendererVersion, input.viewport]);
  const renderHtmlSnapshot = vi.fn(async (input: { html: string; outputDir: string; writeJailRoots: string[] }) => {
    outputDirs.push(input.outputDir);
    await mkdir(input.outputDir, { recursive: true });
    const renders = [];
    for (const viewport of [
      { name: "desktop", width: 1440, height: 900 },
      { name: "phone", width: 390, height: 844 },
    ]) {
      const filePath = path.join(input.outputDir, `render-${viewport.name}.png`);
      const bytes = pngBytes(viewport.width, viewport.height);
      await writeFile(filePath, bytes);
      renders.push({
        viewport: viewport.name,
        width: viewport.width,
        height: viewport.height,
        path: filePath,
        sha256: sha(bytes),
        bytes: bytes.byteLength,
        title: "Landing",
        blockedRequests: [],
      });
    }
    return { renders, contentSecurityPolicy: "default-src 'self'" };
  });
  const uploadChatAttachment = vi.fn(
    async (input: { sessionId: string; projectId?: string; fileName: string; mimeType: string; bytes: Buffer }) => {
      const record: ChatAttachmentRecord = {
        attachmentId: `att-${uploads.length + 1}`,
        sessionId: input.sessionId,
        workspaceId: "default",
        projectId: input.projectId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        mediaType: "image",
        sizeBytes: input.bytes.byteLength,
        sha256: sha(input.bytes),
        storageRelPath: `chat/default/attachments/att-${uploads.length + 1}-${input.fileName}`,
        extractStatus: "unsupported",
        analysisStatus: "skipped",
        createdAt: now,
      };
      uploads.push(record);
      const fullPath = path.join(workspaceRoot, record.storageRelPath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, input.bytes);
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
        get: vi.fn(async (id: string) => {
          const attachment = uploads.find((item) => item.attachmentId === id);
          if (!attachment) throw new NotFoundError({ entity: "Attachment", id });
          return attachment;
        }),
        recordArtifactRender: vi.fn(async (input: ReceiptInput) => {
          const attachment = uploads.find((item) => item.attachmentId === input.attachmentId)!;
          const receipt = { ...input, createdAt: attachment.createdAt };
          receipts.set(receiptKey(input), receipt);
          return publicReceipt(receipt);
        }),
        listArtifactRenders: vi.fn(async (input: Omit<ReceiptInput, "viewport" | "width" | "height" | "attachmentId" | "sha256">) =>
          [...receipts.values()].filter((receipt) => Object.entries(input).every(([key, value]) =>
            receipt[key as keyof typeof receipt] === value)).map(publicReceipt)),
      },
    } as unknown as HtmlArtifactRenderDependencies["storage"],
    getChatGeneratedArtifact: vi.fn(async () => artifact),
    uploadChatAttachment,
    renderHtmlSnapshot: renderHtmlSnapshot as unknown as HtmlArtifactRenderDependencies["renderHtmlSnapshot"],
  };
  return { deps, rootDir, workspaceRoot, uploads, receipts, outputDirs, renderHtmlSnapshot, uploadChatAttachment };
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
          sha256: sha(pngBytes(1440, 900)),
          width: 1440,
          height: 900,
          createdAt: now,
        },
        {
          artifactId: "artifact-1",
          contentHash: CONTENT_HASH,
          viewport: "phone",
          attachmentId: "att-2",
          sha256: sha(pngBytes(390, 844)),
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
    const uploadedBytes = fixture.uploadChatAttachment.mock.calls[0]?.[0].bytes ?? Buffer.alloc(0);
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

  it("renders fresh evidence instead of reusing ordinary PNG uploads with forged renderer names", async () => {
    const fixture = await createDeps();
    roots.push(fixture.rootDir);
    // A valid ordinary 1x1 PNG, uploaded through the same attachment dependency.
    // Its filename and MIME carry no renderer provenance.
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
    for (const viewport of ["desktop", "phone"]) {
      await fixture.uploadChatAttachment({ sessionId: "sess-1", fileName: `render-${HASH16}-${viewport}.png`,
        mimeType: "image/png", bytes });
    }
    const forgedIds = fixture.uploads.map((attachment) => attachment.attachmentId);

    const result = await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");

    expect(fixture.renderHtmlSnapshot).toHaveBeenCalledOnce();
    expect(result.renders.map((render) => render.attachmentId)).toEqual(["att-3", "att-4"]);
    expect(result.renders.some((render) => forgedIds.includes(render.attachmentId))).toBe(false);
    expect(fixture.uploadChatAttachment).toHaveBeenCalledTimes(4);
  });

  it.each([
    { mimeType: "image/png", mediaType: "image" as const },
    { mimeType: "application/octet-stream", mediaType: "binary" as const },
  ])("does not list ordinary $mimeType uploads as renderer evidence solely from their names", async ({ mimeType, mediaType }) => {
    const fixture = await createDeps();
    roots.push(fixture.rootDir);
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
    for (const viewport of ["desktop", "phone"]) {
      const attachment = await fixture.uploadChatAttachment({ sessionId: "sess-1",
        fileName: `render-${HASH16}-${viewport}.png`, mimeType, bytes });
      attachment.mediaType = mediaType;
    }

    const listed = await listChatArtifactRenders(fixture.deps, "artifact-1", "default");

    expect(listed.renders).toEqual([]);
    expect(fixture.renderHtmlSnapshot).not.toHaveBeenCalled();
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

  it("refuses to render stored content that the public projection would redact", async () => {
    const secret = await createDeps(
      artifactFixture({
        content: '<!doctype html><html><body><p>{"DATABASE_PASSWORD":"render-content-secret"}</p></body></html>',
      }),
    );
    roots.push(secret.rootDir);

    await expect(renderChatGeneratedArtifact(secret.deps, "artifact-1", "default")).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(secret.renderHtmlSnapshot).not.toHaveBeenCalled();
    expect(secret.uploadChatAttachment).not.toHaveBeenCalled();
  });

  it("shares one render between concurrent requests for the same content", async () => {
    const harness = await createDeps(artifactFixture());
    roots.push(harness.rootDir);

    const [first, second] = await Promise.all([
      renderChatGeneratedArtifact(harness.deps, "artifact-1", "default"),
      renderChatGeneratedArtifact(harness.deps, "artifact-1", "default"),
    ]);

    expect(harness.renderHtmlSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.uploads).toHaveLength(2);
    expect(second.renders.map((item) => item.attachmentId)).toEqual(first.renders.map((item) => item.attachmentId));
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

  it("reuses durable renderer receipts through a fresh dependency instance and verifies stored bytes", async () => {
    const fixture = await createDeps(); roots.push(fixture.rootDir);
    const first = await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");
    const restarted = { ...fixture.deps, storage: { ...fixture.deps.storage } };
    expect(await renderChatGeneratedArtifact(restarted, "artifact-1", "default")).toEqual(first);
    expect(fixture.renderHtmlSnapshot).toHaveBeenCalledOnce();
    const desktop = fixture.uploads[0]!;
    await writeFile(path.join(fixture.workspaceRoot, desktop.storageRelPath), Buffer.concat([pngBytes(1440, 900), Buffer.from("corrupt")]));
    const repaired = await renderChatGeneratedArtifact(restarted, "artifact-1", "default");
    expect(fixture.renderHtmlSnapshot).toHaveBeenCalledTimes(2);
    expect(repaired.renders.map((item) => item.attachmentId)).toEqual(["att-3", "att-4"]);
  });


  it("treats an oversized stored PNG as a cache miss and regenerates it", async () => {
    const fixture = await createDeps();
    roots.push(fixture.rootDir);
    await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");
    const desktop = fixture.uploads[0]!;
    await truncate(path.join(fixture.workspaceRoot, desktop.storageRelPath), MAX_CHAT_ATTACHMENT_BYTES + 1);

    const listed = await listChatArtifactRenders(fixture.deps, "artifact-1", "default");
    expect(listed.renders.map((item) => item.attachmentId)).toEqual(["att-2"]);
    const regenerated = await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");
    expect(fixture.renderHtmlSnapshot).toHaveBeenCalledTimes(2);
    expect(regenerated.renders.map((item) => item.attachmentId)).toEqual(["att-3", "att-4"]);
    expect(await listChatArtifactRenders(fixture.deps, "artifact-1", "default")).toEqual(regenerated);
  });

  it("does not recover a cached attachment outside the read jail", async () => {
    const fixture = await createDeps();
    roots.push(fixture.rootDir);
    await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");
    const desktop = fixture.uploads[0]!;
    const outside = path.join(fixture.rootDir, "outside.png");
    await writeFile(outside, pngBytes(1440, 900));
    desktop.storageRelPath = path.relative(fixture.workspaceRoot, outside);

    await expect(listChatArtifactRenders(fixture.deps, "artifact-1", "default")).rejects.toThrow("outside read allowlist");
    await expect(renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default")).rejects.toThrow("outside read allowlist");
    expect(fixture.renderHtmlSnapshot).toHaveBeenCalledOnce();
  });

  it.each(["artifact", "artifact version", "full hash", "session", "workspace", "renderer version"])("does not reuse a receipt with different %s identity", async (mismatch) => {
    const artifact = artifactFixture(); const fixture = await createDeps(artifact); roots.push(fixture.rootDir);
    await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");
    if (mismatch === "artifact") artifact.artifactId = "artifact-2";
    if (mismatch === "artifact version") artifact.version = 2;
    if (mismatch === "full hash") artifact.contentHash = `${HASH16}${"f".repeat(48)}`;
    if (mismatch === "session") artifact.sessionId = "another-session";
    if (mismatch === "workspace") artifact.workspaceId = "another-workspace";
    if (mismatch === "renderer version") for (const receipt of fixture.receipts.values()) receipt.rendererVersion = "old-renderer";
    const listed = await listChatArtifactRenders(fixture.deps, artifact.artifactId, artifact.workspaceId!);
    expect(listed.renders).toEqual([]);
  });

  it("refuses cached PNG geometry even when file and metadata hashes match", async () => {
    const fixture = await createDeps(); roots.push(fixture.rootDir);
    await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");
    const desktop = fixture.uploads[0]!;
    const changed = pngBytes(1, 1);
    desktop.sha256 = sha(changed); desktop.sizeBytes = changed.length;
    for (const receipt of fixture.receipts.values()) if (receipt.viewport === "desktop") receipt.sha256 = desktop.sha256;
    await writeFile(path.join(fixture.workspaceRoot, desktop.storageRelPath), changed);
    const listed = await listChatArtifactRenders(fixture.deps, "artifact-1", "default");
    expect(listed.renders.map((item) => item.viewport)).toEqual(["phone"]);
  });

  it("re-renders a missing cached file and preserves the attachment reader's realpath jail", async () => {
    const fixture = await createDeps(); roots.push(fixture.rootDir);
    await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");
    await rm(path.join(fixture.workspaceRoot, fixture.uploads[0]!.storageRelPath));
    await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");
    expect(fixture.renderHtmlSnapshot).toHaveBeenCalledTimes(2);
    const desktop = fixture.uploads[2]!;
    const outside = path.join(fixture.rootDir, "outside-workspace.png");
    await writeFile(outside, pngBytes(1440, 900));
    desktop.storageRelPath = "../outside-workspace.png";
    await expect(listChatArtifactRenders(fixture.deps, "artifact-1", "default")).rejects.toThrow();
    expect(fixture.renderHtmlSnapshot).toHaveBeenCalledTimes(2);
  });

  it("refuses a fresh renderer's wrong PNG dimensions before recording provenance", async () => {
    const fixture = await createDeps(); roots.push(fixture.rootDir);
    const renderer = fixture.renderHtmlSnapshot.getMockImplementation()!;
    fixture.renderHtmlSnapshot.mockImplementationOnce(async (input) => {
      const rendered = await renderer(input);
      await writeFile(rendered.renders[0]!.path, pngBytes(1, 1));
      return rendered;
    });
    await expect(renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default")).rejects.toBeInstanceOf(ConflictError);
    expect(fixture.receipts.size).toBe(0);
    expect((await listChatArtifactRenders(fixture.deps, "artifact-1", "default")).renders).toEqual([]);
  });
  it("does not grant cache authority to uploaded output when receipt recording fails", async () => {
    const fixture = await createDeps(); roots.push(fixture.rootDir);
    const record = vi.spyOn(fixture.deps.storage.chatAttachments, "recordArtifactRender");
    record.mockRejectedValueOnce(new Error("receipt transaction unavailable"));
    await expect(renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default")).rejects.toThrow("receipt transaction unavailable");
    expect((await listChatArtifactRenders(fixture.deps, "artifact-1", "default")).renders).toEqual([]);
    await renderChatGeneratedArtifact(fixture.deps, "artifact-1", "default");
    expect(fixture.renderHtmlSnapshot).toHaveBeenCalledTimes(2);
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
