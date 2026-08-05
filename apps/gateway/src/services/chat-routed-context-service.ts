import { createHash } from "node:crypto";
import {
  CHAT_ROUTED_CONTEXT_BUDGET_POLICY_VERSION,
  CHAT_ROUTED_CONTEXT_ESTIMATOR_VERSION,
  CHAT_ROUTED_CONTEXT_MAX_LABEL_LENGTH,
  CHAT_ROUTED_CONTEXT_MAX_REF_LENGTH,
  CHAT_ROUTED_CONTEXT_MAX_REFS,
  CHAT_ROUTED_CONTEXT_CONTROL_PATTERN,
  CHAT_ROUTED_CONTEXT_REF_PATTERN,
  CHAT_ROUTED_CONTEXT_SNAPSHOT_VERSION,
  ConflictError,
  ValidationError,
  canonicalJsonString,
  type ChatAttachmentRecord,
  type ChatCompletionRequest,
  type ChatRoutedContextExternalProvenance,
  type ChatRoutedContextRef,
  type ChatRoutedContextSnapshotEntry,
  type ChatRoutedContextSnapshotRecord,
  type ChatTurnCapabilityProfileRecord,
  type ExternalSessionAttachmentRecord,
  type MemoryItemRecord,
  type NoteRecord,
  type ChatGeneratedArtifactRecord,
} from "@goatcitadel/contracts";
import { estimateTokensFromText } from "@goatcitadel/memory-core";
import {
  renderChatRoutedContextEntries,
  sealChatRoutedContextSnapshot,
  verifyChatRoutedContextSnapshot,
} from "@goatcitadel/storage";

export const CHAT_ROUTED_CONTEXT_MAX_SOURCE_BYTES = 256 * 1024;
export const CHAT_ROUTED_CONTEXT_MAX_AGGREGATE_SOURCE_BYTES = 1024 * 1024;
export const CHAT_ROUTED_CONTEXT_HARD_CAP_TOKENS = 8_192;
export const CHAT_ROUTED_CONTEXT_PER_SOURCE_TOKENS = 2_048;
export const CHAT_ROUTED_CONTEXT_OUTPUT_RESERVE_TOKENS = 4_096;
export const CHAT_ROUTED_CONTEXT_PROMPT_SAFETY_TOKENS = 256;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REF_KEYS = new Set(["kind", "ref", "label"]);

interface NormalizedRef {
  index: number;
  kind: ChatRoutedContextRef["kind"];
  ref: string;
  label: string;
}

export interface ResolvedChatRoutedContextSource {
  index: number;
  kind: ChatRoutedContextRef["kind"];
  ref: string;
  label: string;
  sourceScope: "workspace" | "global";
  sourceWorkspaceId?: string;
  sourceVersion: string;
  sourceHash: string;
  /** Present exactly when `kind` is `external_attachment`. */
  externalProvenance?: ChatRoutedContextExternalProvenance;
  originalBytes: number;
  text: string;
  alreadyAttached: boolean;
}

export interface ResolvedChatRoutedContextSources {
  sourceRequestHash: string;
  sources: ResolvedChatRoutedContextSource[];
}

/** Exact managed-artifact bytes plus provenance for one live external attachment. */
export interface ChatRoutedContextExternalAttachmentContent {
  attachment: ExternalSessionAttachmentRecord;
  bytes: Buffer;
  provenance: ChatRoutedContextExternalProvenance;
}

