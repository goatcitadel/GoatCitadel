import {
  CHAT_ROUTED_CONTEXT_TOOL_MAX_MATCHES,
  CHAT_ROUTED_CONTEXT_TOOL_MAX_OUTPUT_BYTES,
  CHAT_ROUTED_CONTEXT_TOOL_MAX_QUERY_LENGTH,
  CHAT_ROUTED_CONTEXT_TOOL_MAX_READ_LINES,
  CHAT_ROUTED_CONTEXT_TOOL_NAMES,
  type ChatRoutedContextSnapshotEntry,
  type ChatRoutedContextSnapshotRecord,
  type ChatRoutedContextToolListResult,
  type ChatRoutedContextToolMatch,
  type ChatRoutedContextToolName,
  type ChatRoutedContextToolReadRangeResult,
  type ChatRoutedContextToolSearchResult,
  type ChatRoutedContextToolSourceReceipt,
  type ToolInvokeRequest,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  currentEmbeddingProfile,
  generateEmbedding,
  type AcquireLocalEmbeddingLease,
  type EmbeddingRuntimeOptions,
  type PrepareEmbeddingUsageDispatch,
} from "../local-embeddings.js";

const CONTEXT_TOOL_NAMES = new Set<string>(CHAT_ROUTED_CONTEXT_TOOL_NAMES);
const AUTHORITY_OVERRIDE_KEYS = new Set([
  "sessionId",
  "turnId",
  "workspaceId",
  "snapshotId",
  "snapshotHash",
  "routedContextSnapshotId",
  "routedContextSnapshotHash",
]);
const MAX_LINE_TEXT_BYTES = 2_048;
const MAX_EPHEMERAL_EMBEDDING_CHUNKS = 128;
const EMBEDDING_CONCURRENCY = 4;

export interface RoutedContextExecutorDeps {
  acquireLocalEmbeddingLease?: AcquireLocalEmbeddingLease;
  prepareEmbeddingUsageDispatch?: PrepareEmbeddingUsageDispatch;
}
export function isRoutedContextToolName(toolName: string): toolName is ChatRoutedContextToolName {
  return CONTEXT_TOOL_NAMES.has(toolName);
}

export async function executeRoutedContextTool(
  request: ToolInvokeRequest,
  storage: AsyncStorage,
  deps: RoutedContextExecutorDeps = {},
): Promise<Record<string, unknown>> {
  assertNoAuthorityOverrides(request.args);
  const snapshot = await resolveBoundSnapshot(request, storage);
  const eligibleEntries = snapshot.entries.filter(isEligibleEntry);
  if (eligibleEntries.length === 0) {
    throw new Error("Attached-context tools are unavailable because this turn has no admitted snapshot text.");
  }

  switch (request.toolName) {
    case "context.list":
      return { ...listSnapshot(snapshot) } satisfies ChatRoutedContextToolListResult;
    case "context.grep":
      return {
        ...grepSnapshot(snapshot, eligibleEntries, request.args),
      } satisfies ChatRoutedContextToolSearchResult;
    case "context.query":
      return {
        ...(await querySnapshot(snapshot, eligibleEntries, request, deps)),
      } satisfies ChatRoutedContextToolSearchResult;
    case "context.read_range":
      return {
        ...readSnapshotRange(snapshot, eligibleEntries, request.args),
      } satisfies ChatRoutedContextToolReadRangeResult;
    default:
      throw new Error(`Unsupported routed-context tool: ${request.toolName}`);
  }
}

export async function listAvailableRoutedContextTools(
  request: ToolInvokeRequest,
  storage: AsyncStorage,
): Promise<ChatRoutedContextToolName[]> {
  if (
    !request.turnId ||
    !request.workspaceId ||
    !request.routedContextSnapshotId ||
    !request.routedContextSnapshotHash
  ) {
    return [];
  }
  try {
    const snapshot = await resolveBoundSnapshot(request, storage);
    return snapshot.entries.some(isEligibleEntry) ? [...CHAT_ROUTED_CONTEXT_TOOL_NAMES] : [];
  } catch {
    return [];
  }
}

