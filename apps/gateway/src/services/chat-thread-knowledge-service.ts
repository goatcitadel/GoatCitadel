import { createHash } from "node:crypto";
import type {
  ChatAttachmentRecord,
  ChatCitationRecord,
  ThreadKnowledgeAttachmentRecord,
  ThreadKnowledgeCitationRecord,
  ThreadKnowledgeRetrievalMode,
} from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";
import type { KnowledgeChunkRecord, Storage } from "@goatcitadel/storage";

const FULL_TEXT_SOURCE_CHAR_LIMIT = 12_000;
const FULL_TEXT_TOTAL_CHAR_BUDGET = 32_000;
const FULL_TEXT_ATTACHMENT_READ_CONCURRENCY = 4;

export interface ChatThreadKnowledgeDependencies {
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
  deps: ChatThreadKnowledgeDependencies,
  sessionId: string,
): ThreadKnowledgeAttachmentRecord[] {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "sessionId" });
  }
  deps.getSession(normalizedSessionId);
  return deps.storage.chatThreadKnowledgeAttachments.listBySession(normalizedSessionId);
}

export async function attachChatThreadKnowledgeAttachment(
  deps: ChatThreadKnowledgeDependencies,
  sessionId: string,
  input: AttachThreadKnowledgeAttachmentInput,
): Promise<ThreadKnowledgeAttachmentRecord> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "sessionId" });
  }
  deps.getSession(normalizedSessionId);
  const namespace = buildThreadKnowledgeNamespace(normalizedSessionId);
  const now = new Date().toISOString();

  if (input.chatAttachmentId?.trim()) {
    const attachment = deps.storage.chatAttachments.get(input.chatAttachmentId.trim());
    if (attachment.sessionId !== normalizedSessionId) {
      throw new ValidationError({ message: "Thread knowledge attachments must come from the same chat session." });
    }
    const existingAttachment = deps.storage.chatThreadKnowledgeAttachments
      .listBySession(normalizedSessionId)
      .find((item) => item.chatAttachmentId === attachment.attachmentId && item.retrievalMode === input.retrievalMode);
    if (existingAttachment?.ingestStatus === "ready") {
      return existingAttachment;
    }
    const created = existingAttachment
      ? resetThreadKnowledgeAttachmentForRetry(deps, existingAttachment, {
          sourceRef: attachment.fileName,
          title: input.title?.trim() || attachment.fileName,
          namespace: input.retrievalMode === "retrieval" ? namespace : undefined,
          chatAttachmentId: attachment.attachmentId,
          now,
        })
      : deps.storage.chatThreadKnowledgeAttachments.create({
          attachmentId: buildStableThreadKnowledgeAttachmentId([
            normalizedSessionId,
            attachment.attachmentId,
            input.retrievalMode,
          ]),
          sessionId: normalizedSessionId,
          sourceType: "file",
          sourceRef: attachment.fileName,
          title: input.title?.trim() || attachment.fileName,
          retrievalMode: input.retrievalMode,
          ingestStatus: "queued",
          namespace: input.retrievalMode === "retrieval" ? namespace : undefined,
          chatAttachmentId: attachment.attachmentId,
          createdAt: now,
          updatedAt: now,
        });
    try {
      const text = await extractAttachmentKnowledgeText(deps, attachment);
      if (!text.trim()) {
        throw new Error(
          input.retrievalMode === "full_text"
            ? "This attachment does not have readable text available for full-text use yet."
            : "This attachment does not have extracted text available for retrieval yet.",
        );
      }
      if (input.retrievalMode === "full_text") {
        return deps.storage.chatThreadKnowledgeAttachments.patch(
          created.attachmentId,
          {
            ingestStatus: "ready",
            chatAttachmentId: attachment.attachmentId,
            chunkCount: 1,
            lastIngestAt: now,
            errorMessage: "",
          },
          now,
        );
      }
      const document = deps.storage.knowledge.createDocument(
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
      const chunks = deps.storage.knowledge.appendChunks(
        document.docId,
        chunkKnowledgeText(text).map((content) => ({
          content,
        })),
        now,
      );
      return deps.storage.chatThreadKnowledgeAttachments.patch(
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
      return deps.storage.chatThreadKnowledgeAttachments.patch(
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
  const normalizedUrlKey = normalizeKnowledgeUrlKey(url);
  const existingUrlAttachment = deps.storage.chatThreadKnowledgeAttachments
    .listBySession(normalizedSessionId)
    .find(
      (item) =>
        item.sourceType === "url" &&
        item.retrievalMode === input.retrievalMode &&
        normalizeKnowledgeUrlKey(item.sourceRef) === normalizedUrlKey,
    );
  if (existingUrlAttachment?.ingestStatus === "ready") {
    return existingUrlAttachment;
  }
  const created = existingUrlAttachment
    ? resetThreadKnowledgeAttachmentForRetry(deps, existingUrlAttachment, {
        sourceRef: url,
        title: input.title?.trim() || url,
        namespace,
        now,
      })
    : deps.storage.chatThreadKnowledgeAttachments.create({
        attachmentId: buildStableThreadKnowledgeAttachmentId([
          normalizedSessionId,
          normalizedUrlKey,
          input.retrievalMode,
        ]),
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
    const result = await deps.knowledgeDocsIngest({
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
    const documentText = document?.docId ? resolveDocumentKnowledgeText(deps, document.docId) : "";
    const chunkCount = document?.docId ? deps.storage.knowledge.listChunksByDocument(document.docId, 500).length : 0;
    const usableChunkCount = Math.max(chunksSaved ?? 0, chunkCount);
    if (!document?.docId || usableChunkCount <= 0 || !documentText.trim()) {
      throw new Error("This source did not produce readable knowledge content.");
    }
    return deps.storage.chatThreadKnowledgeAttachments.patch(
      created.attachmentId,
      {
        ingestStatus: "ready",
        namespace,
        documentId: document.docId,
        chunkCount: usableChunkCount,
        lastIngestAt: now,
        errorMessage: "",
      },
      now,
    );
  } catch (error) {
    return deps.storage.chatThreadKnowledgeAttachments.patch(
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
  deps: ChatThreadKnowledgeDependencies,
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
  deps.getSession(normalizedSessionId);
  const current = deps.storage.chatThreadKnowledgeAttachments.get(normalizedAttachmentId);
  if (current.sessionId !== normalizedSessionId) {
    throw new ValidationError({ message: "Thread knowledge attachment does not belong to this session." });
  }
  const documentId = current.documentId?.trim() || undefined;
  const deleted = deps.storage.chatThreadKnowledgeAttachments.delete(normalizedAttachmentId);
  if (deleted && documentId) {
    const remainingReferences = deps.storage.chatThreadKnowledgeAttachments.listByDocumentId(documentId);
    if (remainingReferences.length === 0) {
      deps.storage.knowledge.deleteDocument(documentId);
    }
  }
  return {
    deleted,
    attachmentId: normalizedAttachmentId,
  };
}

export async function resolveThreadKnowledgeContext(
  deps: ChatThreadKnowledgeDependencies,
  sessionId: string,
  query: string,
): Promise<ResolvedThreadKnowledgeContext> {
  const attachments = deps.storage.chatThreadKnowledgeAttachments
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
  const notices: string[] = [];
  let remainingFullTextBudget = FULL_TEXT_TOTAL_CHAR_BUDGET;
  const now = new Date().toISOString();

  const fullTextAttachmentContents = await mapWithConcurrency(
    fullTextAttachments,
    FULL_TEXT_ATTACHMENT_READ_CONCURRENCY,
    async (attachment) => ({
      attachment,
      text: await resolveFullTextAttachmentContent(deps, attachment),
    }),
  );
  for (const { attachment, text } of fullTextAttachmentContents) {
    if (!text.trim()) {
      deps.storage.chatThreadKnowledgeAttachments.patch(
        attachment.attachmentId,
        {
          ingestStatus: "failed",
          errorMessage: "This source no longer has readable content available for full-text use.",
          lastIngestAt: now,
          chunkCount: 0,
        },
        now,
      );
      notices.push(`Skipped ${attachment.title} because no readable full-text content was available.`);
      continue;
    }
    if (remainingFullTextBudget <= 0) {
      notices.push(`Skipped ${attachment.title} because the thread knowledge full-text budget was exhausted.`);
      continue;
    }
    const excerpt = text.slice(0, Math.min(FULL_TEXT_SOURCE_CHAR_LIMIT, remainingFullTextBudget)).trim();
    if (!excerpt) {
      notices.push(`Skipped ${attachment.title} because the remaining full-text budget was exhausted.`);
      continue;
    }
    if (excerpt.length < text.trim().length) {
      notices.push(`Truncated ${attachment.title} to stay within the full-text context budget.`);
    }
    remainingFullTextBudget = Math.max(0, remainingFullTextBudget - excerpt.length);
    fullTextBlocks.push(
      [
        `Source: ${attachment.title}`,
        attachment.sourceType === "url" ? `Reference: ${attachment.sourceRef}` : undefined,
        excerpt,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    citations.push(
      buildKnowledgeCitationRecord(attachment, {
        excerpt: excerpt.slice(0, 320),
      }),
    );
  }

  if (retrievalAttachments.length > 0 && query.trim()) {
    const namespace = buildThreadKnowledgeNamespace(sessionId);
    const retrievalReadyAttachments = retrievalAttachments.filter((item) => {
      if (item.documentId?.trim()) {
        return true;
      }
      deps.storage.chatThreadKnowledgeAttachments.patch(
        item.attachmentId,
        {
          ingestStatus: "failed",
          errorMessage: "This retrieval source is missing its ingested document.",
          lastIngestAt: now,
          chunkCount: 0,
        },
        now,
      );
      notices.push(`Skipped ${item.title} because its retrieval document is missing.`);
      return false;
    });
    if (retrievalReadyAttachments.length > 0) {
      try {
        const queryResult = toPlainRecord(
          await deps.knowledgeEmbeddingsQuery({
            namespace,
            query: query.trim(),
            limit: Math.max(4, Math.min(12, retrievalReadyAttachments.length * 4)),
            sessionId,
          }),
        );
        const docsById = new Map(
          deps.storage.knowledge.listDocuments(namespace, 500).map((document) => [document.docId, document] as const),
        );
        const retrievalByDocId = new Map(
          retrievalReadyAttachments.filter((item) => item.documentId).map((item) => [item.documentId!, item] as const),
        );
        const chunksByDocumentId = new Map<string, KnowledgeChunkRecord[]>();
        const listChunksByDocumentCached = (docId: string): KnowledgeChunkRecord[] => {
          const existing = chunksByDocumentId.get(docId);
          if (existing) {
            return existing;
          }
          const chunks = deps.storage.knowledge.listChunksByDocument(docId, 200);
          chunksByDocumentId.set(docId, chunks);
          return chunks;
        };
        const groupedSnippets: string[] = [];
        for (const item of readEmbeddingItems(queryResult)) {
          const attachment = retrievalByDocId.get(item.docId);
          if (!attachment) {
            continue;
          }
          const doc = docsById.get(item.docId);
          const chunk = findChunkById(listChunksByDocumentCached(item.docId), item.chunkId);
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notices.push("Skipped retrieval-backed thread knowledge because retrieval failed for this turn.");
        notices.push(`Retrieval error: ${message}`);
      }
    }
  }

  return {
    systemInstruction:
      fullTextBlocks.length > 0 || notices.length > 0
        ? [
            "Thread knowledge context:",
            ...(notices.length > 0
              ? ["Notices:", ...notices.map((notice) => `- ${notice}`), "Treat skipped sources as unavailable."]
              : []),
            ...fullTextBlocks,
          ].join("\n\n")
        : undefined,
    citations,
    attachments: deps.storage.chatThreadKnowledgeAttachments.listBySession(sessionId),
  };
}

export function buildThreadKnowledgeNamespace(sessionId: string): string {
  return `chat-session:${sessionId}:knowledge`;
}

function resetThreadKnowledgeAttachmentForRetry(
  deps: ChatThreadKnowledgeDependencies,
  attachment: ThreadKnowledgeAttachmentRecord,
  input: {
    sourceRef: string;
    title: string;
    namespace?: string;
    chatAttachmentId?: string;
    now: string;
  },
): ThreadKnowledgeAttachmentRecord {
  const currentDocumentId = attachment.documentId?.trim() || undefined;
  if (currentDocumentId) {
    const remainingReferences = deps.storage.chatThreadKnowledgeAttachments
      .listByDocumentId(currentDocumentId)
      .filter((item) => item.attachmentId !== attachment.attachmentId);
    if (remainingReferences.length === 0) {
      deps.storage.knowledge.deleteDocument(currentDocumentId);
    }
  }
  return deps.storage.chatThreadKnowledgeAttachments.patch(
    attachment.attachmentId,
    {
      sourceRef: input.sourceRef,
      title: input.title,
      ingestStatus: "queued",
      chunkCount: 0,
      namespace: input.namespace ?? "",
      chatAttachmentId: input.chatAttachmentId ?? "",
      documentId: "",
      errorMessage: "",
      lastIngestAt: input.now,
    },
    input.now,
  );
}

async function resolveFullTextAttachmentContent(
  deps: ChatThreadKnowledgeDependencies,
  attachment: ThreadKnowledgeAttachmentRecord,
): Promise<string> {
  if (attachment.documentId) {
    return resolveDocumentKnowledgeText(deps, attachment.documentId);
  }
  if (!attachment.chatAttachmentId) {
    return "";
  }
  const record = deps.storage.chatAttachments.get(attachment.chatAttachmentId);
  return extractAttachmentKnowledgeText(deps, record);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index] as T, index);
      }
    }),
  );
  return results;
}

async function extractAttachmentKnowledgeText(
  deps: ChatThreadKnowledgeDependencies,
  attachment: ChatAttachmentRecord,
): Promise<string> {
  const transcriptOrOcr =
    attachment.transcriptText?.trim() || attachment.ocrText?.trim() || attachment.extractPreview?.trim();
  if (looksTextLikeMimeType(attachment.mimeType)) {
    try {
      const content = await deps.readChatAttachmentContent(attachment.attachmentId);
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

function resolveDocumentKnowledgeText(deps: ChatThreadKnowledgeDependencies, documentId: string): string {
  return deps.storage.knowledge
    .listChunksByDocument(documentId, 500)
    .map((chunk) => chunk.content.trim())
    .filter(Boolean)
    .join("\n\n");
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

function normalizeKnowledgeUrlKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function buildStableThreadKnowledgeAttachmentId(parts: string[]): string {
  const hash = createHash("sha256");
  hash.update("thread-knowledge-attachment");
  for (const part of parts) {
    hash.update("\u0000");
    hash.update(part.trim());
  }
  return `tkatt-${hash.digest("hex")}`;
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
    sourceType: attachment.sourceType === "url" ? "web" : "file",
    knowledge,
  };
}
