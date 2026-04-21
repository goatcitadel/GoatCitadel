import { randomUUID } from "node:crypto";
import type {
  ChatAttachmentRecord,
  ChatCitationRecord,
  ThreadKnowledgeAttachmentRecord,
  ThreadKnowledgeCitationRecord,
  ThreadKnowledgeRetrievalMode,
} from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";
import type { KnowledgeChunkRecord, Storage } from "@goatcitadel/storage";

export interface ChatThreadKnowledgeHost {
  readonly storage: Pick<Storage, "chatAttachments" | "chatThreadKnowledgeAttachments" | "gatewaySql" | "knowledge">;
  getSession(sessionId: string): unknown;
  readChatAttachmentContent(attachmentId: string): Promise<{ bytes: Buffer; record: ChatAttachmentRecord }>;
  knowledgeDocsIngest(input: {
    sourceType: "url";
    source: string;
    namespace: string;
    title?: string;
    metadata?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<unknown>;
  knowledgeEmbeddingsQuery(input: {
    namespace?: string;
    query: string;
    limit?: number;
    sessionId?: string;
  }): Promise<unknown>;
}

export interface AttachThreadKnowledgeAttachmentInput {
  chatAttachmentId?: string;
  url?: string;
  title?: string;
  retrievalMode: ThreadKnowledgeRetrievalMode;
}

export interface ResolvedThreadKnowledgeContext {
  systemInstruction?: string;
  citations: ChatCitationRecord[];
  attachments: ThreadKnowledgeAttachmentRecord[];
}

export function listChatThreadKnowledgeAttachments(
  host: ChatThreadKnowledgeHost,
  sessionId: string,
): ThreadKnowledgeAttachmentRecord[] {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "sessionId" });
  }
  host.getSession(normalizedSessionId);
  return host.storage.chatThreadKnowledgeAttachments.listBySession(normalizedSessionId);
}

export async function attachChatThreadKnowledgeAttachment(
  host: ChatThreadKnowledgeHost,
  sessionId: string,
  input: AttachThreadKnowledgeAttachmentInput,
): Promise<ThreadKnowledgeAttachmentRecord> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "sessionId" });
  }
  host.getSession(normalizedSessionId);
  const namespace = buildThreadKnowledgeNamespace(normalizedSessionId);
  const now = new Date().toISOString();

  if (input.chatAttachmentId?.trim()) {
    const attachment = host.storage.chatAttachments.get(input.chatAttachmentId.trim());
    if (attachment.sessionId !== normalizedSessionId) {
      throw new ValidationError({ message: "Thread knowledge attachments must come from the same chat session." });
    }
    const created = host.storage.chatThreadKnowledgeAttachments.create({
      attachmentId: randomUUID(),
      sessionId: normalizedSessionId,
      sourceType: "file",
      sourceRef: attachment.fileName,
      title: input.title?.trim() || attachment.fileName,
      retrievalMode: input.retrievalMode,
      ingestStatus: input.retrievalMode === "full_text" ? "ready" : "queued",
      namespace: input.retrievalMode === "retrieval" ? namespace : undefined,
      chatAttachmentId: attachment.attachmentId,
      createdAt: now,
      updatedAt: now,
    });
    if (input.retrievalMode === "full_text") {
      return created;
    }
    try {
      const text = await extractAttachmentKnowledgeText(host, attachment);
      if (!text.trim()) {
        throw new Error("This attachment does not have extracted text available for retrieval yet.");
      }
      const document = host.storage.knowledge.createDocument(
        {
          namespace,
          sourceType: "file",
          sourceRef: attachment.fileName,
          title: input.title?.trim() || attachment.fileName,
          metadata: {
            sessionId: normalizedSessionId,
            chatAttachmentId: attachment.attachmentId,
          },
        },
        now,
      );
      const chunks = host.storage.knowledge.appendChunks(
        document.docId,
        chunkKnowledgeText(text).map((content) => ({
          content,
        })),
        now,
      );
      return host.storage.chatThreadKnowledgeAttachments.patch(
        created.attachmentId,
        {
          ingestStatus: "ready",
          namespace,
          documentId: document.docId,
          chatAttachmentId: attachment.attachmentId,
          chunkCount: chunks.length,
          lastIngestAt: now,
          errorMessage: "",
        },
        now,
      );
    } catch (error) {
      return host.storage.chatThreadKnowledgeAttachments.patch(
        created.attachmentId,
        {
          ingestStatus: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
          lastIngestAt: now,
        },
        now,
      );
    }
  }

  const url = input.url?.trim();
  if (!url) {
    throw new ValidationError({ message: "Either chatAttachmentId or url is required." });
  }
  const created = host.storage.chatThreadKnowledgeAttachments.create({
    attachmentId: randomUUID(),
    sessionId: normalizedSessionId,
    sourceType: "url",
    sourceRef: url,
    title: input.title?.trim() || url,
    retrievalMode: input.retrievalMode,
    ingestStatus: "queued",
    namespace,
    createdAt: now,
    updatedAt: now,
  });
  try {
    const result = await host.knowledgeDocsIngest({
      sourceType: "url",
      source: url,
      namespace,
      title: input.title?.trim() || url,
      metadata: {
        sessionId: normalizedSessionId,
        retrievalMode: input.retrievalMode,
      },
      sessionId: normalizedSessionId,
    });
    const normalizedResult = toPlainRecord(result);
    const document = readKnowledgeDocumentResult(normalizedResult);
    const chunksSaved = readKnowledgeChunksSaved(normalizedResult);
    return host.storage.chatThreadKnowledgeAttachments.patch(
      created.attachmentId,
      {
        ingestStatus: "ready",
        namespace,
        documentId: document?.docId,
        chunkCount: chunksSaved,
        lastIngestAt: now,
        errorMessage: "",
      },
      now,
    );
  } catch (error) {
    return host.storage.chatThreadKnowledgeAttachments.patch(
      created.attachmentId,
      {
        ingestStatus: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        lastIngestAt: now,
      },
      now,
    );
  }
}

