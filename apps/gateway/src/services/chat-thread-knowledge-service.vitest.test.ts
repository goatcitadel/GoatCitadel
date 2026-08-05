import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatAttachmentRecord, ChatSessionRecord } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachChatThreadKnowledgeAttachment,
  buildThreadKnowledgeNamespace,
  listChatThreadKnowledgeAttachments,
  removeChatThreadKnowledgeAttachment,
  resolveThreadKnowledgeContext,
  type ChatThreadKnowledgeDependencies,
} from "./chat-thread-knowledge-service.js";

async function createStorage(): Promise<{ storage: Storage; rootDir: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-thread-knowledge-vitest-"));
  return {
    rootDir,
    storage: new Storage({
      dbPath: path.join(rootDir, "runtime.sqlite"),
      transcriptsDir: path.join(rootDir, "transcripts"),
      auditDir: path.join(rootDir, "audit"),
    }),
  };
}

function seedSession(storage: Storage, sessionId: string, workspaceId = "default"): ChatSessionRecord {
  const now = "2026-05-14T00:00:00.000Z";
  storage.sessions.upsert({
    sessionId,
    sessionKey: `mission:operator:${sessionId}`,
    kind: "dm",
    channel: "mission",
    account: "operator",
    timestamp: now,
  });
  storage.chatSessionLifecycles.initialize({
    workspaceId,
    sessionId,
    actorId: "test-fixture",
    idempotencyKey: `test:lifecycle:init:${sessionId}`,
    correlationId: `test:correlation:lifecycle:init:${sessionId}`,
    metadataTimestamp: now,
  });
  storage.chatSessionMeta.patch(
    sessionId,
    {
      workspaceId,
      includeInHistory: true,
      pinned: false,
      lifecycleStatus: "active",
    },
    now,
  );
  storage.chatSessionPrefs.patch(
    sessionId,
    {
      mode: "chat",
    },
    now,
  );
  return {
    sessionId,
    sessionKey: `mission:operator:${sessionId}`,
    workspaceId,
    scope: "mission",
    includeInHistory: true,
    pinned: false,
    lifecycleStatus: "active",
    channel: "mission",
    account: "operator",
    updatedAt: now,
    lastActivityAt: now,
    tokenTotal: 0,
    costUsdTotal: 0,
  };
}

function seedAttachment(
  storage: Storage,
  sessionId: string,
  attachmentId: string,
  overrides: Partial<ChatAttachmentRecord> = {},
): ChatAttachmentRecord {
  return storage.chatAttachments.create(
    {
      attachmentId,
      sessionId,
      workspaceId: "default",
      fileName: overrides.fileName ?? `${attachmentId}.txt`,
      mimeType: overrides.mimeType ?? "text/plain",
      sizeBytes: overrides.sizeBytes ?? 4,
      sha256: overrides.sha256 ?? attachmentId.padEnd(8, "0"),
      storageRelPath: overrides.storageRelPath ?? `chat/default/attachments/${attachmentId}.txt`,
      extractStatus: overrides.extractStatus ?? "ready",
      extractPreview: overrides.extractPreview,
      mediaType: overrides.mediaType,
      thumbnailRelPath: overrides.thumbnailRelPath,
      ocrText: overrides.ocrText,
      transcriptText: overrides.transcriptText,
      analysisStatus: overrides.analysisStatus,
    },
    "2026-05-14T00:00:00.000Z",
  );
}

function createHost(
  storage: Storage,
  overrides: Partial<ChatThreadKnowledgeDependencies> = {},
): ChatThreadKnowledgeDependencies {
  return {
    storage,
    getSession: overrides.getSession ?? ((sessionId: string) => storage.sessions.getBySessionId(sessionId)),
    readChatAttachmentContent:
      overrides.readChatAttachmentContent ??
      (async (attachmentId: string) => {
        const record = storage.chatAttachments.get(attachmentId);
        return {
          bytes: Buffer.from(record.extractPreview ?? record.transcriptText ?? record.ocrText ?? "", "utf8"),
          record,
        };
      }),
    knowledgeDocsIngest: overrides.knowledgeDocsIngest ?? (async () => ({})),
    knowledgeEmbeddingsQuery: overrides.knowledgeEmbeddingsQuery ?? (async () => ({ items: [] })),
  };
}