async function resolveBoundSnapshot(
  request: ToolInvokeRequest,
  storage: AsyncStorage,
): Promise<ChatRoutedContextSnapshotRecord> {
  const turnId = requireServerBinding(request.turnId, "turnId");
  const snapshotId = requireServerBinding(request.routedContextSnapshotId, "routedContextSnapshotId");
  const snapshotHash = requireServerBinding(request.routedContextSnapshotHash, "routedContextSnapshotHash");
  const workspaceId = requireServerBinding(request.workspaceId, "workspaceId");
  const snapshot = await storage.routedContextSnapshots.get(snapshotId);
  if (
    snapshot.turnId !== turnId ||
    snapshot.sessionId !== request.sessionId ||
    snapshot.workspaceId !== workspaceId ||
    snapshot.snapshotHash !== snapshotHash
  ) {
    throw new Error("Attached-context snapshot binding does not match the active server-authored turn scope.");
  }
  const sessionWorkspaceId = (await storage.chatSessionMeta.get(request.sessionId))?.workspaceId;
  if (sessionWorkspaceId !== workspaceId) {
    throw new Error("Attached-context snapshot workspace does not match the active Chat session.");
  }
  if (snapshot.entries.some((entry) => entry.sourceWorkspaceId && entry.sourceWorkspaceId !== workspaceId)) {
    throw new Error("Attached-context snapshot contains a source from another workspace.");
  }
  return snapshot;
}

function listSnapshot(snapshot: ChatRoutedContextSnapshotRecord): ChatRoutedContextToolListResult {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    entries: snapshot.entries.map((entry) => ({
      entryIndex: entry.index,
      sourceRef: entry.ref,
      sourceKind: entry.kind,
      sourceLabel: entry.label,
      disposition: entry.disposition,
      sourceHash: entry.sourceHash,
      admittedBytes: entry.admittedBytes,
      admittedTokens: entry.admittedTokens,
      lineCount: isEligibleEntry(entry) ? splitLines(entry.admittedText).length : 0,
      eligible: isEligibleEntry(entry),
    })),
  };
}

function grepSnapshot(
  snapshot: ChatRoutedContextSnapshotRecord,
  eligibleEntries: ChatRoutedContextSnapshotEntry[],
  args: Record<string, unknown>,
): ChatRoutedContextToolSearchResult {
  const pattern = requireBoundedText(args.pattern, "pattern");
  const caseSensitive = readOptionalBoolean(args.caseSensitive, "caseSensitive") ?? false;
  const limit = readLimit(args.limit);
  const entries = selectEntries(eligibleEntries, args.entryIndex);
  const needle = caseSensitive ? pattern : pattern.toLocaleLowerCase("en-US");
  const matches: ChatRoutedContextToolMatch[] = [];
  let totalBytes = 0;
  let truncated = false;

  outer: for (const entry of entries) {
    const lines = splitLines(entry.admittedText);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const haystack = caseSensitive ? line : line.toLocaleLowerCase("en-US");
      if (!haystack.includes(needle)) continue;
      const text = truncateUtf8(line, MAX_LINE_TEXT_BYTES).text;
      const nextBytes = Buffer.byteLength(text, "utf8");
      if (matches.length >= limit || totalBytes + nextBytes > CHAT_ROUTED_CONTEXT_TOOL_MAX_OUTPUT_BYTES) {
        truncated = true;
        break outer;
      }
      matches.push({ receipt: buildReceipt(snapshot, entry, index + 1, index + 1), text });
      totalBytes += nextBytes;
    }
  }
  return {
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    retrievalMode: "literal",
    matches,
    truncated,
  };
}