export function removeChatThreadKnowledgeAttachment(
  host: ChatThreadKnowledgeHost,
  sessionId: string,
  attachmentId: string,
): { deleted: boolean; attachmentId: string } {
  const normalizedSessionId = sessionId.trim();
  const normalizedAttachmentId = attachmentId.trim();
  if (!normalizedSessionId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "sessionId" });
  }
  if (!normalizedAttachmentId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "attachmentId" });
  }
  host.getSession(normalizedSessionId);
  const current = host.storage.chatThreadKnowledgeAttachments.get(normalizedAttachmentId);
  if (current.sessionId !== normalizedSessionId) {
    throw new ValidationError({ message: "Thread knowledge attachment does not belong to this session." });
  }
  return {
    deleted: host.storage.chatThreadKnowledgeAttachments.delete(normalizedAttachmentId),
    attachmentId: normalizedAttachmentId,
  };
}

export async function resolveThreadKnowledgeContext(
  host: ChatThreadKnowledgeHost,
  sessionId: string,
  query: string,
): Promise<ResolvedThreadKnowledgeContext> {
  const attachments = host.storage.chatThreadKnowledgeAttachments
    .listBySession(sessionId)
    .filter((item) => item.ingestStatus === "ready");
  if (attachments.length === 0) {
    return {
      citations: [],
      attachments: [],
    };
  }

  const fullTextAttachments = attachments.filter((item) => item.retrievalMode === "full_text");
  const retrievalAttachments = attachments.filter((item) => item.retrievalMode === "retrieval");
  const fullTextBlocks: string[] = [];
  const citations: ChatCitationRecord[] = [];

  for (const attachment of fullTextAttachments) {
    const text = await resolveFullTextAttachmentContent(host, attachment);
    if (!text.trim()) {
      continue;
    }
    fullTextBlocks.push(
      [
        `Source: ${attachment.title}`,
        attachment.sourceType === "url" ? `Reference: ${attachment.sourceRef}` : undefined,
        text.slice(0, 12_000),
      ]
        .filter(Boolean)
        .join("\n"),
    );
    citations.push(
      buildKnowledgeCitationRecord(attachment, {
        excerpt: text.slice(0, 320),
      }),
    );
  }

  if (retrievalAttachments.length > 0 && query.trim()) {
    const namespace = buildThreadKnowledgeNamespace(sessionId);
    const queryResult = toPlainRecord(
      await host.knowledgeEmbeddingsQuery({
        namespace,
        query: query.trim(),
        limit: Math.max(4, Math.min(12, retrievalAttachments.length * 4)),
        sessionId,
      }),
    );
    const docsById = new Map(
      host.storage.knowledge.listDocuments(namespace, 500).map((document) => [document.docId, document] as const),
    );
    const retrievalByDocId = new Map(
      retrievalAttachments.filter((item) => item.documentId).map((item) => [item.documentId!, item] as const),
    );
    const groupedSnippets: string[] = [];
    for (const item of readEmbeddingItems(queryResult)) {
      const attachment = retrievalByDocId.get(item.docId);
      if (!attachment) {
        continue;
      }
      const doc = docsById.get(item.docId);
      const chunk = findChunkById(host.storage.knowledge.listChunksByDocument(item.docId, 200), item.chunkId);
      citations.push(
        buildKnowledgeCitationRecord(attachment, {
          title: doc?.title ?? attachment.title,
          sourceRef: doc?.sourceRef ?? attachment.sourceRef,
          chunk,
          excerpt: item.snippet,
        }),
      );
      groupedSnippets.push([`Source: ${doc?.title ?? attachment.title}`, `Snippet: ${item.snippet}`].join("\n"));
      if (groupedSnippets.length >= 6) {
        break;
      }
    }
    if (groupedSnippets.length > 0) {
      fullTextBlocks.push(["Retrieved thread knowledge:", ...groupedSnippets].join("\n\n"));
    }
  }

  return {
    systemInstruction:
      fullTextBlocks.length > 0 ? ["Thread knowledge context:", ...fullTextBlocks].join("\n\n") : undefined,
    citations,
    attachments,
  };
}