export interface ChatRoutedContextSourceDeps {
  getAttachment(attachmentId: string): Promise<ChatAttachmentRecord>;
  readAttachmentContent(
    attachmentId: string,
    options: { maxBytes: number },
  ): Promise<{ record: ChatAttachmentRecord; bytes: Buffer }>;
  getActiveMemoryItem(
    itemId: string,
    workspaceId: string,
    options: { allowGlobal: boolean },
  ): Promise<MemoryItemRecord | undefined>;
  getPersonalNote?(noteId: string): Promise<NoteRecord>;
  getGeneratedArtifact?(artifactId: string): Promise<ChatGeneratedArtifactRecord>;
  /**
   * Governed exact-byte read for one live `read_only_external` attachment.
   * Absent in compositions that have not enabled the external-source runtime:
   * external refs then fail closed before any provider use.
   */
  readExternalAttachmentContent?(
    attachmentId: string,
    scope: { sessionId: string; workspaceId: string },
  ): Promise<ChatRoutedContextExternalAttachmentContent>;
}

export interface ResolveChatRoutedContextSourcesInput {
  refs: unknown;
  sessionId: string;
  workspaceId: string;
  memoryMode: "auto" | "on" | "off";
  /** Must be derived from the server-owned effective memory read policy. */
  allowGlobalMemory: boolean;
  ordinaryAttachmentIds?: readonly string[];
}

export interface BuildChatRoutedContextSnapshotInput {
  resolved: ResolvedChatRoutedContextSources;
  turnId: string;
  sessionId: string;
  workspaceId: string;
  capabilityProfile: ChatTurnCapabilityProfileRecord;
  /** Exact server-owned metadata for the already-frozen effective provider/model. */
  routeContextWindowTokens: number;
  baseHistoryMessages: ChatCompletionRequest["messages"];
  createdAt?: string;
}