async function querySnapshot(
  snapshot: ChatRoutedContextSnapshotRecord,
  eligibleEntries: ChatRoutedContextSnapshotEntry[],
  request: ToolInvokeRequest,
  deps: RoutedContextExecutorDeps,
): Promise<ChatRoutedContextToolSearchResult> {
  const args = request.args;
  const query = requireBoundedText(args.query, "query");
  const entries = selectEntries(eligibleEntries, args.entryIndex);
  const limit = readLimit(args.limit);
  const normalizedQuery = normalizeLexicalText(query);
  const terms = [...new Set(normalizedQuery.split(" ").filter((term) => term.length > 1))];
  if (terms.length === 0) {
    throw new Error("query must contain at least one searchable term.");
  }
  const lexical = buildLexicalQueryResult(snapshot, entries, query, terms, limit);
  if (currentEmbeddingProfile().provider === "pseudo") return lexical;

  const queryEmbedding = await generateEmbedding(
    query,
    undefined,
    undefined,
    embeddingRuntimeOptions(request, deps, "embedding_query"),
  );
  if (queryEmbedding.metadata.provider === "pseudo") return lexical;

  const chunks = buildEphemeralChunks(entries);
  const embeddedChunks: Array<{
    entry: ChatRoutedContextSnapshotEntry;
    startLine: number;
    endLine: number;
    text: string;
    embedding: number[];
    order: number;
  }> = [];
  const usageEventIds = new Set(queryEmbedding.modelUsageEventIds ?? []);
  for (let offset = 0; offset < chunks.length; offset += EMBEDDING_CONCURRENCY) {
    const batch = chunks.slice(offset, offset + EMBEDDING_CONCURRENCY);
    const generated = await Promise.all(
      batch.map(async (chunk) => ({
        chunk,
        generated: await generateEmbedding(
          chunk.text,
          undefined,
          undefined,
          embeddingRuntimeOptions(request, deps, "embedding_repair"),
        ),
      })),
    );
    for (const item of generated) {
      for (const eventId of item.generated.modelUsageEventIds ?? []) usageEventIds.add(eventId);
      if (
        item.generated.metadata.provider !== queryEmbedding.metadata.provider ||
        item.generated.embedding.length !== queryEmbedding.embedding.length
      ) {
        continue;
      }
      embeddedChunks.push({ ...item.chunk, embedding: item.generated.embedding });
    }
  }
  if (embeddedChunks.length === 0) return lexical;

  const hybridCandidates = embeddedChunks.map((chunk) => {
    const lexicalScore = scoreLexicalText(chunk.text, normalizeLexicalText(query), terms);
    const semanticScore = Math.max(0, cosineSimilarity(queryEmbedding.embedding, chunk.embedding));
    return {
      receipt: buildReceipt(snapshot, chunk.entry, chunk.startLine, chunk.endLine),
      text: truncateUtf8(chunk.text, MAX_LINE_TEXT_BYTES).text,
      score: Number((semanticScore * 0.65 + (Math.min(lexicalScore, 3) / 3) * 0.35).toFixed(4)),
      order: chunk.order,
    };
  });
  const selected = selectBoundedMatches(hybridCandidates, limit);
  return {
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    retrievalMode: "hybrid",
    matches: selected.matches,
    truncated: selected.truncated || chunks.length >= MAX_EPHEMERAL_EMBEDDING_CHUNKS,
    ...(usageEventIds.size > 0 ? { modelUsageEventIds: [...usageEventIds].sort() } : {}),
  };
}

function buildLexicalQueryResult(
  snapshot: ChatRoutedContextSnapshotRecord,
  entries: ChatRoutedContextSnapshotEntry[],
  query: string,
  terms: string[],
  limit: number,
): ChatRoutedContextToolSearchResult {
  const normalizedQuery = normalizeLexicalText(query);
  const candidates: Array<ChatRoutedContextToolMatch & { order: number }> = [];
  let order = 0;
  for (const entry of entries) {
    const lines = splitLines(entry.admittedText);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const normalizedLine = normalizeLexicalText(line);
      if (!normalizedLine) continue;
      const score = scoreLexicalText(line, normalizedQuery, terms);
      if (score === 0) continue;
      candidates.push({
        receipt: buildReceipt(snapshot, entry, index + 1, index + 1),
        text: truncateUtf8(line, MAX_LINE_TEXT_BYTES).text,
        score,
        order,
      });
      order += 1;
    }
  }
  const selected = selectBoundedMatches(candidates, limit);
  return {
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    // No global vector store is consulted. Until an ephemeral embedding hook is
    // composed, retrieval is deterministic lexical fallback over frozen bytes.
    retrievalMode: "lexical_fallback",
    matches: selected.matches,
    truncated: selected.truncated,
  };
}