describe("chat-thread-knowledge-service vitest coverage", () => {
  const roots: string[] = [];
  const storages: Storage[] = [];

  afterEach(async () => {
    for (const storage of storages.splice(0)) {
      storage.close();
    }
    await Promise.all(roots.splice(0).map((rootDir) => fs.rm(rootDir, { recursive: true, force: true })));
  });

  it("lists only a trimmed valid session and rejects an empty session id", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-list");
    const host = createHost(storage);
    storage.chatThreadKnowledgeAttachments.create({
      attachmentId: "knowledge-list",
      sessionId: session.sessionId,
      sourceType: "url",
      sourceRef: "https://example.com/runbook",
      title: "Runbook",
      retrievalMode: "full_text",
      ingestStatus: "ready",
      chunkCount: 1,
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });

    await expect(listChatThreadKnowledgeAttachments(host, ` ${session.sessionId} `)).resolves.toHaveLength(1);
    await expect(listChatThreadKnowledgeAttachments(host, "   ")).rejects.toThrow(/sessionId|FIELD_REQUIRED/);
  });

  it("attaches text files as full-text knowledge using decoded file bytes before extracted previews", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-full-text-file");
    seedAttachment(storage, session.sessionId, "attachment-text", {
      fileName: "guide.md",
      mimeType: "text/markdown",
      extractPreview: "stale preview",
    });
    const host = createHost(storage, {
      readChatAttachmentContent: vi.fn(async () => ({
        bytes: Buffer.from("decoded file text from disk", "utf8"),
        record: storage.chatAttachments.get("attachment-text"),
      })),
    });

    const attached = await attachChatThreadKnowledgeAttachment(host, session.sessionId, {
      chatAttachmentId: "attachment-text",
      retrievalMode: "full_text",
    });
    const resolved = await resolveThreadKnowledgeContext(host, session.sessionId, "Summarize guide");

    expect(attached).toMatchObject({
      sourceType: "file",
      sourceRef: "guide.md",
      retrievalMode: "full_text",
      ingestStatus: "ready",
      chunkCount: 1,
      errorMessage: undefined,
    });
    expect(resolved.systemInstruction).toContain("decoded file text from disk");
    expect(resolved.systemInstruction).not.toContain("stale preview");
    expect(resolved.citations[0]).toEqual(
      expect.objectContaining({
        sourceType: "file",
        knowledge: expect.objectContaining({
          attachmentId: attached.attachmentId,
          retrievalMode: "full_text",
        }),
      }),
    );
  });

  it("ingests retrieval file knowledge into chunks and returns the top scored chunk citation", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-retrieval-file");
    seedAttachment(storage, session.sessionId, "attachment-retrieval", {
      fileName: "architecture.md",
      mimeType: "text/markdown",
      extractPreview: "Architecture notes ".repeat(200),
    });
    const host = createHost(storage);

    const attached = await attachChatThreadKnowledgeAttachment(host, session.sessionId, {
      chatAttachmentId: "attachment-retrieval",
      retrievalMode: "retrieval",
    });
    const chunks = storage.knowledge.listChunksByDocument(attached.documentId ?? "", 500);
    host.knowledgeEmbeddingsQuery = vi.fn(async () => ({
      items: chunks.map((chunk, index) => ({
        chunkId: chunk.chunkId,
        docId: attached.documentId,
        score: index === 0 ? 0.8 : 0.2,
        snippet: `retrieved ${index}`,
      })),
    }));

    const resolved = await resolveThreadKnowledgeContext(host, session.sessionId, "architecture");

    expect(attached.ingestStatus).toBe("ready");
    expect(attached.namespace).toBe(buildThreadKnowledgeNamespace(session.sessionId));
    expect(chunks.length).toBeGreaterThan(1);
    expect(resolved.systemInstruction).toContain("Retrieved thread knowledge");
    expect(resolved.citations[0]).toEqual(
      expect.objectContaining({
        citationId: expect.stringContaining(chunks[0]?.chunkId ?? "missing"),
        knowledge: expect.objectContaining({
          chunkId: chunks[0]?.chunkId,
          sectionLabel: "Chunk 1",
          retrievalMode: "retrieval",
        }),
      }),
    );
  });

  it("marks stale full-text and retrieval records failed while keeping the turn resolvable", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-stale");
    const namespace = buildThreadKnowledgeNamespace(session.sessionId);
    storage.chatThreadKnowledgeAttachments.create({
      attachmentId: "knowledge-stale-full-text",
      sessionId: session.sessionId,
      sourceType: "file",
      sourceRef: "missing.txt",
      title: "Missing text",
      retrievalMode: "full_text",
      ingestStatus: "ready",
      chatAttachmentId: "",
      chunkCount: 1,
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });
    storage.chatThreadKnowledgeAttachments.create({
      attachmentId: "knowledge-stale-retrieval",
      sessionId: session.sessionId,
      sourceType: "url",
      sourceRef: "https://example.com/missing",
      title: "Missing retrieval",
      retrievalMode: "retrieval",
      ingestStatus: "ready",
      namespace,
      documentId: "",
      chunkCount: 1,
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });
    const host = createHost(storage);

    const resolved = await resolveThreadKnowledgeContext(host, session.sessionId, "missing");

    expect(resolved.systemInstruction).toContain("Skipped Missing text");
    expect(resolved.systemInstruction).toContain("Skipped Missing retrieval");
    expect(resolved.citations).toEqual([]);
    expect(storage.chatThreadKnowledgeAttachments.get("knowledge-stale-full-text")).toMatchObject({
      ingestStatus: "failed",
      chunkCount: 0,
    });
    expect(storage.chatThreadKnowledgeAttachments.get("knowledge-stale-retrieval")).toMatchObject({
      ingestStatus: "failed",
      chunkCount: 0,
    });
  });

  it("retries a failed URL attach by deleting stale documents and clearing the old error", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-url-retry");
    const namespace = buildThreadKnowledgeNamespace(session.sessionId);
    const staleDocument = storage.knowledge.createDocument(
      {
        namespace,
        sourceType: "url",
        sourceRef: "https://example.com/retry",
        title: "Retry",
      },
      "2026-05-14T00:00:00.000Z",
    );
    storage.knowledge.appendChunks(staleDocument.docId, [{ content: "stale" }], "2026-05-14T00:00:00.000Z");
    const failed = storage.chatThreadKnowledgeAttachments.create({
      attachmentId: "knowledge-url-retry",
      sessionId: session.sessionId,
      sourceType: "url",
      sourceRef: "https://example.com/retry",
      title: "Retry",
      retrievalMode: "full_text",
      ingestStatus: "failed",
      namespace,
      documentId: staleDocument.docId,
      chunkCount: 1,
      errorMessage: "old failure",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });
    const host = createHost(storage, {
      knowledgeDocsIngest: vi.fn(async ({ source, namespace: inputNamespace, title }) => {
        const document = storage.knowledge.createDocument(
          {
            namespace: inputNamespace,
            sourceType: "url",
            sourceRef: source,
            title: title ?? source,
          },
          "2026-05-14T00:00:01.000Z",
        );
        storage.knowledge.appendChunks(
          document.docId,
          [{ content: "fresh retry content" }],
          "2026-05-14T00:00:01.000Z",
        );
        return {
          document: { docId: document.docId },
          chunksSaved: 1,
        };
      }),
    });

    const retried = await attachChatThreadKnowledgeAttachment(host, session.sessionId, {
      url: "https://example.com/retry",
      retrievalMode: "full_text",
    });

    expect(retried.attachmentId).toBe(failed.attachmentId);
    expect(retried).toMatchObject({
      ingestStatus: "ready",
      errorMessage: undefined,
      chunkCount: 1,
    });
    expect(retried.documentId).not.toBe(staleDocument.docId);
    expect(storage.knowledge.getDocument(staleDocument.docId)).toBeUndefined();
  });

  it("requires same-session ownership before removing knowledge attachments", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-owner");
    const otherSession = seedSession(storage, "sess-other");
    const host = createHost(storage);
    storage.chatThreadKnowledgeAttachments.create({
      attachmentId: "knowledge-owned",
      sessionId: session.sessionId,
      sourceType: "url",
      sourceRef: "https://example.com/owned",
      title: "Owned",
      retrievalMode: "full_text",
      ingestStatus: "ready",
      chunkCount: 1,
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });

    await expect(removeChatThreadKnowledgeAttachment(host, otherSession.sessionId, "knowledge-owned")).rejects.toThrow(
      /does not belong/,
    );
    await expect(removeChatThreadKnowledgeAttachment(host, session.sessionId, "knowledge-owned")).resolves.toEqual({
      deleted: true,
      attachmentId: "knowledge-owned",
    });
  });
});
