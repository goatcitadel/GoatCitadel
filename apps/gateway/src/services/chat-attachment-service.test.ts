import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GatewayRuntimeConfig } from "../config.js";
import { Storage } from "@goatcitadel/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getChatAttachment,
  readChatAttachmentContent,
  uploadChatAttachment,
  type ChatAttachmentHost,
} from "./chat-attachment-service.js";

const now = new Date("2026-04-20T12:34:56.000Z");

async function createStorage(rootDir: string): Promise<Storage> {
  return new Storage({
    dbPath: path.join(rootDir, "runtime.sqlite"),
    transcriptsDir: path.join(rootDir, "transcripts"),
    auditDir: path.join(rootDir, "audit"),
  });
}

async function createHost(
  workspaceId = "workspace-a",
): Promise<{ host: ChatAttachmentHost; rootDir: string; storage: Storage }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-chat-attachment-"));
  const workspaceDir = "workspace";
  const workspaceRoot = path.join(rootDir, workspaceDir);
  await fs.mkdir(workspaceRoot, { recursive: true });
  const storage = await createStorage(rootDir);
  storage.sessions.upsert({
    sessionId: "sess-1",
    sessionKey: "mission:operator:sess-1",
    kind: "dm",
    channel: "mission",
    account: "operator",
    timestamp: now.toISOString(),
  });
  storage.chatSessionLifecycles.initialize({
    workspaceId,
    sessionId: "sess-1",
    actorId: "test-fixture",
    idempotencyKey: "test:lifecycle:init:sess-1",
    correlationId: "test:correlation:lifecycle:init:sess-1",
    metadataTimestamp: now.toISOString(),
  });
  storage.chatSessionMeta.patch(
    "sess-1",
    {
      workspaceId,
      includeInHistory: true,
      pinned: false,
      lifecycleStatus: "active",
    },
    now.toISOString(),
  );
  const config = {
    rootDir,
    assistant: {
      workspaceDir,
    },
    toolPolicy: {
      sandbox: {
        writeJailRoots: [workspaceRoot],
        readOnlyRoots: [],
      },
    },
  } as unknown as GatewayRuntimeConfig;
  return {
    rootDir,
    storage,
    host: {
      config,
      storage,
      getSession: vi.fn(() => ({ sessionId: "sess-1" })),
      normalizeWorkspaceId: vi.fn((value?: string) => value?.trim() || "default"),
      publishRealtime: vi.fn(),
      createMediaJob: vi.fn(),
    },
  };
}