function buildEphemeralChunks(entries: ChatRoutedContextSnapshotEntry[]) {
  const chunks: Array<{
    entry: ChatRoutedContextSnapshotEntry;
    startLine: number;
    endLine: number;
    text: string;
    order: number;
  }> = [];
  let order = 0;
  for (const entry of entries) {
    const lines = splitLines(entry.admittedText);
    for (let offset = 0; offset < lines.length && chunks.length < MAX_EPHEMERAL_EMBEDDING_CHUNKS; offset += 8) {
      const selected = lines.slice(offset, offset + 8);
      chunks.push({
        entry,
        startLine: offset + 1,
        endLine: offset + selected.length,
        text: selected.join("\n"),
        order,
      });
      order += 1;
    }
    if (chunks.length >= MAX_EPHEMERAL_EMBEDDING_CHUNKS) break;
  }
  return chunks;
}

function selectBoundedMatches(
  candidates: Array<ChatRoutedContextToolMatch & { order: number }>,
  limit: number,
): { matches: ChatRoutedContextToolMatch[]; truncated: boolean } {
  candidates.sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.order - right.order);
  const matches: ChatRoutedContextToolMatch[] = [];
  let totalBytes = 0;
  let truncated = candidates.length > limit;
  for (const candidate of candidates) {
    if (matches.length >= limit) break;
    const nextBytes = Buffer.byteLength(candidate.text, "utf8");
    if (totalBytes + nextBytes > CHAT_ROUTED_CONTEXT_TOOL_MAX_OUTPUT_BYTES) {
      truncated = true;
      break;
    }
    const { order: _order, ...match } = candidate;
    matches.push(match);
    totalBytes += nextBytes;
  }
  return { matches, truncated };
}

