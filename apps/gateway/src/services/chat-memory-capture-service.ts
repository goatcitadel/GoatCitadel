import { createHash } from "node:crypto";
import { normalizeMemoryClaim } from "@goatcitadel/contracts";
import type {
  ChatMessageSourceAuthority,
  ChatTurnTraceRecord,
  LearnedMemoryItemType,
  MemoryWriteAuthority,
  TraceMemoryCandidateAuthority,
  TraceMemoryCandidateInput,
  TraceMemoryCandidateRecord,
  TraceMemoryCandidateType,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ChatLearnedMemoryService } from "./chat-learned-memory-service.js";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import { extractLearnedMemoryCandidates, shouldExtractLearnedMemoryContent } from "./learned-memory-utils.js";
import { classifyMemoryIntent, type MemoryIntentResult } from "./memory-intent-service.js";
import type { MemoryWriteGateService } from "./memory-write-gate-service.js";

export interface StoredChatMemorySource {
  source_authority?: string;
  role?: string;
  content?: string;
}

interface ChatMemoryCaptureDependencies {
  readonly recallStorage?: Pick<AsyncStorage, "sessions" | "chatSessionMeta"> &
    Partial<Pick<AsyncStorage, "chatTurnTraces">>;
  readonly learnings?: Pick<AsyncStorage["memoryLearnings"], "readOperatorSource" | "findClaim">;
  readonly evidence?: Pick<EvidenceEnvelopeService, "createEnvelope">;
  readonly learned: Pick<ChatLearnedMemoryService, "listChatSessionLearnedMemory" | "extractAndPersistLearnedMemory">;
  readonly writeGate?: MemoryWriteGateService;
  resolveLearnedMemoryPolicy(sessionId: string): Promise<{ allowWrite: boolean }>;
  resolveSessionWorkspaceId?: (sessionId: string) => Promise<string | undefined>;
  isLearningRecallEnabled?: () => Promise<boolean>;
}

interface ChatMemoryCaptureHost {
  readStoredMessage(messageId: string, sessionId: string): Promise<StoredChatMemorySource | undefined>;
  scanContent(
    content: string,
    context: { workspaceId?: string; sessionId?: string; sourceRef?: string },
  ): Promise<{ blocked: boolean }>;
  proposeTraceMemoryCandidate(
    input: TraceMemoryCandidateInput,
    actorId: string,
    authority: TraceMemoryCandidateAuthority,
    options?: { deferEmbedding?: boolean; deferNotification?: boolean },
  ): Promise<TraceMemoryCandidateRecord>;
}

export class ChatMemoryCaptureService {
  public constructor(
    private readonly deps: ChatMemoryCaptureDependencies,
    private readonly host: ChatMemoryCaptureHost,
  ) {}