describe("chat-attachment-service", () => {
  const roots: string[] = [];
  const storages: Storage[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const storage of storages.splice(0)) {
      storage.close();
    }
    await Promise.all(roots.splice(0).map((rootDir) => fs.rm(rootDir, { recursive: true, force: true })));
  });

  it("persists text uploads with sanitized names, preview metadata, content reads, and realtime notification", async () => {
    const { host, rootDir, storage } = await createHost();
    roots.push(rootDir);
    storages.push(storage);
    const bytes = Buffer.from("Hello attachment\n");

    const uploaded = await uploadChatAttachment(host, {
      sessionId: "sess-1",
      fileName: "../notes bad:name.md",
      mimeType: "text/markdown",
      bytesBase64: bytes.toString("base64"),
    });
    const hydrated = await getChatAttachment(host, uploaded.attachmentId);
    const content = await readChatAttachmentContent(host, uploaded.attachmentId);

    expect(uploaded).toEqual(
      expect.objectContaining({
        sessionId: "sess-1",
        workspaceId: "workspace-a",
        fileName: "notes-bad-name.md",
        mimeType: "text/markdown",
        mediaType: "text",
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        extractStatus: "ready",
        extractPreview: "Hello attachment\n",
        ocrText: "Hello attachment\n",
        analysisStatus: "ready",
      }),
    );
    expect(hydrated.attachmentId).toBe(uploaded.attachmentId);
    expect(content.bytes.equals(bytes)).toBe(true);
    expect(content.fullPath).toContain(path.join("workspace", "chat", "default", "attachments", "2026", "04"));
    expect(host.createMediaJob).not.toHaveBeenCalled();
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "chat_message",
      "chat",
      expect.objectContaining({
        type: "chat_attachment_uploaded",
        sessionId: "sess-1",
        attachmentId: uploaded.attachmentId,
        fileName: "notes-bad-name.md",
        sizeBytes: bytes.length,
      }),
    );
  });

  it("uses the bound project path and queues media analysis for image uploads", async () => {
    const { host, rootDir, storage } = await createHost();
    roots.push(rootDir);
    storages.push(storage);
    const project = storage.chatProjects.create(
      {
        workspaceId: "workspace-a",
        name: "Demo",
        workspacePath: "projects/demo",
      },
      now.toISOString(),
    );
    storage.chatSessionProjects.assign("sess-1", project.projectId, now.toISOString());
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const uploaded = await uploadChatAttachment(host, {
      sessionId: "sess-1",
      fileName: "diagram.png",
      mimeType: "image/png",
      bytesBase64: bytes.toString("base64"),
    });

    expect(uploaded).toEqual(
      expect.objectContaining({
        projectId: project.projectId,
        storageRelPath: expect.stringMatching(/^projects\/demo\/attachments\/2026\/04\//),
        extractStatus: "unsupported",
        mediaType: "image",
        analysisStatus: "queued",
      }),
    );
    expect(host.createMediaJob).toHaveBeenCalledWith({
      type: "ocr",
      sessionId: "sess-1",
      attachmentId: uploaded.attachmentId,
    });
  });

  it.each([
    ["audio/mpeg", "audio_transcribe"],
    ["video/mp4", "video_transcribe"],
    ["application/octet-stream", "analyze"],
  ])("queues the correct media job for %s uploads", async (mimeType, expectedJobType) => {
    const { host, rootDir, storage } = await createHost();
    roots.push(rootDir);
    storages.push(storage);

    const uploaded = await uploadChatAttachment(host, {
      sessionId: "sess-1",
      fileName: "media.bin",
      mimeType,
      bytesBase64: Buffer.from("media").toString("base64"),
    });

    expect(uploaded.analysisStatus).toBe("queued");
    expect(host.createMediaJob).toHaveBeenCalledWith({
      type: expectedJobType,
      sessionId: "sess-1",
      attachmentId: uploaded.attachmentId,
    });
  });

  it("rejects empty payloads and cross-workspace project uploads before persistence", async () => {
    const { host, rootDir, storage } = await createHost();
    roots.push(rootDir);
    storages.push(storage);
    const otherProject = storage.chatProjects.create(
      {
        workspaceId: "workspace-b",
        name: "Other",
        workspacePath: "projects/other",
      },
      now.toISOString(),
    );

    await expect(
      uploadChatAttachment(host, {
        sessionId: "sess-1",
        fileName: "empty.txt",
        mimeType: "text/plain",
        bytesBase64: "",
      }),
    ).rejects.toThrow(/empty/i);
    await expect(
      uploadChatAttachment(host, {
        sessionId: "sess-1",
        projectId: otherProject.projectId,
        fileName: "note.txt",
        mimeType: "text/plain",
        bytesBase64: Buffer.from("note").toString("base64"),
      }),
    ).rejects.toThrow(/project workspace/i);
    await expect(
      uploadChatAttachment(host, {
        sessionId: "sess-1",
        fileName: "too-large.bin",
        mimeType: "application/octet-stream",
        bytesBase64: Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64"),
      }),
    ).rejects.toThrow(/20MB/i);
    expect(storage.chatAttachments.listBySession("sess-1")).toEqual([]);
    expect(host.publishRealtime).not.toHaveBeenCalled();
  });

  it("falls back to a generic filename when the upload name sanitizes to empty", async () => {
    const { host, rootDir, storage } = await createHost();
    roots.push(rootDir);
    storages.push(storage);

    const uploaded = await uploadChatAttachment(host, {
      sessionId: "sess-1",
      fileName: "...",
      mimeType: "",
      bytesBase64: Buffer.from("content").toString("base64"),
    });

    expect(uploaded.fileName).toBe("attachment.bin");
    expect(uploaded.mimeType).toBe("application/octet-stream");
    expect(uploaded.storageRelPath).toContain("-attachment.bin");
  });

  it("blocks attachment reads whose stored path resolves outside the configured jail", async () => {
    const { host, rootDir, storage } = await createHost();
    roots.push(rootDir);
    storages.push(storage);
    const outsidePath = path.join(rootDir, "outside.txt");
    await fs.writeFile(outsidePath, "outside", "utf8");
    const record = storage.chatAttachments.create(
      {
        attachmentId: "attachment-outside",
        sessionId: "sess-1",
        workspaceId: "workspace-a",
        fileName: "outside.txt",
        mimeType: "text/plain",
        mediaType: "text",
        sizeBytes: 7,
        sha256: createHash("sha256").update("outside").digest("hex"),
        storageRelPath: "../outside.txt",
        extractStatus: "ready",
        extractPreview: "outside",
        analysisStatus: "ready",
      },
      now.toISOString(),
    );

    await expect(readChatAttachmentContent(host, record.attachmentId)).rejects.toThrow(/outside read allowlist/i);
  });

  it("rejects an oversized stored record before attempting a filesystem read", async () => {
    const { host, rootDir, storage } = await createHost();
    roots.push(rootDir);
    storages.push(storage);
    const record = storage.chatAttachments.create(
      {
        attachmentId: "attachment-too-large",
        sessionId: "sess-1",
        workspaceId: "workspace-a",
        fileName: "missing.txt",
        mimeType: "text/plain",
        mediaType: "text",
        sizeBytes: 10_000,
        sha256: "a".repeat(64),
        storageRelPath: "missing.txt",
        extractStatus: "ready",
        extractPreview: "",
        analysisStatus: "ready",
      },
      now.toISOString(),
    );
    const readSpy = vi.spyOn(fs, "readFile");

    await expect(readChatAttachmentContent(host, record.attachmentId, { maxBytes: 1_024 })).rejects.toThrow(
      /server read limit/u,
    );
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("bounds a drifted on-disk file before allocating or returning its replacement bytes", async () => {
    const { host, rootDir, storage } = await createHost();
    roots.push(rootDir);
    storages.push(storage);
    const uploaded = await uploadChatAttachment(host, {
      sessionId: "sess-1",
      fileName: "drift.txt",
      mimeType: "text/plain",
      bytesBase64: Buffer.from("small").toString("base64"),
    });
    const fullPath = path.resolve(host.config.rootDir, host.config.assistant.workspaceDir, uploaded.storageRelPath);
    await fs.writeFile(fullPath, Buffer.alloc(4_096, 0x61));

    await expect(readChatAttachmentContent(host, uploaded.attachmentId, { maxBytes: 1_024 })).rejects.toThrow(
      /server read limit/u,
    );
  });
});
