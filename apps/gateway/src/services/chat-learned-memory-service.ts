import type {
  ChatTurnTraceRecord,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryItemType,
  LearnedMemoryUpdateInput,
  MemoryClaim,
  MemoryCorrectionTarget,
  ChatMessageSourceAuthority,
} from "@goatcitadel/contracts";
import { memoryClaimKey, redactSecretText } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { extractLearnedMemoryCandidates, shouldExtractLearnedMemoryContent } from "./learned-memory-utils.js";
import { clampMemoryConfidence, decideLearnedMemoryWrite } from "./memory-lifecycle-policy.js";
import { classifyMemoryIntent, identifyReviewMemoryProperty } from "./memory-intent-service.js";

// ── pure helpers ─────────────────────────────────────────────────────

function looksSensitive(value: string): boolean {
  return redactSecretText(value.normalize("NFKC"), { env: process.env }).redactionCount > 0;
}

const CORRECTION_PREFIX = /^\s*(?:no|actually|correction|en\s+realidad)[,;:\s]+/iu;
const NEGATION =
  /\b(?:not|never|no\s+longer|don't|dont|doesn't|isn't|won't|stop|avoid|without|nunca|jam[aá]s|evita[rn]?|sin)\b|n't\b|\bno\s/iu;

/**
 * A session-scoped claim for text that names a known property (reply length, language, …).
 * It only lets conflict detection compare like with like; write authority is unchanged.
 */
export function inferSessionMemoryClaim(content: string, sessionId: string): MemoryClaim | undefined {
  // The property hint matches keywords only, so "Never give concise replies" would read as
  // "concise". Infer nothing when the statement is negated; it then stays a separate row.
  const statement = content.normalize("NFKC").replace(CORRECTION_PREFIX, "");
  if (NEGATION.test(statement)) return undefined;
  const hint = identifyReviewMemoryProperty(statement);
  if (!hint) return undefined;
  return {
    identity: {
      subject: hint.subject,
      predicate: hint.predicate,
      cardinality: hint.cardinality,
      scope: { kind: "session", id: sessionId },
    },
    value: hint.value,
  };
}

// ── service class ────────────────────────────────────────────────────

export interface ChatLearnedMemoryServiceContext {
  readonly storage: Pick<Storage, "sessions" | "learnedMemory" | "chatTurnTraces" | "chatToolRuns">;
}

/**
 * Encapsulates learned-memory extraction, listing, updating, and
 * rebuild logic. Uses the LearnedMemoryRepository from packages/storage
 * for all persistence operations.
 */
export class ChatLearnedMemoryService {
  constructor(private readonly ctx: ChatLearnedMemoryServiceContext) {}

  // ── public API ─────────────────────────────────────────────────────

  async listChatSessionLearnedMemory(
    sessionId: string,
    limit = 200,
  ): Promise<{
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  }> {
    await this.requireSession(sessionId);
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    return {
      items: await this.ctx.storage.learnedMemory.listItemsBySession(sessionId, boundedLimit),
      conflicts: await this.ctx.storage.learnedMemory.listConflictsBySession(sessionId, boundedLimit),
    };
  }

  async updateChatSessionLearnedMemory(
    sessionId: string,
    itemId: string,
    input: LearnedMemoryUpdateInput,
  ): Promise<LearnedMemoryItemRecord> {
    await this.requireSession(sessionId);
    const current = await this.ctx.storage.learnedMemory.getItem(itemId);
    if (!current) {
      throw new Error(`Learned memory item ${itemId} not found.`);
    }
    if (current.sessionId !== sessionId) {
      throw new Error("Learned memory item does not belong to this session.");
    }
    const nextStatus = input.status ?? current.status;
    const nextContent = input.content?.trim() || current.content;
    const nextConfidence = clampMemoryConfidence(
      typeof input.confidence === "number" ? input.confidence : current.confidence,
    );
    await this.ctx.storage.learnedMemory.updateItemFields(itemId, {
      status: nextStatus,
      content: nextContent,
      confidence: nextConfidence,
    });
    return (await this.ctx.storage.learnedMemory.getItem(itemId))!;
  }