/** Read and attest every mutable source once; results stay in request order. */
export async function resolveChatRoutedContextSources(
  deps: ChatRoutedContextSourceDeps,
  input: ResolveChatRoutedContextSourcesInput,
): Promise<ResolvedChatRoutedContextSources> {
  const refs = normalizeRefs(input.refs);
  if (refs.some((ref) => ref.kind === "memory_item") && input.memoryMode === "off") {
    throw new ConflictError({ message: "Routed memory context is unavailable while memory mode is off." });
  }
  const ordinaryAttachments = new Set((input.ordinaryAttachmentIds ?? []).map((item) => item.trim()).filter(Boolean));
  const prepared = await Promise.all(
    refs.map(async (ref) => {
      if (ref.kind === "attachment") {
        const record = await deps.getAttachment(ref.ref);
        assertAttachmentRecord(record, ref.ref, input.sessionId, input.workspaceId);
        return { type: "attachment" as const, ref, record, alreadyAttached: ordinaryAttachments.has(ref.ref) };
      }
      if (ref.kind === "external_attachment") {
        return { type: "external" as const, ref };
      }
      if (ref.kind === "personal_note") {
        if (!deps.getPersonalNote)
          throw new ConflictError({ message: `Personal note ${ref.ref} is unavailable in this runtime.` });
        const note = await deps.getPersonalNote(ref.ref);
        if (note.noteId !== ref.ref || note.workspaceId !== input.workspaceId || note.lifecycleStatus !== "active") {
          throw new ConflictError({ message: `Personal note ${ref.ref} is unavailable in the effective workspace.` });
        }
        assertExactUtf8(note.body, `personal note ${ref.ref}`);
        const bytes = Buffer.byteLength(note.body, "utf8");
        assertSourceSize(ref.ref, bytes);
        return { type: "note" as const, ref, note, bytes };
      }
      if (ref.kind === "generated_artifact") {
        if (!deps.getGeneratedArtifact)
          throw new ConflictError({ message: `Generated artifact ${ref.ref} is unavailable in this runtime.` });
        const artifact = await deps.getGeneratedArtifact(ref.ref);
        if (artifact.artifactId !== ref.ref || (artifact.workspaceId ?? "default") !== input.workspaceId) {
          throw new ConflictError({
            message: `Generated artifact ${ref.ref} is unavailable in the effective workspace.`,
          });
        }
        assertExactUtf8(artifact.content, `generated artifact ${ref.ref}`);
        const bytes = Buffer.byteLength(artifact.content, "utf8");
        assertSourceSize(ref.ref, bytes);
        const contentHash = digestText(artifact.content);
        if (artifact.contentHash && artifact.contentHash !== contentHash) {
          throw new ConflictError({
            message: `Generated artifact ${ref.ref} failed its immutable content hash check.`,
          });
        }
        return { type: "artifact" as const, ref, artifact, bytes, contentHash };
      }
      const item = await deps.getActiveMemoryItem(ref.ref, input.workspaceId, {
        allowGlobal: input.allowGlobalMemory,
      });
      if (!item || item.itemId !== ref.ref || item.status !== "active" || item.lifecycleState !== "active") {
        throw new ConflictError({ message: `Routed memory item ${ref.ref} is unavailable in the effective scope.` });
      }
      assertExactUtf8(item.content, `memory item ${ref.ref}`);
      const provenance = resolveMemoryScope(item, input.workspaceId, input.allowGlobalMemory);
      const bytes = Buffer.byteLength(item.content, "utf8");
      assertSourceSize(ref.ref, bytes);
      return { type: "memory" as const, ref, item, provenance, bytes };
    }),
  );
  // External bytes exist only in the governed managed artifact, so their exact
  // size is knowable solely from a verified read; load them (fail closed when
  // the runtime is not composed) before the aggregate budget check.
  const externalByIndex = new Map<number, ChatRoutedContextExternalAttachmentContent>();
  for (const item of prepared) {
    if (item.type !== "external") continue;
    const readExternal = deps.readExternalAttachmentContent;
    if (!readExternal) {
      throw new ConflictError({
        message: `Routed external attachment ${item.ref.ref} is unavailable in this runtime.`,
      });
    }
    const loaded = await readExternal(item.ref.ref, { sessionId: input.sessionId, workspaceId: input.workspaceId });
    assertExternalAttachmentContent(loaded, item.ref.ref, input.sessionId, input.workspaceId);
    externalByIndex.set(item.ref.index, loaded);
  }
  const declaredBytes = prepared.reduce(
    (sum, item) =>
      sum +
      (item.type === "attachment"
        ? item.record.sizeBytes
        : item.type === "external"
          ? externalByIndex.get(item.ref.index)!.bytes.length
          : item.bytes),
    0,
  );
  if (declaredBytes > CHAT_ROUTED_CONTEXT_MAX_AGGREGATE_SOURCE_BYTES) {
    throw new ConflictError({ message: "Routed context sources exceed the aggregate server byte limit." });
  }

  const sources = await Promise.all(
    prepared.map(async (item): Promise<ResolvedChatRoutedContextSource> => {
      if (item.type === "external") {
        const loaded = externalByIndex.get(item.ref.index)!;
        const text = decodeExactUtf8(loaded.bytes, `external attachment ${item.ref.ref}`);
        return {
          ...item.ref,
          sourceScope: "workspace",
          sourceWorkspaceId: input.workspaceId,
          sourceVersion: `external:rev:${loaded.attachment.revision}:sha256:${loaded.provenance.normalizedArtifactSha256}`,
          sourceHash: loaded.provenance.normalizedArtifactSha256,
          externalProvenance: loaded.provenance,
          originalBytes: loaded.bytes.length,
          text,
          alreadyAttached: false,
        };
      }
      if (item.type === "memory") {
        const sourceHash = digestText(item.item.content);
        const updatedAt = canonicalIso(item.item.updatedAt, `memory item ${item.ref.ref} updatedAt`);
        return {
          ...item.ref,
          ...item.provenance,
          sourceVersion: `updated:${updatedAt}:sha256:${sourceHash}`,
          sourceHash,
          originalBytes: item.bytes,
          text: item.item.content,
          alreadyAttached: false,
        };
      }
      if (item.type === "note") {
        const sourceHash = digestText(item.note.body);
        return {
          ...item.ref,
          sourceScope: "workspace",
          sourceWorkspaceId: input.workspaceId,
          sourceVersion: `revision:${item.note.revision}:sha256:${sourceHash}`,
          sourceHash,
          originalBytes: item.bytes,
          text: item.note.body,
          alreadyAttached: false,
        };
      }
      if (item.type === "artifact") {
        return {
          ...item.ref,
          sourceScope: "workspace",
          sourceWorkspaceId: input.workspaceId,
          sourceVersion: `version:${item.artifact.version}:sha256:${item.contentHash}`,
          sourceHash: item.contentHash,
          originalBytes: item.bytes,
          text: item.artifact.content,
          alreadyAttached: false,
        };
      }
      const loaded = await deps.readAttachmentContent(item.ref.ref, {
        maxBytes: CHAT_ROUTED_CONTEXT_MAX_SOURCE_BYTES,
      });
      assertSameAttachmentRecord(item.record, loaded.record);
      assertAttachmentRecord(loaded.record, item.ref.ref, input.sessionId, input.workspaceId);
      assertSourceSize(item.ref.ref, loaded.bytes.length);
      const actualHash = createHash("sha256").update(loaded.bytes).digest("hex");
      if (loaded.bytes.length !== item.record.sizeBytes || actualHash !== item.record.sha256) {
        throw new ConflictError({
          message: `Routed attachment ${item.ref.ref} changed after admission metadata was recorded.`,
        });
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(loaded.bytes);
      } catch {
        throw new ValidationError({ message: `Routed attachment ${item.ref.ref} is not valid UTF-8 text.` });
      }
      if (!Buffer.from(text, "utf8").equals(loaded.bytes)) {
        throw new ValidationError({ message: `Routed attachment ${item.ref.ref} is not canonical UTF-8 text.` });
      }
      return {
        ...item.ref,
        sourceScope: "workspace",
        sourceWorkspaceId: input.workspaceId,
        sourceVersion: `sha256:${actualHash}`,
        sourceHash: actualHash,
        originalBytes: loaded.bytes.length,
        text,
        alreadyAttached: item.alreadyAttached,
      };
    }),
  );
  return {
    sourceRequestHash: digest(refs.map(({ kind, ref }) => ({ kind, ref }))),
    sources,
  };
}