export function buildThreadKnowledgeNamespace(sessionId: string): string {
  return `chat-session:${sessionId}:knowledge`;
}

async function resolveFullTextAttachmentContent(
  host: ChatThreadKnowledgeHost,
  attachment: ThreadKnowledgeAttachmentRecord,
): Promise<string> {
  if (attachment.documentId) {
    return host.storage.knowledge
      .listChunksByDocument(attachment.documentId, 200)
      .map((chunk) => chunk.content.trim())
      .filter(Boolean)
      .join("\n\n");
  }
  if (!attachment.chatAttachmentId) {
    return "";
  }
  const record = host.storage.chatAttachments.get(attachment.chatAttachmentId);
  return extractAttachmentKnowledgeText(host, record);
}

async function extractAttachmentKnowledgeText(
  host: ChatThreadKnowledgeHost,
  attachment: ChatAttachmentRecord,
): Promise<string> {
  const transcriptOrOcr =
    attachment.transcriptText?.trim() || attachment.ocrText?.trim() || attachment.extractPreview?.trim();
  if (looksTextLikeMimeType(attachment.mimeType)) {
    try {
      const content = await host.readChatAttachmentContent(attachment.attachmentId);
      const decoded = content.bytes.toString("utf8").trim();
      if (looksUsefulDecodedText(decoded)) {
        return decoded.slice(0, 40_000);
      }
    } catch {
      // Fall back to extracted text below.
    }
  }
  return transcriptOrOcr ?? "";
}

function chunkKnowledgeText(value: string, targetChars = 1_400, overlapChars = 180, maxChunks = 120): string[] {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length && chunks.length < maxChunks) {
    const end = Math.min(normalized.length, cursor + targetChars);
    const chunk = normalized.slice(cursor, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (end >= normalized.length) {
      break;
    }
    cursor = Math.max(end - overlapChars, cursor + 1);
  }
  return chunks;
}

function looksTextLikeMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("yaml") ||
    normalized.includes("javascript") ||
    normalized.includes("typescript") ||
    normalized.includes("markdown")
  );
}

function looksUsefulDecodedText(value: string): boolean {
  if (!value.trim()) {
    return false;
  }
  const printableChars = [...value].filter((char) => {
    const code = char.charCodeAt(0);
    return code === 10 || code === 13 || code === 9 || (code >= 32 && code <= 126);
  }).length;
  return printableChars / Math.max(1, value.length) >= 0.85;
}

function readKnowledgeDocumentResult(value: Record<string, unknown>): { docId?: string } | undefined {
  const document = value.document;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return undefined;
  }
  return typeof (document as { docId?: unknown }).docId === "string"
    ? { docId: (document as { docId: string }).docId }
    : undefined;
}

function readKnowledgeChunksSaved(value: Record<string, unknown>): number | undefined {
  return typeof value.chunksSaved === "number" && Number.isFinite(value.chunksSaved)
    ? Math.max(0, Math.floor(value.chunksSaved))
    : undefined;
}

function readEmbeddingItems(value: Record<string, unknown>): Array<{
  chunkId: string;
  docId: string;
  score: number;
  snippet: string;
}> {
  if (!Array.isArray(value.items)) {
    return [];
  }
  return value.items
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return undefined;
      }
      const record = item as { chunkId?: unknown; docId?: unknown; score?: unknown; snippet?: unknown };
      if (typeof record.chunkId !== "string" || typeof record.docId !== "string") {
        return undefined;
      }
      return {
        chunkId: record.chunkId,
        docId: record.docId,
        score: typeof record.score === "number" ? record.score : 0,
        snippet: typeof record.snippet === "string" ? record.snippet : "",
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score);
}

function toPlainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function findChunkById(chunks: KnowledgeChunkRecord[], chunkId: string): KnowledgeChunkRecord | undefined {
  return chunks.find((chunk) => chunk.chunkId === chunkId);
}

function buildKnowledgeCitationRecord(
  attachment: ThreadKnowledgeAttachmentRecord,
  input: {
    title?: string;
    sourceRef?: string;
    chunk?: KnowledgeChunkRecord;
    excerpt?: string;
  } = {},
): ChatCitationRecord {
  const sourceRef = input.sourceRef ?? attachment.sourceRef;
  const knowledge: ThreadKnowledgeCitationRecord = {
    attachmentId: attachment.attachmentId,
    sourceRef,
    title: input.title ?? attachment.title,
    sectionLabel: input.chunk ? `Chunk ${input.chunk.seq + 1}` : undefined,
    chunkId: input.chunk?.chunkId,
    excerpt: input.excerpt,
    retrievalMode: attachment.retrievalMode,
  };
  return {
    citationId: `knowledge:${attachment.attachmentId}:${input.chunk?.chunkId ?? attachment.retrievalMode}`,
    title: input.title ?? attachment.title,
    url:
      attachment.sourceType === "url"
        ? attachment.sourceRef
        : `attachment://${attachment.chatAttachmentId ?? attachment.attachmentId}`,
    snippet: input.excerpt,
    sourceType: "file",
    knowledge,
  };
}