  async clearChatSessionLearnedMemory(sessionId: string): Promise<void> {
    await this.requireSession(sessionId);
    await this.ctx.storage.learnedMemory.clearSession(sessionId);
  }

  private async requireSession(sessionId: string): Promise<void> {
    await this.ctx.storage.sessions.getBySessionId(sessionId);
  }

  /**
   * Extract learned-memory candidates from content and persist them.
   * Called both internally (during rebuild) and from chat-turn
   * processing in gateway-service.
   */
  async extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: {
      role: "user" | "assistant";
      sourceRef: string;
      authority?: ChatMessageSourceAuthority;
      workspaceId?: string;
      trace?: Pick<ChatTurnTraceRecord, "status" | "toolRuns">;
    },
  ): Promise<void> {
    if (!shouldExtractLearnedMemoryContent(content, source)) {
      return;
    }
    const repo = this.ctx.storage.learnedMemory;
    const intent = classifyMemoryIntent({
      content,
      sourceAuthority: source.authority ?? "unknown",
      sourceMessageId: source.sourceRef,
    });
    const naturalContents = new Set(intent.proposals.map((proposal) => proposal.content.toLowerCase()));
    const candidates: Array<{
      itemType: LearnedMemoryItemType;
      content: string;
      confidence: number;
      claim?: MemoryClaim;
      correctionRequested?: boolean;
    }> = extractLearnedMemoryCandidates(content, source.role)
      .filter((candidate) => !naturalContents.has(candidate.content.toLowerCase()))
      .map((candidate) => {
        const claim = source.workspaceId ? inferSessionMemoryClaim(candidate.content, sessionId) : undefined;
        return claim ? { ...candidate, claim } : candidate;
      });
    for (const proposal of intent.proposals) {
      if (proposal.kind === "inferred_candidate") continue;
      candidates.push({
        itemType: proposal.itemType,
        content: proposal.content,
        confidence: 0.9,
        correctionRequested: proposal.kind === "correction",
        ...(proposal.claimHint && source.workspaceId
          ? {
              claim: {
                identity: {
                  subject: proposal.claimHint.subject,
                  predicate: proposal.claimHint.predicate,
                  cardinality: proposal.claimHint.cardinality,
                  scope: { kind: "session", id: sessionId },
                },
                value: proposal.claimHint.value,
              },
            }
          : {}),
      });
    }
    for (const candidate of candidates) {
      if (looksSensitive(candidate.content)) {
        await repo.insertItem({
          sessionId,
          itemType: candidate.itemType,
          content: "[REDACTED]",
          confidence: candidate.confidence,
          status: "dropped",
          redacted: true,
          sourceKind: source.role,
          sourceRef: source.sourceRef,
          snippet: "Dropped due to secret redaction policy.",
        });
        continue;
      }
      await this.upsertLearnedMemoryItem({
        sessionId,
        itemType: candidate.itemType,
        content: candidate.content,
        confidence: candidate.confidence,
        claim: candidate.claim,
        correctionRequested: candidate.correctionRequested,
        workspaceId: source.workspaceId,
        authority: source.authority,
        sourceKind: source.role,
        sourceRef: source.sourceRef,
        snippet: candidate.content.slice(0, 240),
      });
    }
  }

  // ── internal helpers ───────────────────────────────────────────────

  /**
   * Active items for one property: rows stored with that claim, plus older rows saved
   * without a claim whose text names the same property. Without the second group an
   * opposite preference saved before claims existed would stay active beside the new one.
   */
  private async findActiveClaimIncludingUnclaimed(
    sessionId: string,
    workspaceId: string,
    itemType: string,
    claim: MemoryClaim,
  ): Promise<LearnedMemoryItemRecord[]> {
    const repo = this.ctx.storage.learnedMemory;
    const claimed = await repo.findActiveClaim(sessionId, workspaceId, claim);
    const key = memoryClaimKey(workspaceId, claim);
    const unclaimed = (await repo.findActiveByType(sessionId, itemType as LearnedMemoryItemType)).flatMap((item) => {
      // findActiveByType also returns unresolved `conflict` rows; only active rows are targets.
      if (item.status !== "active" || item.claim || item.redacted) return [];
      const inferred = inferSessionMemoryClaim(item.content, sessionId);
      return inferred && memoryClaimKey(workspaceId, inferred) === key ? [{ ...item, claim: inferred }] : [];
    });
    return [...claimed, ...unclaimed];
  }

  private async upsertLearnedMemoryItem(input: {
    sessionId: string;
    itemType: string;
    content: string;
    confidence: number;
    sourceKind: string;
    sourceRef: string;
    snippet: string;
    workspaceId?: string;
    claim?: MemoryClaim;
    authority?: ChatMessageSourceAuthority;
    correctionRequested?: boolean;
  }): Promise<void> {
    const repo = this.ctx.storage.learnedMemory;
    const existing =
      input.claim && input.workspaceId
        ? await this.findActiveClaimIncludingUnclaimed(input.sessionId, input.workspaceId, input.itemType, input.claim)
        : await repo.findActiveByType(input.sessionId, input.itemType as LearnedMemoryItemType);
    let correctionTarget: MemoryCorrectionTarget | undefined;
    if (input.correctionRequested) {
      if (!input.claim || existing.length !== 1 || !existing[0]?.sourceHash || input.authority !== "operator") return;
      correctionTarget = { sourceRef: existing[0].itemId, expectedSourceHash: existing[0].sourceHash };
    }
    const decision = decideLearnedMemoryWrite({
      content: input.content,
      confidence: input.confidence,
      existing,
      workspaceId: input.workspaceId,
      claim: input.claim,
      authority: input.authority,
      correctionTarget,
    });
    if (decision.action === "skip") {
      return;
    }
    if (decision.action === "merge_duplicate") {
      await repo.updateItemConfidence(decision.itemId, decision.nextConfidence);
      await repo.appendSource(decision.itemId, input.sourceKind, input.sourceRef, input.snippet);
      return;
    }
    if (decision.action === "record_conflict") {
      const incomingItem = await repo.insertItem({
        claim: input.claim,
        sessionId: input.sessionId,
        itemType: input.itemType as LearnedMemoryItemType,
        content: input.content,
        confidence: decision.incomingConfidence,
        status: "conflict",
        redacted: false,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        snippet: input.snippet,
      });
      await repo.insertConflict({
        sessionId: input.sessionId,
        itemType: input.itemType as LearnedMemoryItemType,
        existingItemId: decision.existingItemId,
        incomingItemId: incomingItem.itemId,
        incomingContent: input.content,
      });
      return;
    }
    if (decision.action === "supersede") {
      if (!correctionTarget) return;
      await repo.correctItem({
        itemId: decision.existingItemId,
        expectedSourceHash: correctionTarget.expectedSourceHash,
        replacement: {
          claim: input.claim,
          sessionId: input.sessionId,
          itemType: input.itemType as LearnedMemoryItemType,
          content: input.content,
          confidence: decision.incomingConfidence,
          status: "active",
          redacted: false,
          sourceKind: input.sourceKind,
          sourceRef: input.sourceRef,
          snippet: input.snippet,
        },
      });
      return;
    }

    await repo.insertItem({
      claim: input.claim,
      sessionId: input.sessionId,
      itemType: input.itemType as LearnedMemoryItemType,
      content: input.content,
      confidence: decision.incomingConfidence,
      status: "active",
      redacted: false,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      snippet: input.snippet,
    });
  }
}