/** Build a deterministic exact-byte snapshot from already-attested sources. */
export function buildChatRoutedContextSnapshot(
  input: BuildChatRoutedContextSnapshotInput,
): ChatRoutedContextSnapshotRecord {
  const profile = input.capabilityProfile;
  if (
    profile.identity.turnId !== input.turnId ||
    profile.identity.sessionId !== input.sessionId ||
    profile.identity.workspaceId !== input.workspaceId
  ) {
    throw new ConflictError({ message: "Routed context identity does not match the effective capability profile." });
  }
  if (input.resolved.sources.some((source) => source.kind === "memory_item")) {
    if (
      profile.selection.memory?.mode === "off" ||
      profile.selection.memory?.workspaceId !== input.workspaceId ||
      profile.selection.memory?.sessionId !== input.sessionId
    ) {
      throw new ConflictError({ message: "Routed memory context does not match the final capability profile scope." });
    }
  }
  const expectedSourceRequestHash = digest(input.resolved.sources.map(({ kind, ref }) => ({ kind, ref })));
  if (input.resolved.sourceRequestHash !== expectedSourceRequestHash) {
    throw new ConflictError({ message: "Routed context source-request binding is invalid." });
  }
  const providerId = profile.selection.effectiveProviderId;
  const model = profile.selection.effectiveModel;
  if (!providerId || !model) {
    throw new ConflictError({ message: "Routed context requires a frozen effective provider and model." });
  }
  const contextWindowTokens = input.routeContextWindowTokens;
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) {
    throw new ConflictError({ message: "The effective provider/model lacks trusted context-window metadata." });
  }
  const promptReservedTokens =
    estimateTokensFromText(
      canonicalJsonString({
        messages: input.baseHistoryMessages,
        tools: profile.selection.tools.map((tool) => tool.providerDefinition),
      }),
      { model },
    ) + CHAT_ROUTED_CONTEXT_PROMPT_SAFETY_TOKENS;
  const outputReservedTokens = CHAT_ROUTED_CONTEXT_OUTPUT_RESERVE_TOKENS;
  if (promptReservedTokens + outputReservedTokens > contextWindowTokens) {
    throw new ConflictError({ message: "The effective route has no governed capacity for routed context." });
  }
  const effectiveBudgetTokens = Math.min(
    CHAT_ROUTED_CONTEXT_HARD_CAP_TOKENS,
    contextWindowTokens - promptReservedTokens - outputReservedTokens,
  );
  const entries: ChatRoutedContextSnapshotEntry[] = [];
  for (const source of input.resolved.sources) {
    const originalTokens = estimateTokensFromText(source.text, { model });
    if (source.alreadyAttached) {
      entries.push(buildEntry(source, originalTokens, "already_attached", "", 0));
      continue;
    }
    if (source.kind === "external_attachment") {
      // HX-407 freezes exact external bytes: an external source is admitted in
      // full within the governed budget or omitted whole, never truncated.
      entries.push(fitExternalSourceExactly(entries, source, originalTokens, effectiveBudgetTokens, model));
      continue;
    }
    const admitted = fitSourceToRenderedBudget(entries, source, originalTokens, effectiveBudgetTokens, model);
    entries.push(admitted);
  }
  const contextText = renderChatRoutedContextEntries(entries);
  const usedTokens = estimateTokensFromText(contextText, { model });
  if (usedTokens > effectiveBudgetTokens) {
    throw new Error("Routed context renderer exceeded its immutable token budget.");
  }
  const createdAt = canonicalIso(input.createdAt ?? new Date().toISOString(), "snapshot createdAt");
  const snapshot = sealChatRoutedContextSnapshot({
    snapshotId: `chat-rctx-${digest({
      turnId: input.turnId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    }).slice(0, 48)}`,
    schemaVersion: CHAT_ROUTED_CONTEXT_SNAPSHOT_VERSION,
    turnId: input.turnId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    capabilityProfileId: profile.profileId,
    capabilityProfileHash: profile.hashes.profileHash,
    sourceRequestHash: input.resolved.sourceRequestHash,
    contentHash: digestText(contextText),
    budget: {
      effectiveProviderId: providerId,
      effectiveModel: model,
      contextWindowTokens,
      promptReservedTokens,
      outputReservedTokens,
      hardCapTokens: CHAT_ROUTED_CONTEXT_HARD_CAP_TOKENS,
      effectiveBudgetTokens,
      usedTokens,
      usedBytes: Buffer.byteLength(contextText, "utf8"),
      estimatorVersion: CHAT_ROUTED_CONTEXT_ESTIMATOR_VERSION,
      budgetPolicyVersion: CHAT_ROUTED_CONTEXT_BUDGET_POLICY_VERSION,
    },
    entries,
    contextText,
    createdAt,
  });
  verifyChatRoutedContextSnapshot(snapshot);
  return snapshot;
}