function scoreLexicalText(value: string, normalizedQuery: string, terms: string[]): number {
  const normalized = normalizeLexicalText(value);
  if (!normalized) return 0;
  const matchedTerms = terms.filter((term) => normalized.includes(term));
  if (matchedTerms.length === 0) return 0;
  const phraseBoost = normalized.includes(normalizedQuery) ? 2 : 0;
  const coverage = matchedTerms.length / terms.length;
  const density = matchedTerms.reduce((count, term) => count + countOccurrences(normalized, term), 0);
  return Number((phraseBoost + coverage + Math.min(density, 8) / 100).toFixed(4));
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function embeddingRuntimeOptions(
  request: ToolInvokeRequest,
  deps: RoutedContextExecutorDeps,
  purpose: "embedding_query" | "embedding_repair",
): EmbeddingRuntimeOptions {
  return {
    purpose,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(deps.acquireLocalEmbeddingLease ? { acquireLocalServiceLease: deps.acquireLocalEmbeddingLease } : {}),
    ...(deps.prepareEmbeddingUsageDispatch ? { prepareModelUsageDispatch: deps.prepareEmbeddingUsageDispatch } : {}),
    modelUsageAttribution: {
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      durableRunId: request.runId,
      taskId: request.taskId,
      agentId: request.agentId,
      utilityKind: `tool:${request.toolName}:${purpose}`,
    },
  };
}

function readSnapshotRange(
  snapshot: ChatRoutedContextSnapshotRecord,
  eligibleEntries: ChatRoutedContextSnapshotEntry[],
  args: Record<string, unknown>,
): ChatRoutedContextToolReadRangeResult {
  const entryIndex = requireInteger(args.entryIndex, "entryIndex", 0);
  const entry = eligibleEntries.find((candidate) => candidate.index === entryIndex);
  if (!entry) throw new Error(`entryIndex ${entryIndex} is not eligible in the active snapshot.`);
  const startLine = requireInteger(args.startLine, "startLine", 1);
  const requestedEndLine = requireInteger(args.endLine, "endLine", startLine);
  if (requestedEndLine < startLine) throw new Error("endLine must be greater than or equal to startLine.");
  const lines = splitLines(entry.admittedText);
  if (startLine > lines.length)
    throw new Error(`startLine ${startLine} exceeds the source line count ${lines.length}.`);
  const boundedEndLine = Math.min(
    requestedEndLine,
    startLine + CHAT_ROUTED_CONTEXT_TOOL_MAX_READ_LINES - 1,
    lines.length,
  );
  const selected = lines.slice(startLine - 1, boundedEndLine).join("\n");
  const bounded = truncateUtf8(selected, CHAT_ROUTED_CONTEXT_TOOL_MAX_OUTPUT_BYTES);
  return {
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    receipt: buildReceipt(snapshot, entry, startLine, boundedEndLine),
    text: bounded.text,
    truncated: bounded.truncated || boundedEndLine < requestedEndLine,
  };
}

function buildReceipt(
  snapshot: ChatRoutedContextSnapshotRecord,
  entry: ChatRoutedContextSnapshotEntry,
  startLine: number,
  endLine: number,
): ChatRoutedContextToolSourceReceipt {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    sourceHash: entry.sourceHash,
    entryIndex: entry.index,
    sourceRef: entry.ref,
    sourceKind: entry.kind,
    sourceLabel: entry.label,
    startLine,
    endLine,
  };
}

function selectEntries(
  entries: ChatRoutedContextSnapshotEntry[],
  rawEntryIndex: unknown,
): ChatRoutedContextSnapshotEntry[] {
  if (rawEntryIndex === undefined) return entries;
  const entryIndex = requireInteger(rawEntryIndex, "entryIndex", 0);
  const entry = entries.find((candidate) => candidate.index === entryIndex);
  if (!entry) throw new Error(`entryIndex ${entryIndex} is not eligible in the active snapshot.`);
  return [entry];
}

function isEligibleEntry(entry: ChatRoutedContextSnapshotEntry): boolean {
  return (
    (entry.disposition === "included" || entry.disposition === "truncated") &&
    entry.admittedBytes > 0 &&
    entry.admittedText.length > 0
  );
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/u);
}

function assertNoAuthorityOverrides(args: Record<string, unknown>): void {
  for (const key of AUTHORITY_OVERRIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      throw new Error(`Attached-context authority override ${key} is forbidden.`);
    }
  }
}

function requireServerBinding(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Attached-context tool requires server-authored ${name}.`);
  return normalized;
}

function requireBoundedText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > CHAT_ROUTED_CONTEXT_TOOL_MAX_QUERY_LENGTH) {
    throw new Error(`${name} must contain 1-${CHAT_ROUTED_CONTEXT_TOOL_MAX_QUERY_LENGTH} characters.`);
  }
  return normalized;
}

function readOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function readLimit(value: unknown): number {
  if (value === undefined) return 20;
  return requireInteger(value, "limit", 1, CHAT_ROUTED_CONTEXT_TOOL_MAX_MATCHES);
}

function requireInteger(value: unknown, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function normalizeLexicalText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function countOccurrences(value: string, term: string): number {
  let count = 0;
  let offset = 0;
  while (offset < value.length) {
    const next = value.indexOf(term, offset);
    if (next < 0) break;
    count += 1;
    offset = next + term.length;
  }
  return count;
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  const bytes = Buffer.from(value, "utf8").subarray(0, maxBytes);
  return { text: bytes.toString("utf8").replace(/\uFFFD$/u, ""), truncated: true };
}
