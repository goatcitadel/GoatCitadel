import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ChatAttachmentRecord, ChatSessionRecord } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import {
  attachChatThreadKnowledgeAttachment,
  buildThreadKnowledgeNamespace,
  removeChatThreadKnowledgeAttachment,
  resolveThreadKnowledgeContext,
  type ChatThreadKnowledgeHost,
} from "./chat-thread-knowledge-service.js";

async function createStorage(): Promise<{ storage: Storage; rootDir: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-thread-knowledge-"));
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
  const now = "2026-04-20T00:00:00.000Z";
  storage.sessions.upsert({
    sessionId,
    sessionKey: `mission:operator:${sessionId}`,
    kind: "dm",
    channel: "mission",
    account: "operator",
    timestamp: now,
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
    "2026-04-20T00:00:00.000Z",
  );
}

function createHost(storage: Storage, overrides: Partial<ChatThreadKnowledgeHost> = {}): ChatThreadKnowledgeHost {
  return {
    storage,
    getSession: (sessionId: string) => storage.sessions.getBySessionId(sessionId),
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

describe("chat-thread-knowledge-service", () => {
  const roots: string[] = [];
  const storages: Storage[] = [];

  afterEach(async () => {
    for (const storage of storages.splice(0)) {
      storage.close();
    }
    await Promise.all(
      roots.splice(0).map(async (rootDir) => {
        await fs.rm(rootDir, { recursive: true, force: true });
      }),
    );
  });

  it("marks unreadable full-text file attachments as failed instead of ready", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-file");
    seedAttachment(storage, session.sessionId, "attachment-pdf", {
      fileName: "scan.pdf",
      mimeType: "application/pdf",
      mediaType: "binary",
      extractPreview: undefined,
      ocrText: undefined,
      transcriptText: undefined,
    });
    const host = createHost(storage, {
      readChatAttachmentContent: async () => {
        throw new Error("raw file bytes unavailable");
      },
    });

    const record = await attachChatThreadKnowledgeAttachment(host, session.sessionId, {
      chatAttachmentId: "attachment-pdf",
      retrievalMode: "full_text",
    });

    assert.equal(record.ingestStatus, "failed");
    assert.match(record.errorMessage ?? "", /full-text/i);
    assert.equal(record.documentId, undefined);
  });

  it("marks URL full-text knowledge as failed when ingestion produces no readable content", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-url");
    const host = createHost(storage, {
      knowledgeDocsIngest: async () => ({
        document: { docId: "doc-empty" },
        chunksSaved: 0,
      }),
    });

    const record = await attachChatThreadKnowledgeAttachment(host, session.sessionId, {
      url: "https://example.com/empty",
      retrievalMode: "full_text",
    });

    assert.equal(record.ingestStatus, "failed");
    assert.match(record.errorMessage ?? "", /readable knowledge content/i);
  });

  it("degrades retrieval failures per source instead of aborting the turn", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-retrieval-failure");
    const namespace = buildThreadKnowledgeNamespace(session.sessionId);
    const document = storage.knowledge.createDocument(
      {
        namespace,
        sourceType: "url",
        sourceRef: "https://example.com/source",
        title: "Example source",
      },
      "2026-04-20T00:00:00.000Z",
    );
    storage.knowledge.appendChunks(
      document.docId,
      [{ content: "retrieval-backed content" }],
      "2026-04-20T00:00:00.000Z",
    );
    const attachment = storage.chatThreadKnowledgeAttachments.create({
      attachmentId: "knowledge-1",
      sessionId: session.sessionId,
      sourceType: "url",
      sourceRef: "https://example.com/source",
      title: "Example source",
      retrievalMode: "retrieval",
      ingestStatus: "ready",
      namespace,
      documentId: document.docId,
      chunkCount: 1,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    });
    const host = createHost(storage, {
      knowledgeEmbeddingsQuery: async () => {
        throw new Error("vector store offline");
      },
    });

    const result = await resolveThreadKnowledgeContext(host, session.sessionId, "What changed?");
    const updated = result.attachments.find((item) => item.attachmentId === attachment.attachmentId);

    assert.deepEqual(result.citations, []);
    assert.match(result.systemInstruction ?? "", /Skipped retrieval-backed thread knowledge/);
    assert.match(result.systemInstruction ?? "", /vector store offline/);
    assert.equal(updated?.ingestStatus, "ready");
    assert.equal(updated?.errorMessage, undefined);
  });

  it("emits URL-backed knowledge citations with web provenance", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-citation");
    const namespace = buildThreadKnowledgeNamespace(session.sessionId);
    const document = storage.knowledge.createDocument(
      {
        namespace,
        sourceType: "url",
        sourceRef: "https://example.com/pricing",
        title: "Pricing memo",
      },
      "2026-04-20T00:00:00.000Z",
    );
    const [chunk] = storage.knowledge.appendChunks(
      document.docId,
      [{ content: "The current price is $42 per seat." }],
      "2026-04-20T00:00:00.000Z",
    );
    storage.chatThreadKnowledgeAttachments.create({
      attachmentId: "knowledge-url",
      sessionId: session.sessionId,
      sourceType: "url",
      sourceRef: "https://example.com/pricing",
      title: "Pricing memo",
      retrievalMode: "retrieval",
      ingestStatus: "ready",
      namespace,
      documentId: document.docId,
      chunkCount: 1,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    });
    const host = createHost(storage, {
      knowledgeEmbeddingsQuery: async () => ({
        items: [
          {
            chunkId: chunk?.chunkId,
            docId: document.docId,
            score: 0.98,
            snippet: "The current price is $42 per seat.",
          },
        ],
      }),
    });

    const result = await resolveThreadKnowledgeContext(host, session.sessionId, "What is the current price?");

    assert.equal(result.citations[0]?.sourceType, "web");
    assert.equal(result.citations[0]?.url, "https://example.com/pricing");
    assert.equal(result.citations[0]?.knowledge?.retrievalMode, "retrieval");
    assert.match(result.systemInstruction ?? "", /Retrieved thread knowledge/);
  });

  it("deletes the shared document only after the last attachment reference is removed", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-remove");
    const namespace = buildThreadKnowledgeNamespace(session.sessionId);
    const document = storage.knowledge.createDocument(
      {
        namespace,
        sourceType: "url",
        sourceRef: "https://example.com/runbook",
        title: "Runbook",
      },
      "2026-04-20T00:00:00.000Z",
    );
    storage.knowledge.appendChunks(document.docId, [{ content: "First chunk" }], "2026-04-20T00:00:00.000Z");
    storage.chatThreadKnowledgeAttachments.create({
      attachmentId: "knowledge-a",
      sessionId: session.sessionId,
      sourceType: "url",
      sourceRef: "https://example.com/runbook",
      title: "Runbook",
      retrievalMode: "retrieval",
      ingestStatus: "ready",
      namespace,
      documentId: document.docId,
      chunkCount: 1,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    });
    storage.chatThreadKnowledgeAttachments.create({
      attachmentId: "knowledge-b",
      sessionId: session.sessionId,
      sourceType: "url",
      sourceRef: "https://example.com/runbook",
      title: "Runbook duplicate",
      retrievalMode: "retrieval",
      ingestStatus: "ready",
      namespace,
      documentId: document.docId,
      chunkCount: 1,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    });
    const host = createHost(storage);

    const firstRemoval = removeChatThreadKnowledgeAttachment(host, session.sessionId, "knowledge-a");
    assert.equal(firstRemoval.deleted, true);
    assert.notEqual(storage.knowledge.getDocument(document.docId), undefined);

    const secondRemoval = removeChatThreadKnowledgeAttachment(host, session.sessionId, "knowledge-b");
    assert.equal(secondRemoval.deleted, true);
    assert.equal(storage.knowledge.getDocument(document.docId), undefined);
    assert.equal(storage.knowledge.listChunksByDocument(document.docId).length, 0);
  });

  it("caps aggregate full-text knowledge and surfaces truncation notices", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-budget");
    const host = createHost(storage);
    const longText = (prefix: string) => `${prefix.repeat(16_000)} ${prefix.repeat(16_000)}`;

    for (const index of [1, 2, 3, 4]) {
      const attachmentId = `budget-${index}`;
      seedAttachment(storage, session.sessionId, attachmentId, {
        fileName: `budget-${index}.md`,
        mimeType: "text/markdown",
        mediaType: "text",
        extractPreview: longText(String(index)),
      });
      storage.chatThreadKnowledgeAttachments.create({
        attachmentId: `knowledge-budget-${index}`,
        sessionId: session.sessionId,
        sourceType: "file",
        sourceRef: `budget-${index}.md`,
        title: `Budget ${index}`,
        retrievalMode: "full_text",
        ingestStatus: "ready",
        chatAttachmentId: attachmentId,
        chunkCount: 1,
        createdAt: `2026-04-20T00:00:0${index}.000Z`,
        updatedAt: `2026-04-20T00:00:0${index}.000Z`,
      });
    }

    const result = await resolveThreadKnowledgeContext(host, session.sessionId, "Summarize the docs");

    assert.match(result.systemInstruction ?? "", /Truncated Budget 4/);
    assert.match(result.systemInstruction ?? "", /Truncated Budget 3/);
    assert.match(result.systemInstruction ?? "", /Truncated Budget 2/);
    assert.match(
      result.systemInstruction ?? "",
      /Skipped Budget 1 because the thread knowledge full-text budget was exhausted\./,
    );
    assert.equal(result.citations.length, 3);
  });

  it("does not read or fail full-text attachments once the context budget is exhausted", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-budget-read-boundary");

    for (const index of [1, 2, 3, 4]) {
      const attachmentId = `budget-boundary-${index}`;
      seedAttachment(storage, session.sessionId, attachmentId, {
        fileName: `budget-boundary-${index}.md`,
        mimeType: "text/markdown",
        mediaType: "text",
        extractPreview: undefined,
        ocrText: undefined,
        transcriptText: undefined,
      });
      storage.chatThreadKnowledgeAttachments.create({
        attachmentId: `knowledge-budget-boundary-${index}`,
        sessionId: session.sessionId,
        sourceType: "file",
        sourceRef: `budget-boundary-${index}.md`,
        title: `Budget boundary ${index}`,
        retrievalMode: "full_text",
        ingestStatus: "ready",
        chatAttachmentId: attachmentId,
        chunkCount: 1,
        createdAt: `2026-04-20T00:00:0${index}.000Z`,
        updatedAt: `2026-04-20T00:00:0${index}.000Z`,
      });
    }

    const orderedAttachments = storage.chatThreadKnowledgeAttachments
      .listBySession(session.sessionId)
      .filter((item) => item.retrievalMode === "full_text");
    const skippedAttachment = orderedAttachments[3];
    assert.ok(skippedAttachment);
    assert.ok(skippedAttachment.chatAttachmentId);
    const readAttachmentIds: string[] = [];
    const host = createHost(storage, {
      readChatAttachmentContent: async (attachmentId: string) => {
        readAttachmentIds.push(attachmentId);
        const record = storage.chatAttachments.get(attachmentId);
        return {
          bytes: Buffer.from(
            attachmentId === skippedAttachment.chatAttachmentId ? "" : `${attachmentId} `.repeat(20_000),
            "utf8",
          ),
          record,
        };
      },
    });

    const result = await resolveThreadKnowledgeContext(host, session.sessionId, "Summarize the docs");
    const skippedAfterResolve = storage.chatThreadKnowledgeAttachments.get(skippedAttachment.attachmentId);

    assert.equal(readAttachmentIds.length, 3);
    assert.equal(readAttachmentIds.includes(skippedAttachment.chatAttachmentId), false);
    assert.equal(skippedAfterResolve.ingestStatus, "ready");
    assert.match(
      result.systemInstruction ?? "",
      new RegExp(`Skipped ${skippedAttachment.title} because the thread knowledge full-text budget was exhausted\\.`),
    );
  });

  it("retries a previously failed file attachment instead of returning the stale failed record", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-file-retry");
    seedAttachment(storage, session.sessionId, "attachment-retry", {
      fileName: "notes.txt",
      mimeType: "text/plain",
      mediaType: "text",
      extractPreview: undefined,
    });
    let allowRead = false;
    const host = createHost(storage, {
      readChatAttachmentContent: async (attachmentId: string) => {
        const record = storage.chatAttachments.get(attachmentId);
        if (!allowRead) {
          throw new Error("text extraction still pending");
        }
        return {
          bytes: Buffer.from("Recovered readable text", "utf8"),
          record,
        };
      },
    });

    const failed = await attachChatThreadKnowledgeAttachment(host, session.sessionId, {
      chatAttachmentId: "attachment-retry",
      retrievalMode: "full_text",
    });
    allowRead = true;
    const retried = await attachChatThreadKnowledgeAttachment(host, session.sessionId, {
      chatAttachmentId: "attachment-retry",
      retrievalMode: "full_text",
    });

    assert.equal(failed.attachmentId, retried.attachmentId);
    assert.equal(retried.ingestStatus, "ready");
    assert.equal(retried.errorMessage, undefined);
  });

  it("preserves case-sensitive URL paths when deduping thread knowledge sources", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-url-case");
    const host = createHost(storage, {
      knowledgeDocsIngest: async ({ source, namespace, title }) => {
        const document = storage.knowledge.createDocument(
          {
            namespace,
            sourceType: "url",
            sourceRef: source,
            title: title ?? source,
          },
          "2026-04-20T00:00:00.000Z",
        );
        storage.knowledge.appendChunks(
          document.docId,
          [{ content: source.includes("/Foo") ? "Upper path" : "Lower path" }],
          "2026-04-20T00:00:00.000Z",
        );
        return {
          document: { docId: document.docId },
          chunksSaved: 1,
        };
      },
    });

    const upper = await attachChatThreadKnowledgeAttachment(host, session.sessionId, {
      url: "https://example.com/Foo",
      retrievalMode: "full_text",
    });
    const lower = await attachChatThreadKnowledgeAttachment(host, session.sessionId, {
      url: "https://example.com/foo",
      retrievalMode: "full_text",
    });

    assert.notEqual(upper.attachmentId, lower.attachmentId);
  });

  it("collapses identical concurrent file attaches into one knowledge attachment", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-file-concurrent");
    seedAttachment(storage, session.sessionId, "attachment-concurrent", {
      fileName: "notes.txt",
      mimeType: "text/plain",
      mediaType: "text",
      extractPreview: "Concurrent readable text",
    });
    const host = createHost(storage);
    const originalListBySession = storage.chatThreadKnowledgeAttachments.listBySession.bind(
      storage.chatThreadKnowledgeAttachments,
    );
    storage.chatThreadKnowledgeAttachments.listBySession =
      (() => []) as typeof storage.chatThreadKnowledgeAttachments.listBySession;

    try {
      const [first, second] = await Promise.all([
        attachChatThreadKnowledgeAttachment(host, session.sessionId, {
          chatAttachmentId: "attachment-concurrent",
          retrievalMode: "full_text",
        }),
        attachChatThreadKnowledgeAttachment(host, session.sessionId, {
          chatAttachmentId: "attachment-concurrent",
          retrievalMode: "full_text",
        }),
      ]);

      assert.equal(first.attachmentId, second.attachmentId);
      assert.equal(originalListBySession(session.sessionId).length, 1);
    } finally {
      storage.chatThreadKnowledgeAttachments.listBySession = originalListBySession;
    }
  });

  it("collapses identical concurrent URL attaches into one knowledge attachment", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-url-concurrent");
    const host = createHost(storage, {
      knowledgeDocsIngest: async ({ source, namespace, title }) => {
        const document = storage.knowledge.createDocument(
          {
            namespace,
            sourceType: "url",
            sourceRef: source,
            title: title ?? source,
          },
          "2026-04-20T00:00:00.000Z",
        );
        storage.knowledge.appendChunks(
          document.docId,
          [{ content: "Concurrent url text" }],
          "2026-04-20T00:00:00.000Z",
        );
        return {
          document: { docId: document.docId },
          chunksSaved: 1,
        };
      },
    });
    const originalListBySession = storage.chatThreadKnowledgeAttachments.listBySession.bind(
      storage.chatThreadKnowledgeAttachments,
    );
    storage.chatThreadKnowledgeAttachments.listBySession =
      (() => []) as typeof storage.chatThreadKnowledgeAttachments.listBySession;

    try {
      const [first, second] = await Promise.all([
        attachChatThreadKnowledgeAttachment(host, session.sessionId, {
          url: "https://example.com/docs/release-notes",
          retrievalMode: "full_text",
        }),
        attachChatThreadKnowledgeAttachment(host, session.sessionId, {
          url: "https://example.com/docs/release-notes",
          retrievalMode: "full_text",
        }),
      ]);

      assert.equal(first.attachmentId, second.attachmentId);
      assert.equal(originalListBySession(session.sessionId).length, 1);
    } finally {
      storage.chatThreadKnowledgeAttachments.listBySession = originalListBySession;
    }
  });
});