function fitExternalSourceExactly(
  prior: ChatRoutedContextSnapshotEntry[],
  source: ResolvedChatRoutedContextSource,
  originalTokens: number,
  budget: number,
  model: string,
): ChatRoutedContextSnapshotEntry {
  if (!source.text || originalTokens <= 0 || budget <= 0 || originalTokens > CHAT_ROUTED_CONTEXT_PER_SOURCE_TOKENS) {
    return buildEntry(source, originalTokens, "omitted", "", 0);
  }
  const included = buildEntry(source, originalTokens, "included", source.text, originalTokens);
  const renderedTokens = estimateTokensFromText(renderChatRoutedContextEntries([...prior, included]), { model });
  return renderedTokens <= budget ? included : buildEntry(source, originalTokens, "omitted", "", 0);
}

function fitSourceToRenderedBudget(
  prior: ChatRoutedContextSnapshotEntry[],
  source: ResolvedChatRoutedContextSource,
  originalTokens: number,
  budget: number,
  model: string,
): ChatRoutedContextSnapshotEntry {
  if (!source.text || originalTokens <= 0 || budget <= 0) {
    return buildEntry(source, originalTokens, "omitted", "", 0);
  }
  const maxAllowedTokens = Math.min(originalTokens, CHAT_ROUTED_CONTEXT_PER_SOURCE_TOKENS);
  if (originalTokens <= maxAllowedTokens) {
    const included = buildEntry(source, originalTokens, "included", source.text, originalTokens);
    const renderedTokens = estimateTokensFromText(renderChatRoutedContextEntries([...prior, included]), { model });
    if (renderedTokens <= budget) {
      return included;
    }
  }
  const truncationSuffixTokens = estimateTokensFromText("\n...[truncated]", { model });
  let low = truncationSuffixTokens;
  let high = Math.min(maxAllowedTokens, originalTokens - 1);
  let best: ChatRoutedContextSnapshotEntry | undefined;
  while (low <= high) {
    const allowed = Math.floor((low + high) / 2);
    const admittedText = truncateUtf8SafeByTokens(source.text, allowed, model);
    const admittedTokens = estimateTokensFromText(admittedText, { model });
    const disposition = admittedText === source.text ? "included" : "truncated";
    const candidate = buildEntry(source, originalTokens, disposition, admittedText, admittedTokens);
    const renderedTokens = estimateTokensFromText(renderChatRoutedContextEntries([...prior, candidate]), { model });
    if (admittedText && admittedTokens <= allowed && renderedTokens <= budget) {
      best = candidate;
      low = allowed + 1;
    } else {
      high = allowed - 1;
    }
  }
  return best ?? buildEntry(source, originalTokens, "omitted", "", 0);
}