  /** Proposal-only consumer for the canonical completed Chat post-commit stage. */
  public async captureNaturalChatMemoryIntent(input: {
    workspaceId: string;
    sessionId: string;
    turnId: string;
    messageId: string;
    content: string;
  }): Promise<void> {
    const storage = this.deps.recallStorage;
    if (!storage?.chatTurnTraces || !this.deps.learnings || !(await this.deps.isLearningRecallEnabled?.())) return;
    if (!(await this.deps.resolveLearnedMemoryPolicy(input.sessionId)).allowWrite) return;
    const trace = await storage.chatTurnTraces.get(input.turnId);
    if (
      trace.sessionId !== input.sessionId ||
      trace.userMessageId !== input.messageId ||
      trace.status !== "completed" ||
      trace.completion?.status !== "complete"
    )
      return;
    const source = await this.deps.learnings.readOperatorSource({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      messageId: input.messageId,
    });
    if (source?.sourceHash !== createHash("sha256").update(input.content).digest("hex")) return;
    const intent = classifyMemoryIntent({
      content: input.content,
      sourceAuthority: "operator",
      sourceMessageId: input.messageId,
    });
    if (!intent.proposals.length) return;
    if (
      (
        await this.host.scanContent(input.content, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sourceRef: input.messageId,
        })
      ).blocked
    )
      return;
    if (
      this.deps.writeGate?.evaluate({ authority: "operator", content: input.content, existingClaims: [] }).decision ===
      "blocked"
    )
      return;
    await this.proposeNaturalMemoryIntents(
      {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        sourceRef: input.messageId,
        content: input.content,
        intent,
      },
      { deferNotification: true },
    );
    // The parent publishes its retained thread invalidation after commit.
    // Neither embeddings nor realtime publication runs inside this transaction.
  }

  public async extractLearnedMemory(
    sessionId: string,
    content: string,
    source: {
      role: "user" | "assistant";
      sourceRef: string;
      authority?: ChatMessageSourceAuthority;
      trace?: Pick<ChatTurnTraceRecord, "status" | "toolRuns">;
    },
  ): Promise<void> {
    const policy = await this.deps.resolveLearnedMemoryPolicy(sessionId);
    if (!policy.allowWrite) {
      return;
    }
    const workspaceId = await this.deps.resolveSessionWorkspaceId?.(sessionId);
    if (
      (
        await this.host.scanContent(content, {
          sessionId,
          workspaceId,
          sourceRef: source.sourceRef,
        })
      ).blocked
    ) {
      return;
    }
    let storedSource: { source_authority?: string; role?: string; content?: string } | undefined;
    try {
      storedSource = await this.host.readStoredMessage(source.sourceRef, sessionId);
    } catch {
      // Missing or unreadable canonical message authority is untrusted. The
      // normalization below deliberately fails closed to `unknown`.
      storedSource = undefined;
    }
    const canonicalSourceMatches =
      storedSource !== undefined && storedSource.role === source.role && storedSource.content === content;
    const sourceAuthority = canonicalSourceMatches
      ? normalizeChatMessageSourceAuthority(storedSource?.source_authority)
      : "unknown";
    let gateDecision: ReturnType<MemoryWriteGateService["evaluate"]> | undefined;
    if (this.deps.writeGate) {
      const authority: MemoryWriteAuthority = sourceAuthority === "unknown" ? "external_channel" : sourceAuthority;
      const existingClaims = (await this.deps.learned.listChatSessionLearnedMemory(sessionId, 200)).items.map(
        (item) => item.content,
      );
      gateDecision = this.deps.writeGate.evaluate({
        authority,
        content,
        existingClaims,
      });
      await this.deps.evidence?.createEnvelope({
        eventKind: "memory_write",
        workspaceId,
        sessionId,
        memoryLineage: [source.sourceRef],
        metadata: {
          decision: gateDecision,
          sourceRole: source.role,
          sourceAuthority,
          sourceRef: source.sourceRef,
          claimPreview:
            sourceAuthority === "external_channel" || sourceAuthority === "unknown"
              ? "[redacted external evidence]"
              : gateDecision.redactionStatus === "blocked_secret"
                ? "[redacted]"
                : content.slice(0, 240),
        },
      });
      if (gateDecision.decision === "blocked") {
        return;
      }
    }

    if (sourceAuthority === "external_channel" || sourceAuthority === "unknown") {
      if (!shouldExtractLearnedMemoryContent(content, source)) {
        return;
      }
      const candidates = extractLearnedMemoryCandidates(content, source.role);
      for (const candidate of candidates) {
        try {
          const evidenceHash = createHash("sha256").update(content).digest("hex");
          await this.host.proposeTraceMemoryCandidate(
            {
              workspaceId,
              candidateType: mapLearnedItemTypeToTraceCandidateType(candidate.itemType),
              sourceText: `[redacted external evidence sha256:${evidenceHash}]`,
              sourceSessionId: sessionId,
              sourceMessageId: source.sourceRef,
              proposedInsight: candidate.content,
              confidence: candidate.confidence,
              sourceRefs: [{ sourceType: "external", sourceRef: source.sourceRef }],
              metadata: {
                sourceAuthority,
                sourceSessionId: sessionId,
                sourceMessageId: source.sourceRef,
                learnedMemoryItemType: candidate.itemType,
                evidenceSha256: evidenceHash,
                gateDecision,
              },
            },
            "external-channel-ingest",
            sourceAuthority,
          );
        } catch (error) {
          await this.deps.evidence?.createEnvelope({
            eventKind: "memory_write",
            workspaceId,
            sessionId,
            memoryLineage: [source.sourceRef],
            metadata: {
              decision: "candidate_storage_unavailable",
              sourceAuthority,
              errorType: error instanceof Error ? error.name : "unknown",
            },
          });
        }
      }
      return;
    }

    const intent = classifyMemoryIntent({ content, sourceAuthority, sourceMessageId: source.sourceRef });
    if (sourceAuthority === "operator" && intent.truncated)
      await this.deps.evidence?.createEnvelope({
        eventKind: "memory_write",
        workspaceId,
        sessionId,
        memoryLineage: [source.sourceRef],
        metadata: {
          memoryIntentDisposition: "deferred_remainder",
          captureWindowChars: 8000,
          omittedChars: Math.max(0, content.length - 8000),
          sourceMessageId: source.sourceRef,
        },
      });
    if (
      intent.proposals.length &&
      workspaceId &&
      this.deps.recallStorage &&
      (await this.deps.isLearningRecallEnabled?.())
    ) {
      const session = await this.deps.recallStorage.sessions.getBySessionId(sessionId);
      const meta = await this.deps.recallStorage.chatSessionMeta.get(sessionId);
      if (
        session.kind === "dm" &&
        meta?.workspaceId === workspaceId &&
        meta.lifecycleStatus === "active" &&
        meta.origin === "operator"
      ) {
        await this.proposeNaturalMemoryIntents({
          workspaceId,
          sessionId,
          sourceRef: source.sourceRef,
          content,
          intent,
        });
      }
    }
    if (gateDecision && gateDecision.decision !== "allowed") {
      return;
    }
    await this.deps.learned.extractAndPersistLearnedMemory(sessionId, content, {
      ...source,
      authority: sourceAuthority,
      workspaceId,
    });
  }

  private async proposeNaturalMemoryIntents(
    input: { workspaceId: string; sessionId: string; sourceRef: string; content: string; intent: MemoryIntentResult },
    options: { deferNotification?: boolean } = {},
  ): Promise<void> {
    const sourceHash = createHash("sha256").update(input.content).digest("hex");
    if (
      (
        await this.deps.learnings?.readOperatorSource({
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          messageId: input.sourceRef,
        })
      )?.sourceHash !== sourceHash
    )
      return;
    for (const proposal of input.intent.proposals) {
      const claim = proposal.claimHint
        ? normalizeMemoryClaim({
            identity: {
              subject: proposal.claimHint.subject,
              predicate: proposal.claimHint.predicate,
              scope: { kind: "workspace", id: input.workspaceId },
              cardinality: proposal.claimHint.cardinality,
            },
            value: proposal.claimHint.value,
          })
        : undefined;
      const targets = claim && this.deps.learnings ? await this.deps.learnings.findClaim(input.workspaceId, claim) : [];
      const correctionTarget =
        proposal.kind === "correction" && targets.length === 1 && targets[0]?.sourceHash
          ? { sourceRef: targets[0].learningId, expectedSourceHash: targets[0].sourceHash }
          : undefined;
      await this.host.proposeTraceMemoryCandidate(
        {
          workspaceId: input.workspaceId,
          candidateType: mapLearnedItemTypeToTraceCandidateType(proposal.itemType),
          sourceSessionId: input.sessionId,
          sourceMessageId: input.sourceRef,
          sourceText: input.content.slice(0, 8000),
          proposedInsight: proposal.content,
          confidence: 0.9,
          sourceRefs: [
            { sourceType: "session", sourceRef: input.sessionId },
            { sourceType: "manual", sourceRef: input.sourceRef },
          ],
          metadata: {
            memoryIntent: proposal.kind,
            sourceMessageHash: sourceHash,
            ...(claim ? { claim } : {}),
            ...(correctionTarget
              ? { correctionTarget }
              : proposal.kind === "correction"
                ? { clarification: "Which saved preference should this replace?", targetCount: targets.length }
                : {}),
            ...(input.intent.truncated ? { truncated: true, remainderDisposition: "deferred" } : {}),
          },
        },
        "chat-memory-intent",
        "agent_proposed",
        { deferEmbedding: true, ...options },
      );
    }
  }
}

export function normalizeChatMessageSourceAuthority(value: string | undefined): ChatMessageSourceAuthority {
  return value === "operator" ||
    value === "external_channel" ||
    value === "agent_proposed" ||
    value === "trusted_lifecycle"
    ? value
    : "unknown";
}

function mapLearnedItemTypeToTraceCandidateType(value: LearnedMemoryItemType): TraceMemoryCandidateType {
  if (value === "preference") return "operator_preference";
  if (value === "goal" || value === "constraint") return "decision";
  if (value === "project_context") return "repo_fact";
  return "fact";
}