function buildEntry(
  source: ResolvedChatRoutedContextSource,
  originalTokens: number,
  disposition: ChatRoutedContextSnapshotEntry["disposition"],
  admittedText: string,
  admittedTokens: number,
): ChatRoutedContextSnapshotEntry {
  return {
    index: source.index,
    kind: source.kind,
    ref: source.ref,
    label: source.label,
    disposition,
    sourceScope: source.sourceScope,
    ...(source.sourceWorkspaceId ? { sourceWorkspaceId: source.sourceWorkspaceId } : {}),
    sourceVersion: source.sourceVersion,
    sourceHash: source.sourceHash,
    ...(source.externalProvenance ? { externalProvenance: source.externalProvenance } : {}),
    originalBytes: source.originalBytes,
    originalTokens,
    admittedBytes: Buffer.byteLength(admittedText, "utf8"),
    admittedTokens,
    truncated: disposition === "truncated",
    admittedText,
  };
}

function normalizeRefs(value: unknown): NormalizedRef[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHAT_ROUTED_CONTEXT_MAX_REFS) {
    throw new ValidationError({
      message: `contextRefs must contain between 1 and ${CHAT_ROUTED_CONTEXT_MAX_REFS} items.`,
    });
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !REF_KEYS.has(key))) {
      throw new ValidationError({ message: `contextRefs[${index}] has an unsupported shape.` });
    }
    const ref = raw as Record<string, unknown>;
    if (
      ref.kind !== "attachment" &&
      ref.kind !== "memory_item" &&
      ref.kind !== "external_attachment" &&
      ref.kind !== "personal_note" &&
      ref.kind !== "generated_artifact"
    ) {
      throw new ValidationError({ message: `contextRefs[${index}].kind is unsupported.` });
    }
    if (
      typeof ref.ref !== "string" ||
      ref.ref !== ref.ref.trim() ||
      ref.ref.length > CHAT_ROUTED_CONTEXT_MAX_REF_LENGTH ||
      !CHAT_ROUTED_CONTEXT_REF_PATTERN.test(ref.ref)
    ) {
      throw new ValidationError({ message: `contextRefs[${index}].ref is invalid.` });
    }
    const callerLabel = ref.label;
    if (
      callerLabel !== undefined &&
      (typeof callerLabel !== "string" ||
        callerLabel !== callerLabel.trim() ||
        !callerLabel ||
        callerLabel.length > CHAT_ROUTED_CONTEXT_MAX_LABEL_LENGTH ||
        CHAT_ROUTED_CONTEXT_CONTROL_PATTERN.test(callerLabel))
    ) {
      throw new ValidationError({ message: `contextRefs[${index}].label is invalid.` });
    }
    const key = `${ref.kind}:${ref.ref}`;
    if (seen.has(key)) {
      throw new ValidationError({ message: `contextRefs contains duplicate source ${key}.` });
    }
    seen.add(key);
    return {
      index,
      kind: ref.kind,
      ref: ref.ref,
      label:
        typeof callerLabel === "string"
          ? callerLabel
          : ref.kind === "attachment"
            ? `Attachment ${index + 1}`
            : ref.kind === "external_attachment"
              ? `External source ${index + 1}`
              : ref.kind === "personal_note"
                ? `Personal note ${index + 1}`
                : ref.kind === "generated_artifact"
                  ? `Generated artifact ${index + 1}`
                  : `Memory item ${index + 1}`,
    };
  });
}

/**
 * The external read port must return one live read-only attachment whose
 * verified bytes hash-bind to the provenance chain; anything else fails closed
 * before the bytes can reach a snapshot.
 */
function assertExternalAttachmentContent(
  loaded: ChatRoutedContextExternalAttachmentContent,
  ref: string,
  sessionId: string,
  workspaceId: string,
): void {
  const attachment = loaded?.attachment;
  const provenance = loaded?.provenance;
  if (
    !attachment ||
    !provenance ||
    !(loaded.bytes instanceof Buffer) ||
    attachment.attachmentId !== ref ||
    attachment.sessionId !== sessionId ||
    attachment.workspaceId !== workspaceId ||
    attachment.mode !== "read_only_external" ||
    attachment.status !== "attached" ||
    provenance.attachmentId !== ref ||
    provenance.sourceId !== attachment.sourceId ||
    provenance.importId !== attachment.importId ||
    provenance.itemId !== attachment.itemId ||
    provenance.attachmentRevision !== attachment.revision ||
    provenance.normalizedArtifactSha256 !== attachment.normalizedArtifactSha256
  ) {
    throw new ConflictError({ message: `Routed external attachment ${ref} is not live in the effective session.` });
  }
  assertSourceSize(ref, loaded.bytes.length);
  const actualHash = createHash("sha256").update(loaded.bytes).digest("hex");
  if (actualHash !== provenance.normalizedArtifactSha256) {
    throw new ConflictError({
      message: `Routed external attachment ${ref} bytes do not match their immutable artifact hash.`,
    });
  }
}

function decodeExactUtf8(bytes: Buffer, label: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ValidationError({ message: `Routed ${label} is not valid UTF-8 text.` });
  }
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new ValidationError({ message: `Routed ${label} is not canonical UTF-8 text.` });
  }
  return text;
}

function assertAttachmentRecord(
  record: ChatAttachmentRecord,
  ref: string,
  sessionId: string,
  workspaceId: string,
): void {
  if (
    record.attachmentId !== ref ||
    record.sessionId !== sessionId ||
    record.workspaceId !== workspaceId ||
    !Number.isSafeInteger(record.sizeBytes) ||
    record.sizeBytes < 0 ||
    !SHA256_PATTERN.test(record.sha256)
  ) {
    throw new ConflictError({ message: `Routed attachment ${ref} is outside the effective session/workspace scope.` });
  }
  assertSourceSize(ref, record.sizeBytes);
  const allowedMime =
    record.mimeType.startsWith("text/") ||
    /^(application\/(json|xml|yaml|x-yaml|toml|javascript|typescript))$/iu.test(record.mimeType);
  if (
    record.mediaType !== "text" ||
    !allowedMime ||
    record.extractStatus !== "ready" ||
    (record.analysisStatus !== undefined && record.analysisStatus !== "ready")
  ) {
    throw new ConflictError({ message: `Routed attachment ${ref} is not ready for exact text use.` });
  }
}

function assertSameAttachmentRecord(expected: ChatAttachmentRecord, actual: ChatAttachmentRecord): void {
  if (
    actual.attachmentId !== expected.attachmentId ||
    actual.sessionId !== expected.sessionId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.sizeBytes !== expected.sizeBytes ||
    actual.sha256 !== expected.sha256 ||
    actual.storageRelPath !== expected.storageRelPath ||
    actual.extractStatus !== expected.extractStatus ||
    actual.analysisStatus !== expected.analysisStatus ||
    actual.mediaType !== expected.mediaType ||
    actual.mimeType !== expected.mimeType
  ) {
    throw new ConflictError({
      message: `Routed attachment ${expected.attachmentId} metadata changed during resolution.`,
    });
  }
}

function resolveMemoryScope(
  item: MemoryItemRecord,
  workspaceId: string,
  allowGlobal: boolean,
): Pick<ResolvedChatRoutedContextSource, "sourceScope" | "sourceWorkspaceId"> {
  const canonical = item.workspaceId;
  const legacy = item.metadata?.workspaceId;
  const hasLegacyScope = Object.prototype.hasOwnProperty.call(item.metadata ?? {}, "workspaceId");
  if (
    canonical === undefined &&
    hasLegacyScope &&
    (typeof legacy !== "string" || !legacy.trim() || legacy !== legacy.trim())
  ) {
    throw new ConflictError({ message: `Routed memory item ${item.itemId} has malformed workspace provenance.` });
  }
  const scoped = canonical ?? (typeof legacy === "string" ? legacy : undefined);
  if (scoped !== undefined) {
    if (scoped !== workspaceId) {
      throw new ConflictError({ message: `Routed memory item ${item.itemId} is outside the effective workspace.` });
    }
    return { sourceScope: "workspace", sourceWorkspaceId: workspaceId };
  }
  if (!allowGlobal) {
    throw new ConflictError({ message: `Global memory item ${item.itemId} is not admitted by the effective policy.` });
  }
  return { sourceScope: "global" };
}

function assertSourceSize(ref: string, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > CHAT_ROUTED_CONTEXT_MAX_SOURCE_BYTES) {
    throw new ConflictError({ message: `Routed source ${ref} exceeds the server byte limit.` });
  }
}

function truncateUtf8SafeByTokens(input: string, maxTokens: number, model: string): string {
  if (maxTokens <= 0 || !input) {
    return "";
  }
  if (estimateTokensFromText(input, { model }) <= maxTokens) {
    return input;
  }
  const suffix = "\n...[truncated]";
  const suffixTokens = estimateTokensFromText(suffix, { model });
  if (suffixTokens > maxTokens) {
    return "";
  }
  const codePoints = Array.from(input);
  let low = 0;
  let high = codePoints.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = codePoints.slice(0, mid).join("").trimEnd();
    if (estimateTokensFromText(`${candidate}${suffix}`, { model }) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best ? `${best}${suffix}` : suffix.trimStart();
}

function assertExactUtf8(value: string, label: string): void {
  if (typeof value !== "string") {
    throw new ValidationError({ message: `Routed ${label} is not text.` });
  }
  const bytes = Buffer.from(value, "utf8");
  const roundTrip = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (roundTrip !== value) {
    throw new ValidationError({ message: `Routed ${label} is not canonical UTF-8 text.` });
  }
}

function canonicalIso(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ConflictError({ message: `Routed context ${label} is invalid.` });
  }
  return value;
}

function digest(value: unknown): string {
  return digestText(canonicalJsonString(value));
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
