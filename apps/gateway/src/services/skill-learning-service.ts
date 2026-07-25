/* eslint-disable max-lines -- HX-401 keeps its evidence, selection, artifact, and immutable-write invariants together. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ConflictError,
  SKILL_CORRECTION_PROVENANCE_VERSION,
  SKILL_PERMISSION_ENVELOPE_VERSION,
  assessSkillLearningEvidence,
  canonicalJsonString,
  canonicalSkillPermissionEnvelope,
  redactSecretText,
  type CapabilityArtifactRecord,
  type CapabilityProposalRecord,
  type CandidateSkillVersionRecord,
  type ChatMessageRecord,
  type ChatTurnCapabilityProfileRecord,
  type ChatTurnTraceRecord,
  type SkillCorrectionProvenanceV1,
  type SkillLearningEvidenceAssessment,
  type SkillLearningPoisoningStatus,
  type SkillPermissionEnvelopeV1,
  type ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import {
  createSkillLearningFingerprint,
  type SkillLearningArtifactRef,
  type SkillLearningEvidenceRecord,
  type SkillLearningRecurrenceSummary,
  type GovernanceJourneyEventRecord,
  type Storage,
} from "@goatcitadel/storage";

import { SECRET_CONTENT_PATTERN, validateSkillContent } from "./skill-content-validation.js";

const MAX_CORRECTION_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const HISTORY_ITEM_MAX_BYTES = 32 * 1024;
const HISTORY_PAGE_MAX_BYTES = 128 * 1024;
const HISTORY_PAGE_MAX_MESSAGES = 100;
const HISTORY_TRACE_LIMIT = 1_000;
const HISTORY_SCAN_MAX_MESSAGES = 1_000;
const SELECTION_TOKEN_MAX_BYTES = 8 * 1024;
const IDEMPOTENCY_KEY_MAX_CHARS = 384;
const MINIMUM_DISTINCT_SESSIONS = 3;
const MAX_REPLAY_ARTIFACT_BYTES = MAX_SOURCE_BYTES + MAX_CORRECTION_BYTES;

const EMPTY_PERMISSION_ENVELOPE: SkillPermissionEnvelopeV1 = {
  version: SKILL_PERMISSION_ENVELOPE_VERSION,
  toolIds: [],
  environmentVariableNames: [],
  networkOrigins: [],
  filesystem: { readScopes: [], writeScopes: [] },
  scripts: [],
  dependencies: { packages: [], nativeRequirements: [] },
};

const AUTHENTICATED_OPERATOR_SOURCES = new Set<ToolPolicyActorContext["authActorSource"]>([
  "token",
  "basic",
  "loopback",
  "device",
  "companion",
]);

const CAPABILITY_PROFILE_AUTH_SOURCES = new Set<NonNullable<ToolPolicyActorContext["authActorSource"]>>([
  "none",
  "token",
  "basic",
  "loopback",
  "sse",
  "device",
  "companion",
  "a2a_peer",
]);

type CorrectionOrigin = "authenticated_operator" | "model" | "tool" | "browser" | "unknown";

interface CorrectionAuthenticationBindingV1 {
  state: "verified" | "foreign" | "unavailable" | "invalid";
  correctionTurnId: string | null;
  capabilityProfileId: string | null;
  capabilityProfileHash: string | null;
  profileContentHash: string | null;
  authActorIdSha256: string | null;
  authActorSource: NonNullable<ToolPolicyActorContext["authActorSource"]> | null;
}

export interface SkillLearningServiceOptions {
  rootDir: string;
  candidateRoot: string;
  storage: Storage;
  readEffectiveConfigRevision: () => number;
  now?: () => string;
}

export interface SkillLearningActor {
  actorId?: string;
  authActorSource?: ToolPolicyActorContext["authActorSource"];
}

export interface SkillLearningResult {
  outcome: "candidate_created" | "evidence_recorded" | "blocked" | "quarantined" | "conflicting";
  evidenceId: string;
  candidateId?: string;
  versionId?: string;
  proposalId?: string;
  sourceKind: "learned_correction" | "history_workshop";
  poisoningStatus: SkillLearningPoisoningStatus;
  blockerCodes: string[];
  recurrence: SkillLearningRecurrenceSummary;
  callable: false;
  memoryMutation: false;
  reviewOutcome: "selected";
  replayed: boolean;
}

export interface SkillLearningHistorySelection {
  selectionId: string;
  title: string;
  sourceMessageId: string;
  correctionMessageId: string;
  sourceSha256: string;
  correctionSha256: string;
  dryRunSha256: string;
  selectionToken: string;
  secretLike: boolean;
  correctionOrigin: CorrectionOrigin;
  correctionAuthentication: CorrectionAuthenticationBindingV1;
  correctionActor: {
    actorType: "user" | "agent" | "system";
    actorIdLabel: string;
    actorIdSha256: string;
  };
  sourcePreview?: string;
  correctionPreview?: string;
}

export interface SkillLearningHistoryPage {
  reviewOutcome: "pending_selection";
  workspaceId: string;
  sessionId: string;
  workspaceRevision: number;
  effectiveConfigRevision: number;
  highWater: {
    snapshotMaxSequence: number;
    snapshotMessageCount: number;
  };
  items: SkillLearningHistorySelection[];
  nextCursor?: string;
  limits: {
    itemBytes: number;
    pageBytes: number;
    pageMessages: number;
    scanMessages: number;
  };
}

interface ResolvedLearningSource {
  workspaceId: string;
  workspaceRevision: number;
  effectiveConfigRevision: number;
  sessionId: string;
  turnId: string;
  sourceMessageId: string;
  sourceContent: string;
  correctionContent: string;
  correctionOrigin: CorrectionOrigin;
  correctionSource?: CorrectionSourceIdentity;
}

interface CorrectionSourceIdentity {
  messageId: string;
  role: "user";
  actorType: "user" | "agent" | "system";
  actorIdSha256: string;
  correctionOrigin: CorrectionOrigin;
  authentication: CorrectionAuthenticationBindingV1;
}

interface HistoryCursorV1 {
  version: "goatcitadel.skill-learning-history-cursor.v1";
  workspaceId: string;
  sessionId: string;
  workspaceRevision: number;
  effectiveConfigRevision: number;
  snapshotMaxSequence: number;
  snapshotMessageCount: number;
  offset: number;
  boundaryMessageId?: string;
}

interface HistorySelectionTokenV1 {
  version: "goatcitadel.skill-learning-selection.v1";
  workspaceId: string;
  sessionId: string;
  turnId: string;
  sourceMessageId: string;
  correctionMessageId: string;
  sourceRole: "assistant";
  sourceActorType: "user" | "agent" | "system";
  sourceActorIdSha256: string;
  correctionRole: "user";
  correctionActorType: "user" | "agent" | "system";
  correctionActorIdSha256: string;
  correctionOrigin: CorrectionOrigin;
  correctionAuthentication: CorrectionAuthenticationBindingV1;
  traceStatus: "completed";
  sourceSha256: string;
  correctionSha256: string;
  permissionEnvelopeSha256: string;
  workspaceRevision: number;
  effectiveConfigRevision: number;
  snapshotMaxSequence: number;
  snapshotMessageCount: number;
  dryRunSha256: string;
}

interface PersistLearningInput extends ResolvedLearningSource {
  sourceKind: "learned_correction" | "history_workshop";
  actorId: string;
  idempotencyKey?: string;
  permissionEnvelope?: SkillPermissionEnvelopeV1;
  highWater?: { snapshotMaxSequence: number; snapshotMessageCount: number };
}

interface LearningIdentity {
  targetKey: string;
  title: string;
  fingerprint: string;
  permissionEnvelope: SkillPermissionEnvelopeV1;
  permissionEnvelopeSha256: string;
  sourceSha256: string;
  correctionSha256: string;
  correctionActionId: string;
  evidenceId: string;
  idempotencyKey: string;
  candidateId: string;
  versionId: string;
  proposalId: string;
  journeyEventId: string;
  createdAt: string;
}

export class SkillLearningService {
  private readonly allowedRoot: string;
  private readonly candidateRoot: string;
  private readonly managedRoot: string;
  private readonly now: () => string;
  private readonly learningLocks = new Map<string, Promise<void>>();

  public constructor(private readonly options: SkillLearningServiceOptions) {
    this.allowedRoot = path.resolve(options.rootDir);
    this.candidateRoot = path.isAbsolute(options.candidateRoot)
      ? path.resolve(options.candidateRoot)
      : path.resolve(this.allowedRoot, options.candidateRoot);
    assertPathInside(this.candidateRoot, this.allowedRoot, "skill candidate root");
    this.managedRoot = this.candidateRoot;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async learnFromLatestTurn(input: {
    sessionId: string;
    correction: string;
    actor: SkillLearningActor;
    idempotencyKey?: string;
  }): Promise<SkillLearningResult> {
    const actorId = requireAuthenticatedOperator(input.actor);
    const sessionId = normalizeIdentity(input.sessionId, "session ID", 256);
    const correctionContent = requireBoundedUtf8(input.correction, "correction", MAX_CORRECTION_BYTES);
    const workspace = this.resolveWorkspace(sessionId);
    const effectiveConfigRevision = this.readEffectiveConfigRevision();
    const traces = this.options.storage.chatTurnTraces.listBySession(sessionId, HISTORY_TRACE_LIMIT);
    const trace = traces.find((item) => item.status === "completed" && Boolean(item.assistantMessageId));
    if (!trace?.assistantMessageId) {
      throw new ConflictError({ message: "No completed canonical assistant turn is available to learn from." });
    }
    const source = this.options.storage.chatMessages.get(trace.assistantMessageId);
    if (!source || source.sessionId !== sessionId || source.role !== "assistant") {
      throw new ConflictError({ message: "The latest completed turn has no canonical assistant source message." });
    }
    const sourceContent = requireBoundedUtf8(source.content, "source", MAX_SOURCE_BYTES);
    return this.persistLearning({
      workspaceId: workspace.workspaceId,
      workspaceRevision: workspace.revision,
      effectiveConfigRevision,
      sessionId,
      turnId: trace.turnId,
      sourceMessageId: source.messageId,
      sourceContent,
      correctionContent,
      correctionOrigin: "authenticated_operator",
      sourceKind: "learned_correction",
      actorId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  public createHistoryDryRun(input: {
    sessionId: string;
    actor: SkillLearningActor;
    cursor?: string;
    limit?: number;
  }): SkillLearningHistoryPage {
    const reviewingActorId = requireAuthenticatedOperator(input.actor);
    const sessionId = normalizeIdentity(input.sessionId, "session ID", 256);
    const workspace = this.resolveWorkspace(sessionId);
    const effectiveConfigRevision = this.readEffectiveConfigRevision();
    const cursor = input.cursor ? decodeHistoryCursor(input.cursor) : undefined;
    if (cursor && (cursor.workspaceId !== workspace.workspaceId || cursor.sessionId !== sessionId)) {
      throw new ConflictError({ message: "Skill-learning history cursor is foreign to this workspace or session." });
    }
    if (cursor && cursor.workspaceRevision !== workspace.revision) {
      throw new ConflictError({ message: "Skill-learning history cursor failed the workspace revision CAS." });
    }
    if (cursor && cursor.effectiveConfigRevision !== effectiveConfigRevision) {
      throw new ConflictError({ message: "Skill-learning history cursor failed the effective config revision CAS." });
    }
    const limit = normalizeLimit(input.limit, 1, 25, 10);
    const offset = cursor?.offset ?? 0;
    if (offset >= HISTORY_SCAN_MAX_MESSAGES) {
      throw new ConflictError({ message: "Skill-learning history cursor exceeds the declared scan bound." });
    }
    const requestedPageMessages = Math.min(HISTORY_PAGE_MAX_MESSAGES, Math.max(2, limit * 2));
    const page = this.options.storage.chatMessages.listOffsetPage({
      workspaceId: workspace.workspaceId,
      sessionId,
      limit: Math.min(requestedPageMessages, HISTORY_SCAN_MAX_MESSAGES - offset),
      offset,
      snapshotMaxSequence: cursor?.snapshotMaxSequence,
      snapshotMessageCount: cursor?.snapshotMessageCount,
    });
    if (
      page.cursorState === "stale" ||
      page.snapshotMaxSequence === undefined ||
      page.snapshotMessageCount === undefined
    ) {
      throw new ConflictError({ message: "Skill-learning history cursor or high-water is stale." });
    }
    const scanItems = [...page.items];
    if (cursor?.boundaryMessageId) {
      const boundary = this.options.storage.chatMessages.get(cursor.boundaryMessageId);
      if (!boundary || boundary.sessionId !== sessionId) {
        throw new ConflictError({ message: "Skill-learning history boundary is stale or foreign." });
      }
      if (!scanItems.some((message) => message.messageId === boundary.messageId)) scanItems.push(boundary);
    }
    let pageBytes = 0;
    for (const message of scanItems) {
      const bytes = Buffer.byteLength(message.content, "utf8");
      if (bytes > HISTORY_ITEM_MAX_BYTES) {
        throw new ConflictError({ message: "Skill-learning history contains an item above the per-item byte bound." });
      }
      pageBytes += bytes;
    }
    if (pageBytes > HISTORY_PAGE_MAX_BYTES) {
      throw new ConflictError({ message: "Skill-learning history page exceeds the byte bound." });
    }
    const traces = this.options.storage.chatTurnTraces.listBySession(sessionId, HISTORY_TRACE_LIMIT);
    const completedTraces = traces.filter((trace) => trace.status === "completed" && trace.assistantMessageId);
    const byAssistantMessageId = new Map(completedTraces.map((trace) => [trace.assistantMessageId as string, trace]));
    const correctionTracesByUserMessageId = new Map<string, ChatTurnTraceRecord[]>();
    for (const trace of traces) {
      if (trace.branchKind === "retry") continue;
      const existing = correctionTracesByUserMessageId.get(trace.userMessageId) ?? [];
      correctionTracesByUserMessageId.set(trace.userMessageId, [...existing, trace]);
    }
    if (traces.length === HISTORY_TRACE_LIMIT) {
      const oldestTraceStartedAt = traces.at(-1)?.startedAt;
      const uncoveredAssistant = scanItems.find(
        (message) =>
          message.role === "assistant" &&
          !byAssistantMessageId.has(message.messageId) &&
          (!oldestTraceStartedAt || message.timestamp <= oldestTraceStartedAt),
      );
      if (uncoveredAssistant) {
        throw new ConflictError({
          message: "Skill-learning history trace coverage is exhausted at the declared scan bound.",
        });
      }
    }
    const highWater = {
      snapshotMaxSequence: page.snapshotMaxSequence,
      snapshotMessageCount: page.snapshotMessageCount,
    };
    const items: SkillLearningHistorySelection[] = [];
    for (let index = 1; index < scanItems.length && items.length < limit; index += 1) {
      const correction = scanItems[index];
      const source = scanItems[index - 1];
      if (!source || !correction) continue;
      const trace = byAssistantMessageId.get(source.messageId);
      if (!trace || source.role !== "assistant" || correction.role !== "user") continue;
      const sourceSha256 = sha256Text(source.content);
      const correctionSha256 = sha256Text(correction.content);
      const permissionEnvelopeSha256 = emptyPermissionEnvelopeSha256();
      const correctionProvenance = resolveHistoryCorrectionProvenance({
        storage: this.options.storage,
        workspaceId: workspace.workspaceId,
        sessionId,
        correction,
        correctionTraces: correctionTracesByUserMessageId.get(correction.messageId) ?? [],
        reviewingActorId,
      });
      const { correctionOrigin, correctionAuthentication } = correctionProvenance;
      const tokenMaterial = {
        workspaceId: workspace.workspaceId,
        sessionId,
        turnId: trace.turnId,
        sourceMessageId: source.messageId,
        correctionMessageId: correction.messageId,
        sourceRole: source.role,
        sourceActorType: source.actorType,
        sourceActorIdSha256: sha256Text(source.actorId),
        correctionRole: correction.role,
        correctionActorType: correction.actorType,
        correctionActorIdSha256: sha256Text(correction.actorId),
        correctionOrigin,
        correctionAuthentication,
        traceStatus: "completed" as const,
        sourceSha256,
        correctionSha256,
        permissionEnvelopeSha256,
        workspaceRevision: workspace.revision,
        effectiveConfigRevision,
        ...highWater,
      };
      const dryRunSha256 = historyDryRunSha256(tokenMaterial);
      const token = encodeToken({
        version: "goatcitadel.skill-learning-selection.v1",
        ...tokenMaterial,
        dryRunSha256,
      } satisfies HistorySelectionTokenV1);
      const secretLike = containsSecretLikeContent(`${source.content}\n${correction.content}`);
      items.push({
        selectionId: `selection-${dryRunSha256.slice(0, 24)}`,
        title: secretLike ? "Secret-like correction (previews suppressed)" : deriveLearningTitle(correction.content),
        sourceMessageId: source.messageId,
        correctionMessageId: correction.messageId,
        sourceSha256,
        correctionSha256,
        dryRunSha256,
        selectionToken: token,
        secretLike,
        correctionOrigin,
        correctionAuthentication,
        correctionActor: {
          actorType: correction.actorType,
          actorIdLabel: safeActorIdLabel(correction.actorId),
          actorIdSha256: sha256Text(correction.actorId),
        },
        ...(secretLike
          ? {}
          : {
              sourcePreview: previewText(source.content),
              correctionPreview: previewText(correction.content),
            }),
      });
    }
    const nextCursor =
      page.hasOlder && page.nextOffset !== undefined && page.nextOffset < HISTORY_SCAN_MAX_MESSAGES
        ? encodeToken({
            version: "goatcitadel.skill-learning-history-cursor.v1",
            workspaceId: workspace.workspaceId,
            sessionId,
            workspaceRevision: workspace.revision,
            effectiveConfigRevision,
            ...highWater,
            offset: page.nextOffset,
            ...(page.items[0]?.messageId ? { boundaryMessageId: page.items[0].messageId } : {}),
          } satisfies HistoryCursorV1)
        : undefined;
    return {
      reviewOutcome: "pending_selection",
      workspaceId: workspace.workspaceId,
      sessionId,
      workspaceRevision: workspace.revision,
      effectiveConfigRevision,
      highWater,
      items,
      nextCursor,
      limits: {
        itemBytes: HISTORY_ITEM_MAX_BYTES,
        pageBytes: HISTORY_PAGE_MAX_BYTES,
        pageMessages: HISTORY_PAGE_MAX_MESSAGES,
        scanMessages: HISTORY_SCAN_MAX_MESSAGES,
      },
    };
  }

  public async applyHistorySelection(input: {
    sessionId: string;
    selectionToken: string;
    reviewOutcome: "selected";
    actor: SkillLearningActor;
    idempotencyKey?: string;
  }): Promise<SkillLearningResult> {
    const actorId = requireAuthenticatedOperator(input.actor);
    if (input.reviewOutcome !== "selected") {
      throw new ConflictError({
        message: "A history learning selection requires an explicit selected review outcome.",
      });
    }
    const token = decodeHistorySelection(input.selectionToken);
    const requestedSessionId = normalizeIdentity(input.sessionId, "session ID", 256);
    if (token.sessionId !== requestedSessionId) {
      throw new ConflictError({ message: "Skill-learning selection is foreign to the current Chat session." });
    }
    const workspace = this.resolveWorkspace(token.sessionId);
    if (workspace.workspaceId !== token.workspaceId || workspace.revision !== token.workspaceRevision) {
      throw new ConflictError({ message: "Skill-learning selection failed the workspace revision CAS." });
    }
    const effectiveConfigRevision = this.readEffectiveConfigRevision();
    if (effectiveConfigRevision !== token.effectiveConfigRevision) {
      throw new ConflictError({ message: "Skill-learning selection failed the effective config revision CAS." });
    }
    const snapshotPage = this.options.storage.chatMessages.listOffsetPage({
      workspaceId: workspace.workspaceId,
      sessionId: token.sessionId,
      limit: 1,
      snapshotMaxSequence: token.snapshotMaxSequence,
      snapshotMessageCount: token.snapshotMessageCount,
    });
    if (snapshotPage.cursorState === "stale") {
      throw new ConflictError({ message: "Skill-learning selection high-water is stale." });
    }
    const source = this.options.storage.chatMessages.get(token.sourceMessageId);
    const correction = this.options.storage.chatMessages.get(token.correctionMessageId);
    const trace = this.options.storage.chatTurnTraces.get(token.turnId);
    if (
      !source ||
      !correction ||
      source.sessionId !== token.sessionId ||
      correction.sessionId !== token.sessionId ||
      source.role !== "assistant" ||
      correction.role !== "user" ||
      trace.sessionId !== token.sessionId ||
      trace.assistantMessageId !== source.messageId ||
      trace.status !== "completed"
    ) {
      throw new ConflictError({ message: "Skill-learning selection no longer resolves to its canonical turn pair." });
    }
    const sourceContent = requireBoundedUtf8(source.content, "history source", HISTORY_ITEM_MAX_BYTES);
    const correctionContent = requireBoundedUtf8(correction.content, "history correction", HISTORY_ITEM_MAX_BYTES);
    const correctionTraces = this.options.storage.chatTurnTraces
      .listBySession(token.sessionId, HISTORY_TRACE_LIMIT)
      .filter((candidate) => candidate.branchKind !== "retry" && candidate.userMessageId === correction.messageId);
    const { correctionOrigin, correctionAuthentication } = resolveHistoryCorrectionProvenance({
      storage: this.options.storage,
      workspaceId: workspace.workspaceId,
      sessionId: token.sessionId,
      correction,
      correctionTraces,
      reviewingActorId: actorId,
    });
    const recomputedMaterial = {
      workspaceId: workspace.workspaceId,
      sessionId: token.sessionId,
      turnId: trace.turnId,
      sourceMessageId: source.messageId,
      correctionMessageId: correction.messageId,
      sourceRole: source.role,
      sourceActorType: source.actorType,
      sourceActorIdSha256: sha256Text(source.actorId),
      correctionRole: correction.role,
      correctionActorType: correction.actorType,
      correctionActorIdSha256: sha256Text(correction.actorId),
      correctionOrigin,
      correctionAuthentication,
      traceStatus: "completed" as const,
      sourceSha256: sha256Text(sourceContent),
      correctionSha256: sha256Text(correctionContent),
      permissionEnvelopeSha256: emptyPermissionEnvelopeSha256(),
      workspaceRevision: workspace.revision,
      effectiveConfigRevision,
      snapshotMaxSequence: token.snapshotMaxSequence,
      snapshotMessageCount: token.snapshotMessageCount,
    };
    if (
      canonicalJsonString(recomputedMaterial) !==
        canonicalJsonString({
          workspaceId: token.workspaceId,
          sessionId: token.sessionId,
          turnId: token.turnId,
          sourceMessageId: token.sourceMessageId,
          correctionMessageId: token.correctionMessageId,
          sourceRole: token.sourceRole,
          sourceActorType: token.sourceActorType,
          sourceActorIdSha256: token.sourceActorIdSha256,
          correctionRole: token.correctionRole,
          correctionActorType: token.correctionActorType,
          correctionActorIdSha256: token.correctionActorIdSha256,
          correctionOrigin: token.correctionOrigin,
          correctionAuthentication: token.correctionAuthentication,
          traceStatus: token.traceStatus,
          sourceSha256: token.sourceSha256,
          correctionSha256: token.correctionSha256,
          permissionEnvelopeSha256: token.permissionEnvelopeSha256,
          workspaceRevision: token.workspaceRevision,
          effectiveConfigRevision: token.effectiveConfigRevision,
          snapshotMaxSequence: token.snapshotMaxSequence,
          snapshotMessageCount: token.snapshotMessageCount,
        }) ||
      historyDryRunSha256(recomputedMaterial) !== token.dryRunSha256
    ) {
      throw new ConflictError({ message: "Skill-learning selection bytes or dry-run fingerprint changed." });
    }
    this.assertAdjacentPairAtHighWater(token);
    return this.persistLearning({
      workspaceId: workspace.workspaceId,
      workspaceRevision: workspace.revision,
      effectiveConfigRevision,
      sessionId: token.sessionId,
      turnId: trace.turnId,
      sourceMessageId: source.messageId,
      sourceContent,
      correctionContent,
      correctionOrigin,
      correctionSource: {
        messageId: correction.messageId,
        role: "user",
        actorType: correction.actorType,
        actorIdSha256: sha256Text(correction.actorId),
        correctionOrigin,
        authentication: correctionAuthentication,
      },
      sourceKind: "history_workshop",
      actorId,
      idempotencyKey: input.idempotencyKey ?? `history:${token.dryRunSha256}`,
      highWater: {
        snapshotMaxSequence: token.snapshotMaxSequence,
        snapshotMessageCount: token.snapshotMessageCount,
      },
    });
  }

  private assertAdjacentPairAtHighWater(token: HistorySelectionTokenV1): void {
    let offset = 0;
    let newerBoundary: { messageId: string } | undefined;
    while (offset < HISTORY_SCAN_MAX_MESSAGES) {
      const remaining = HISTORY_SCAN_MAX_MESSAGES - offset;
      const page = this.options.storage.chatMessages.listOffsetPage({
        workspaceId: token.workspaceId,
        sessionId: token.sessionId,
        limit: Math.min(1_000, remaining),
        offset,
        snapshotMaxSequence: token.snapshotMaxSequence,
        snapshotMessageCount: token.snapshotMessageCount,
      });
      if (page.cursorState === "stale") break;
      for (let index = 1; index < page.items.length; index += 1) {
        const source = page.items[index - 1];
        const correction = page.items[index];
        if (source?.messageId === token.sourceMessageId && correction?.messageId === token.correctionMessageId) return;
      }
      const oldest = page.items[0];
      const newest = page.items.at(-1);
      if (newest?.messageId === token.sourceMessageId && newerBoundary?.messageId === token.correctionMessageId) return;
      if (!page.hasOlder || page.nextOffset === undefined || !oldest) break;
      newerBoundary = oldest;
      offset = page.nextOffset;
    }
    throw new ConflictError({
      message: "Skill-learning selection is not an adjacent canonical source/correction pair.",
    });
  }

  private async persistLearning(input: PersistLearningInput): Promise<SkillLearningResult> {
    const sourceContent = requireBoundedUtf8(input.sourceContent, "source", MAX_SOURCE_BYTES);
    const correctionContent = requireBoundedUtf8(input.correctionContent, "correction", MAX_CORRECTION_BYTES);
    const permissionEnvelope = input.permissionEnvelope ?? EMPTY_PERMISSION_ENVELOPE;
    const secretLikeContent = containsSecretLikeContent(`${sourceContent}\n${correctionContent}`);
    const identity = this.buildIdentity(input, sourceContent, correctionContent, permissionEnvelope, secretLikeContent);
    return this.withLearningLock(identity.candidateId, () =>
      this.persistLearningLocked(input, sourceContent, correctionContent, identity, secretLikeContent),
    );
  }

  private async persistLearningLocked(
    input: PersistLearningInput,
    sourceContent: string,
    correctionContent: string,
    identity: LearningIdentity,
    secretLikeContent: boolean,
  ): Promise<SkillLearningResult> {
    this.assertLearningRevisions(input);
    const existing = this.options.storage.skillLearningEvidence.findByIdempotencyKey(identity.idempotencyKey);
    if (existing) {
      assertEvidenceReplayMatches(existing, input, identity);
      return this.replayResult(existing, input, { ...identity, createdAt: existing.createdAt });
    }

    const priorRecurrence = this.options.storage.skillLearningEvidence.summarizeRecurrence({
      workspaceId: input.workspaceId,
      targetKey: identity.targetKey,
      fingerprint: identity.fingerprint,
      minimumDistinctSessions: MINIMUM_DISTINCT_SESSIONS,
    });
    const skillMarkdown = buildLearnedSkillMarkdown(identity.title, correctionContent, identity.targetKey);
    const validation = validateSkillContent({ skillMarkdown });
    const assessment = assessSkillLearningEvidence({
      workspaceMatches: this.resolveWorkspace(input.sessionId).workspaceId === input.workspaceId,
      sourceReferenceValid: this.isCanonicalSourceReference(input),
      secretLikeContent,
      correctionOrigin: input.correctionOrigin,
      validationPassed: validation.valid,
      permissionDiffDisposition: "none",
      conflictingFingerprint: priorRecurrence.hasConflictingFingerprint || priorRecurrence.hasNonCleanEvidence,
    });
    this.assertLearningRevisions(input);
    const evidenceArtifacts = secretLikeContent
      ? undefined
      : await this.persistEvidenceArtifacts(input, identity, sourceContent, correctionContent);
    const provenance = buildProvenance(input, identity, evidenceArtifacts);
    const evidence: SkillLearningEvidenceRecord = {
      evidenceId: identity.evidenceId,
      idempotencyKey: identity.idempotencyKey,
      workspaceId: input.workspaceId,
      targetKey: identity.targetKey,
      fingerprint: identity.fingerprint,
      sourceKind: "chat_turn",
      sourceSessionId: input.sessionId,
      sourceTurnId: input.turnId,
      sourceMessageId: input.sourceMessageId,
      correctionActionId: identity.correctionActionId,
      actorId: input.actorId,
      sourceSha256: identity.sourceSha256,
      correctionSha256: identity.correctionSha256,
      sourceArtifact: evidenceArtifacts?.source,
      correctionArtifact: evidenceArtifacts?.correction,
      provenance,
      poisoningStatus: assessment.poisoningStatus,
      blockerCodes: assessment.blockerCodes,
      createdAt: identity.createdAt,
    };
    const priorSupportingEvidence = this.options.storage.skillLearningEvidence
      .listByFingerprint(input.workspaceId, identity.targetKey, identity.fingerprint, 500)
      .filter((item) => item.poisoningStatus === "clean" && item.sourceKind === "chat_turn");
    const supportingEvidence =
      assessment.poisoningStatus === "clean"
        ? [...priorSupportingEvidence, evidence].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
        : priorSupportingEvidence;
    const prospectiveSessions = new Set(
      supportingEvidence.map((item) => item.sourceSessionId).filter((item): item is string => Boolean(item)),
    );
    const automaticStagingEligible =
      assessment.poisoningStatus === "clean" &&
      prospectiveSessions.size >= MINIMUM_DISTINCT_SESSIONS &&
      !priorRecurrence.hasConflictingFingerprint &&
      !priorRecurrence.hasNonCleanEvidence &&
      supportingEvidence.length <= 500 &&
      priorRecurrence.distinctSessionCount < 500;
    const prospectiveRecurrence: SkillLearningRecurrenceSummary = {
      ...priorRecurrence,
      distinctSessionCount: prospectiveSessions.size,
      automaticStagingEligible,
    };
    let existingMatchingCandidate = this.options.storage.candidateSkillVersions
      .listByCandidateId(identity.candidateId, 500)
      .find((item) => item.sourceFingerprint === identity.fingerprint);
    const eligibilityTransition = !priorRecurrence.automaticStagingEligible && automaticStagingEligible;
    const transitionIdentity = {
      method: "INTERNAL",
      routePath: "/skill-learning/candidate-transition",
      idempotencyKey: `transition-${sha256Text(`${input.workspaceId}\u0000${identity.targetKey}\u0000${identity.fingerprint}`)}`,
      actorScope: input.workspaceId,
    };
    let transitionClaimToken: string | undefined;
    if (eligibilityTransition && !existingMatchingCandidate) {
      const claim = this.options.storage.mutationIdempotency.claim({
        ...transitionIdentity,
        payloadHash: identity.fingerprint,
        now: identity.createdAt,
        leaseDurationMs: 5 * 60 * 1_000,
      });
      if (claim.outcome === "claimed") {
        transitionClaimToken = claim.record.claimToken;
      } else if (claim.outcome === "duplicate") {
        existingMatchingCandidate = this.options.storage.candidateSkillVersions
          .listByCandidateId(identity.candidateId, 500)
          .find((item) => item.sourceFingerprint === identity.fingerprint);
        if (!existingMatchingCandidate) {
          throw new ConflictError({
            message: "Completed skill-learning transition is missing its governed candidate.",
          });
        }
      } else if (claim.outcome === "in_progress") {
        throw new ConflictError({
          message: "Skill-learning candidate transition is already in progress; retry this evidence.",
        });
      } else {
        throw new ConflictError({
          message: "Skill-learning candidate transition identity conflicts with prior bytes.",
        });
      }
    }

    let candidate: CandidateSkillVersionRecord | undefined;
    let candidateArtifacts: CandidateArtifacts | undefined;
    let transactionCommitted = false;
    try {
      if (eligibilityTransition && !existingMatchingCandidate && transitionClaimToken) {
        this.assertLearningRevisions(input);
        candidateArtifacts = await this.persistCandidateArtifacts({
          input,
          identity,
          evidence,
          skillMarkdown,
          validation,
          supportingEvidenceIds: supportingEvidence.map((item) => item.evidenceId),
          distinctSessionCount: prospectiveSessions.size,
        });
        candidate = buildCandidateRecord(this.options.rootDir, input, identity, candidateArtifacts);
      }

      this.options.storage.runImmediateTransaction(() => {
        this.assertLearningRevisions(input);
        const currentRecurrence = this.options.storage.skillLearningEvidence.summarizeRecurrence({
          workspaceId: input.workspaceId,
          targetKey: identity.targetKey,
          fingerprint: identity.fingerprint,
          minimumDistinctSessions: MINIMUM_DISTINCT_SESSIONS,
        });
        if (canonicalJsonString(currentRecurrence) !== canonicalJsonString(priorRecurrence)) {
          throw new ConflictError({
            message: "Skill-learning recurrence changed before the atomic candidate decision; retry.",
          });
        }
        const currentMatchingCandidate = this.options.storage.candidateSkillVersions
          .listByCandidateId(identity.candidateId, 500)
          .find((item) => item.sourceFingerprint === identity.fingerprint);
        if (currentMatchingCandidate?.versionId !== existingMatchingCandidate?.versionId) {
          throw new ConflictError({
            message: "Skill-learning candidate state changed before the atomic transition; retry.",
          });
        }
        const candidateAggregateChanges = Boolean(
          candidate || (assessment.poisoningStatus === "clean" && existingMatchingCandidate),
        );
        const candidateAggregateAlreadyExists = Boolean(
          this.options.storage.skillAggregateRevisions.get("candidate_skill", identity.candidateId) ||
          this.options.storage.candidateSkillVersions.listByCandidateId(identity.candidateId, 1).length > 0,
        );
        const persistLearningMutation = () => {
          const storedEvidence = this.options.storage.skillLearningEvidence.create(evidence);
          if (candidate) {
            this.options.storage.candidateSkillVersions.upsert(candidate);
            this.options.storage.candidateSkillEvidenceLinks.create({
              versionId: candidate.versionId,
              evidenceId: storedEvidence.evidenceId,
              linkedAt: identity.createdAt,
            });
            for (const supporting of supportingEvidence) {
              if (supporting.evidenceId === storedEvidence.evidenceId) continue;
              this.options.storage.candidateSkillEvidenceLinks.create({
                versionId: candidate.versionId,
                evidenceId: supporting.evidenceId,
                linkedAt: identity.createdAt,
              });
            }
            this.persistProposal(
              input,
              identity,
              assessment,
              prospectiveRecurrence,
              candidateArtifacts as CandidateArtifacts,
            );
            for (const lifecycleEvent of buildCandidateLifecycleJourneyEvents(
              input,
              identity,
              storedEvidence,
              candidate,
              candidateArtifacts as CandidateArtifacts,
            )) {
              this.options.storage.governanceJourneyEvents.create(lifecycleEvent);
            }
          } else if (assessment.poisoningStatus === "clean" && existingMatchingCandidate) {
            this.options.storage.candidateSkillEvidenceLinks.create({
              versionId: existingMatchingCandidate.versionId,
              evidenceId: storedEvidence.evidenceId,
              linkedAt: identity.createdAt,
            });
          }
          this.options.storage.governanceJourneyEvents.create(
            buildJourneyEvent(
              input,
              identity,
              evidence,
              assessment.poisoningStatus === "clean" ? (candidate ?? existingMatchingCandidate) : undefined,
              Boolean(candidate),
              evidenceArtifacts,
              candidateArtifacts,
            ),
          );
        };

        if (candidateAggregateChanges && candidateAggregateAlreadyExists) {
          const expectedRevision = this.options.storage.skillAggregateRevisions.ensure(
            "candidate_skill",
            identity.candidateId,
            identity.createdAt,
          ).revision;
          this.options.storage.skillAggregateRevisions.runWithRevision(
            "candidate_skill",
            identity.candidateId,
            expectedRevision,
            () => {
              persistLearningMutation();
              return { value: undefined, changed: true };
            },
            identity.createdAt,
          );
        } else {
          persistLearningMutation();
          if (candidate) {
            this.options.storage.skillAggregateRevisions.ensure(
              "candidate_skill",
              identity.candidateId,
              identity.createdAt,
            );
          }
        }
      });
      transactionCommitted = true;
      if (transitionClaimToken) {
        this.options.storage.mutationIdempotency.markCompleted({
          ...transitionIdentity,
          updatedAt: identity.createdAt,
          claimToken: transitionClaimToken,
        });
      }
    } catch (error) {
      if (transitionClaimToken && !transactionCommitted) {
        this.options.storage.mutationIdempotency.markFailed({
          ...transitionIdentity,
          updatedAt: identity.createdAt,
          claimToken: transitionClaimToken,
        });
      }
      throw error;
    }
    const recurrence = this.options.storage.skillLearningEvidence.summarizeRecurrence({
      workspaceId: input.workspaceId,
      targetKey: identity.targetKey,
      fingerprint: identity.fingerprint,
      minimumDistinctSessions: MINIMUM_DISTINCT_SESSIONS,
    });
    return buildResult(
      input.sourceKind,
      evidence,
      recurrence,
      candidate,
      candidate ? identity.proposalId : undefined,
      false,
    );
  }

  private buildIdentity(
    input: PersistLearningInput,
    sourceContent: string,
    correctionContent: string,
    permissionEnvelope: SkillPermissionEnvelopeV1,
    secretLikeContent: boolean,
  ): LearningIdentity {
    const permissionEnvelopeSha256 = sha256Text(canonicalSkillPermissionEnvelope(permissionEnvelope));
    const sourceSha256 = sha256Text(sourceContent);
    const correctionSha256 = sha256Text(correctionContent);
    const title = secretLikeContent ? "Secret-like correction evidence" : deriveLearningTitle(correctionContent);
    const targetKey = secretLikeContent ? `skill:secret-like-${correctionSha256.slice(0, 24)}` : deriveTargetKey(title);
    const fingerprint = createSkillLearningFingerprint({
      workspaceId: input.workspaceId,
      targetKey,
      title,
      correctedBehavior: correctionContent,
      permissionEnvelopeSha256,
    });
    const defaultKeyMaterial = canonicalJsonString({
      version: "goatcitadel.hx401-idempotency.v1",
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceMessageId: input.sourceMessageId,
      sourceSha256,
      correctionSha256,
      actorId: input.actorId,
      sourceKind: input.sourceKind,
    });
    const rawIdempotencyKey = input.idempotencyKey
      ? normalizeIdentity(input.idempotencyKey, "idempotency key", IDEMPOTENCY_KEY_MAX_CHARS)
      : `canonical:${sha256Text(defaultKeyMaterial)}`;
    const idempotencyKey = input.idempotencyKey
      ? `hx401:operator:${sha256Text(rawIdempotencyKey)}`
      : `hx401:${rawIdempotencyKey}`;
    const operationDigest = sha256Text(idempotencyKey);
    const candidateId = `learned-${sha256Text(`${input.workspaceId}\u0000${targetKey}`).slice(0, 24)}`;
    return {
      targetKey,
      title,
      fingerprint,
      permissionEnvelope,
      permissionEnvelopeSha256,
      sourceSha256,
      correctionSha256,
      correctionActionId: `learn-action-${operationDigest.slice(0, 24)}`,
      evidenceId: `learning-evidence-${operationDigest.slice(0, 24)}`,
      idempotencyKey,
      candidateId,
      versionId: `learn-version-${operationDigest.slice(0, 24)}`,
      proposalId: `learn-proposal-${operationDigest.slice(0, 24)}`,
      journeyEventId: `journey-hx401-${operationDigest.slice(0, 24)}`,
      createdAt: canonicalTimestamp(this.now()),
    };
  }

  private isCanonicalSourceReference(input: PersistLearningInput): boolean {
    const meta = this.options.storage.chatSessionMeta.get(input.sessionId);
    const message = this.options.storage.chatMessages.get(input.sourceMessageId);
    try {
      const trace = this.options.storage.chatTurnTraces.get(input.turnId);
      return (
        meta?.workspaceId === input.workspaceId &&
        message?.sessionId === input.sessionId &&
        message.role === "assistant" &&
        message.content === input.sourceContent &&
        trace.sessionId === input.sessionId &&
        trace.assistantMessageId === input.sourceMessageId &&
        trace.status === "completed"
      );
    } catch {
      return false;
    }
  }

  private resolveWorkspace(sessionId: string) {
    const meta = this.options.storage.chatSessionMeta.get(sessionId);
    if (!meta?.workspaceId) {
      throw new ConflictError({ message: "Skill learning requires a canonical workspace-scoped Chat session." });
    }
    const workspace = this.options.storage.workspaces.get(meta.workspaceId);
    if (workspace.lifecycleStatus !== "active") {
      throw new ConflictError({ message: "Skill learning is unavailable for an inactive workspace." });
    }
    return workspace;
  }

  private readEffectiveConfigRevision(): number {
    let revision: number;
    try {
      revision = this.options.readEffectiveConfigRevision();
    } catch {
      throw new ConflictError({ message: "Skill learning cannot read the effective config revision." });
    }
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new ConflictError({ message: "Skill learning received an invalid effective config revision." });
    }
    return revision;
  }

  private assertLearningRevisions(
    input: Pick<PersistLearningInput, "workspaceId" | "workspaceRevision" | "effectiveConfigRevision">,
  ): void {
    let workspace;
    try {
      workspace = this.options.storage.workspaces.get(input.workspaceId);
    } catch {
      throw new ConflictError({ message: "Skill-learning write failed the workspace revision CAS." });
    }
    if (workspace.lifecycleStatus !== "active" || workspace.revision !== input.workspaceRevision) {
      throw new ConflictError({ message: "Skill-learning write failed the workspace revision CAS." });
    }
    if (this.readEffectiveConfigRevision() !== input.effectiveConfigRevision) {
      throw new ConflictError({ message: "Skill-learning write failed the effective config revision CAS." });
    }
  }

  private async persistEvidenceArtifacts(
    input: PersistLearningInput,
    identity: LearningIdentity,
    sourceContent: string,
    correctionContent: string,
  ): Promise<{ source: SkillLearningArtifactRef; correction: SkillLearningArtifactRef }> {
    const relSegments = ["evidence", identity.evidenceId];
    await this.persistExactDirectory(
      relSegments,
      { "source.txt": sourceContent, "correction.txt": correctionContent },
      () => this.assertLearningRevisions(input),
    );
    return {
      source: {
        artifactId: `${identity.evidenceId}-source`,
        sha256: identity.sourceSha256,
        bytes: Buffer.byteLength(sourceContent, "utf8"),
      },
      correction: {
        artifactId: `${identity.evidenceId}-correction`,
        sha256: identity.correctionSha256,
        bytes: Buffer.byteLength(correctionContent, "utf8"),
      },
    };
  }

  private async persistCandidateArtifacts(input: {
    input: PersistLearningInput;
    identity: LearningIdentity;
    evidence: SkillLearningEvidenceRecord;
    skillMarkdown: string;
    validation: ReturnType<typeof validateSkillContent>;
    supportingEvidenceIds: string[];
    distinctSessionCount: number;
  }): Promise<CandidateArtifacts> {
    const relSegments = ["candidates", input.identity.candidateId, input.identity.versionId];
    const { manifest, proof } = buildCandidateFileContents(input);
    await this.persistExactDirectory(
      relSegments,
      { "manifest.json": manifest, "SKILL.md": input.skillMarkdown, "proof.json": proof },
      () => this.assertLearningRevisions(input.input),
    );
    return {
      bundlePath: path.join(this.managedRoot, ...relSegments),
      manifest: buildCapabilityArtifact(
        this.options.rootDir,
        path.join(this.managedRoot, ...relSegments, "manifest.json"),
        `${input.identity.versionId}-manifest`,
        manifest,
        "application/json",
        input.identity.createdAt,
      ),
      instruction: buildCapabilityArtifact(
        this.options.rootDir,
        path.join(this.managedRoot, ...relSegments, "SKILL.md"),
        `${input.identity.versionId}-instructions`,
        input.skillMarkdown,
        "text/markdown",
        input.identity.createdAt,
      ),
      proof: buildCapabilityArtifact(
        this.options.rootDir,
        path.join(this.managedRoot, ...relSegments, "proof.json"),
        `${input.identity.versionId}-proof`,
        proof,
        "application/json",
        input.identity.createdAt,
      ),
    };
  }

  private async persistExactDirectory(
    relSegments: string[],
    files: Record<string, string>,
    assertCurrentRevisions?: () => void,
  ): Promise<void> {
    assertCurrentRevisions?.();
    const managedRealRoot = await this.resolveSafeManagedRoot();
    const sanitizedSegments = relSegments.map(sanitizePathSegment);
    const parentPath = await ensureRealDirectories(managedRealRoot, sanitizedSegments.slice(0, -1));
    const finalPath = path.join(parentPath, sanitizedSegments.at(-1) as string);
    assertPathInside(finalPath, managedRealRoot, "skill learning artifact directory");
    if (await pathExists(finalPath)) {
      await verifyExactDirectory(finalPath, files);
      assertCurrentRevisions?.();
      return;
    }
    const tempPath = path.join(
      parentPath,
      `.hx401-${sha256Text(canonicalJsonString({ relSegments, files })).slice(0, 20)}.tmp`,
    );
    assertPathInside(tempPath, managedRealRoot, "skill learning temporary artifact directory");
    if (await pathExists(tempPath)) {
      try {
        await verifyExactDirectory(tempPath, files);
      } catch {
        // A crash can leave only an uncommitted temp directory. It is never a
        // durable artifact reference, so discard it and rebuild exact bytes.
        await fs.rm(tempPath, { recursive: true, force: true });
      }
    }
    if (!(await pathExists(tempPath))) {
      await fs.mkdir(tempPath, { recursive: false });
      try {
        for (const [filename, content] of Object.entries(files)) {
          await fs.writeFile(path.join(tempPath, sanitizePathSegment(filename)), content, {
            encoding: "utf8",
            flag: "wx",
          });
        }
      } catch (error) {
        await fs.rm(tempPath, { recursive: true, force: true });
        throw error;
      }
    }
    try {
      assertCurrentRevisions?.();
    } catch (error) {
      await fs.rm(tempPath, { recursive: true, force: true });
      throw error;
    }
    try {
      await fs.rename(tempPath, finalPath);
    } catch (error) {
      if (!(await pathExists(finalPath))) throw error;
      await verifyExactDirectory(finalPath, files);
      await fs.rm(tempPath, { recursive: true, force: true });
    }
    await verifyExactDirectory(finalPath, files);
  }

  private async resolveSafeManagedRoot(): Promise<string> {
    const realAllowedRoot = await fs.realpath(this.allowedRoot);
    const relative = path.relative(this.allowedRoot, this.candidateRoot);
    assertPathInside(this.candidateRoot, this.allowedRoot, "skill candidate root");
    const segments = relative.split(path.sep).filter(Boolean).map(sanitizePathSegment);
    return ensureRealDirectories(realAllowedRoot, segments);
  }

  private async resolveSafeArtifactDirectory(relSegments: string[]): Promise<string> {
    const realAllowedRoot = await fs.realpath(this.allowedRoot);
    const relative = path.relative(this.allowedRoot, this.candidateRoot);
    assertPathInside(this.candidateRoot, this.allowedRoot, "skill candidate root");
    const rootSegments = relative.split(path.sep).filter(Boolean).map(sanitizePathSegment);
    const managedRealRoot = await resolveExistingRealDirectories(realAllowedRoot, rootSegments);
    return resolveExistingRealDirectories(managedRealRoot, relSegments.map(sanitizePathSegment));
  }

  private async withLearningLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.learningLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.learningLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.learningLocks.get(key) === tail) this.learningLocks.delete(key);
    }
  }

  private persistProposal(
    input: PersistLearningInput,
    identity: LearningIdentity,
    assessment: SkillLearningEvidenceAssessment,
    recurrence: SkillLearningRecurrenceSummary,
    candidateArtifacts: CandidateArtifacts,
  ): void {
    const expected = buildProposalRecord(input, identity, assessment, recurrence, candidateArtifacts);
    const existing = this.options.storage.capabilityProposals.find(identity.proposalId);
    if (existing && canonicalJsonString(existing) !== canonicalJsonString(expected)) {
      throw new ConflictError({ message: `Learning proposal ${identity.proposalId} conflicts with immutable replay.` });
    }
    if (!existing) this.options.storage.capabilityProposals.upsert(expected);
  }

  private async replayResult(
    evidence: SkillLearningEvidenceRecord,
    input: PersistLearningInput,
    identity: LearningIdentity,
  ): Promise<SkillLearningResult> {
    if (evidence.sourceArtifact && evidence.correctionArtifact) {
      const evidenceDirectory = await this.resolveSafeArtifactDirectory(["evidence", evidence.evidenceId]);
      await verifyExactDirectory(evidenceDirectory, {
        "source.txt": input.sourceContent,
        "correction.txt": input.correctionContent,
      });
    }
    const journeyEvent = this.options.storage.governanceJourneyEvents.find(identity.journeyEventId);
    if (!journeyEvent) {
      throw new ConflictError({ message: "Skill-learning evidence is missing its Journey event." });
    }
    assertJourneyReplayMatches(journeyEvent, input, identity, evidence);
    const candidate = this.options.storage.candidateSkillVersions.find(identity.versionId);
    if (candidate) {
      const skillMarkdown = buildLearnedSkillMarkdown(identity.title, input.correctionContent, identity.targetKey);
      const validation = validateSkillContent({ skillMarkdown });
      const candidateDirectory = await this.resolveSafeArtifactDirectory([
        "candidates",
        identity.candidateId,
        identity.versionId,
      ]);
      const proofText = await readVerifiedArtifactText(
        candidateDirectory,
        "proof.json",
        candidate.proofArtifact,
        MAX_REPLAY_ARTIFACT_BYTES,
      );
      const immutableRecurrence = parseImmutableRecurrenceProof(proofText, evidence.evidenceId);
      const links = this.options.storage.candidateSkillEvidenceLinks.listByVersion(candidate.versionId, 1_000);
      if (links.length >= 1_000) {
        throw new ConflictError({
          message: "Skill-learning candidate evidence links exceed the replay verification bound.",
        });
      }
      const currentLinkIds = new Set(links.map((link) => link.evidenceId));
      if (immutableRecurrence.evidenceIds.some((evidenceId) => !currentLinkIds.has(evidenceId))) {
        throw new ConflictError({ message: "Skill-learning candidate lost immutable recurrence evidence links." });
      }
      const supportingEvidence = immutableRecurrence.evidenceIds.map((evidenceId) => {
        const supporting = this.options.storage.skillLearningEvidence.find(evidenceId);
        if (
          !supporting ||
          supporting.poisoningStatus !== "clean" ||
          supporting.sourceKind !== "chat_turn" ||
          supporting.workspaceId !== input.workspaceId ||
          supporting.targetKey !== identity.targetKey ||
          supporting.fingerprint !== identity.fingerprint ||
          !supporting.sourceSessionId
        ) {
          throw new ConflictError({
            message: "Skill-learning immutable recurrence evidence failed replay verification.",
          });
        }
        return supporting;
      });
      const distinctSessionCount = new Set(supportingEvidence.map((item) => item.sourceSessionId)).size;
      if (distinctSessionCount !== immutableRecurrence.distinctSessionCount) {
        throw new ConflictError({
          message: "Skill-learning immutable recurrence session count failed replay verification.",
        });
      }
      const fileContents = buildCandidateFileContents({
        input,
        identity,
        evidence,
        skillMarkdown,
        validation,
        supportingEvidenceIds: immutableRecurrence.evidenceIds,
        distinctSessionCount,
      });
      await verifyExactDirectory(candidateDirectory, {
        "manifest.json": fileContents.manifest,
        "SKILL.md": skillMarkdown,
        "proof.json": fileContents.proof,
      });
      const artifacts: CandidateArtifacts = {
        bundlePath: path.join(this.managedRoot, "candidates", identity.candidateId, identity.versionId),
        manifest: buildCapabilityArtifact(
          this.options.rootDir,
          path.join(this.managedRoot, "candidates", identity.candidateId, identity.versionId, "manifest.json"),
          `${identity.versionId}-manifest`,
          fileContents.manifest,
          "application/json",
          identity.createdAt,
        ),
        instruction: buildCapabilityArtifact(
          this.options.rootDir,
          path.join(this.managedRoot, "candidates", identity.candidateId, identity.versionId, "SKILL.md"),
          `${identity.versionId}-instructions`,
          skillMarkdown,
          "text/markdown",
          identity.createdAt,
        ),
        proof: buildCapabilityArtifact(
          this.options.rootDir,
          path.join(this.managedRoot, "candidates", identity.candidateId, identity.versionId, "proof.json"),
          `${identity.versionId}-proof`,
          fileContents.proof,
          "application/json",
          identity.createdAt,
        ),
      };
      const expectedCandidate = buildCandidateRecord(this.options.rootDir, input, identity, artifacts);
      if (
        canonicalJsonString(immutableCandidateProjection(expectedCandidate)) !==
        canonicalJsonString(immutableCandidateProjection(candidate))
      ) {
        throw new ConflictError({ message: "Skill-learning candidate metadata failed immutable replay verification." });
      }
      const proposal = this.options.storage.capabilityProposals.find(identity.proposalId);
      if (!proposal) {
        throw new ConflictError({ message: "Skill-learning candidate is missing its inspectable proposal." });
      }
      const expectedProposal = buildProposalRecord(
        input,
        identity,
        { poisoningStatus: evidence.poisoningStatus, blockerCodes: evidence.blockerCodes },
        { distinctSessionCount },
        artifacts,
      );
      if (
        canonicalJsonString(immutableProposalProjection(proposal)) !==
        canonicalJsonString(immutableProposalProjection(expectedProposal))
      ) {
        throw new ConflictError({ message: "Skill-learning proposal metadata failed immutable replay verification." });
      }
      for (const expectedEvent of buildCandidateLifecycleJourneyEvents(
        input,
        identity,
        evidence,
        candidate,
        artifacts,
      )) {
        const storedEvent = this.options.storage.governanceJourneyEvents.find(expectedEvent.eventId);
        if (
          !storedEvent ||
          canonicalJsonString(storedEvent) !== canonicalJsonString(normalizeJourneyEventForReplay(expectedEvent))
        ) {
          throw new ConflictError({
            message: "Skill-learning candidate is missing immutable lifecycle Journey evidence.",
          });
        }
      }
    }
    const recurrence = this.options.storage.skillLearningEvidence.summarizeRecurrence({
      workspaceId: evidence.workspaceId,
      targetKey: evidence.targetKey,
      fingerprint: evidence.fingerprint,
      minimumDistinctSessions: MINIMUM_DISTINCT_SESSIONS,
    });
    return buildResult(
      input.sourceKind,
      evidence,
      recurrence,
      candidate,
      candidate ? identity.proposalId : undefined,
      true,
    );
  }
}

interface CandidateArtifacts {
  bundlePath: string;
  manifest: CapabilityArtifactRecord;
  instruction: CapabilityArtifactRecord;
  proof: CapabilityArtifactRecord;
}

function buildCandidateFileContents(input: {
  input: PersistLearningInput;
  identity: LearningIdentity;
  evidence: SkillLearningEvidenceRecord;
  skillMarkdown: string;
  validation: ReturnType<typeof validateSkillContent>;
  supportingEvidenceIds: string[];
  distinctSessionCount: number;
}): { manifest: string; proof: string } {
  return {
    manifest: canonicalJsonString({
      manifestVersion: "goatcitadel.learned-skill-candidate.v1",
      candidateId: input.identity.candidateId,
      versionId: input.identity.versionId,
      sourceKind: input.input.sourceKind,
      workspaceId: input.input.workspaceId,
      title: input.identity.title,
      targetKey: input.identity.targetKey,
      sourceFingerprint: input.identity.fingerprint,
      permissionEnvelope: input.identity.permissionEnvelope,
      permissionEnvelopeSha256: input.identity.permissionEnvelopeSha256,
      correctionActionId: input.identity.correctionActionId,
      actorId: input.input.actorId,
      workspaceRevision: input.input.workspaceRevision,
      effectiveConfigRevision: input.input.effectiveConfigRevision,
      reviewOutcome: "selected",
      reviewSource: reviewSourceFor(input.input.sourceKind),
      correctionOrigin: input.input.correctionOrigin,
      ...(input.input.correctionSource ? { correctionSource: input.input.correctionSource } : {}),
      lifecycleState: "candidate",
      callable: false,
      memoryMutation: false,
    }),
    proof: canonicalJsonString({
      proofVersion: "goatcitadel.hx401-proof.v1",
      evidenceId: input.evidence.evidenceId,
      provenance: input.evidence.provenance,
      sourceSha256: input.identity.sourceSha256,
      correctionSha256: input.identity.correctionSha256,
      fingerprint: input.identity.fingerprint,
      workspaceRevision: input.input.workspaceRevision,
      effectiveConfigRevision: input.input.effectiveConfigRevision,
      reviewActorId: input.input.actorId,
      reviewSource: reviewSourceFor(input.input.sourceKind),
      correctionOrigin: input.input.correctionOrigin,
      ...(input.input.correctionSource ? { correctionSource: input.input.correctionSource } : {}),
      validation: input.validation,
      recurrencePolicy: {
        sameSessionCountsOnce: true,
        minimumDistinctSessions: MINIMUM_DISTINCT_SESSIONS,
        directPromotion: false,
      },
      recurrenceEvidence: {
        evidenceIds: input.supportingEvidenceIds,
        distinctSessionCount: input.distinctSessionCount,
      },
      ...(input.input.highWater ? { highWater: input.input.highWater } : {}),
      reviewOutcome: "selected",
      lifecycleState: "candidate",
      callable: false,
      memoryMutation: false,
    }),
  };
}

function buildCandidateRecord(
  rootDir: string,
  input: PersistLearningInput,
  identity: LearningIdentity,
  artifacts: CandidateArtifacts,
): CandidateSkillVersionRecord {
  return {
    candidateId: identity.candidateId,
    versionId: identity.versionId,
    sourceKind: input.sourceKind,
    lineageStatus: "governed",
    workspaceId: input.workspaceId,
    sourceFingerprint: identity.fingerprint,
    createdByActorId: input.actorId,
    title: identity.title,
    summary: "Governed correction-derived candidate; inactive until separate evaluation, approval, and promotion.",
    bundleRoot: normalizeRelPath(path.relative(rootDir, artifacts.bundlePath)),
    lifecycleState: "candidate",
    manifestArtifact: artifacts.manifest,
    instructionArtifact: artifacts.instruction,
    proofArtifact: artifacts.proof,
    createdAt: identity.createdAt,
    updatedAt: identity.createdAt,
  };
}

function buildProposalRecord(
  input: PersistLearningInput,
  identity: LearningIdentity,
  assessment: { poisoningStatus: SkillLearningPoisoningStatus; blockerCodes: readonly string[] },
  recurrence: Pick<SkillLearningRecurrenceSummary, "distinctSessionCount">,
  candidateArtifacts: CandidateArtifacts,
): CapabilityProposalRecord {
  return {
    proposalId: identity.proposalId,
    proposalKind: "skill",
    status: "proposed",
    title: `Review learned candidate: ${identity.title}`,
    summary: "Inactive learned skill candidate awaiting separate evaluation, approval, and promotion.",
    candidateId: identity.candidateId,
    activationTargetId: identity.candidateId,
    payload: {
      proposalType: "hx401_skill_learning_candidate",
      versionId: identity.versionId,
      evidenceId: identity.evidenceId,
      workspaceId: input.workspaceId,
      targetKey: identity.targetKey,
      sourceKind: input.sourceKind,
      fingerprint: identity.fingerprint,
      sourceSha256: identity.sourceSha256,
      correctionSha256: identity.correctionSha256,
      permissionEnvelopeSha256: identity.permissionEnvelopeSha256,
      artifacts: {
        manifest: {
          artifactId: candidateArtifacts.manifest.artifactId,
          sha256: candidateArtifacts.manifest.sha256,
        },
        instruction: {
          artifactId: candidateArtifacts.instruction.artifactId,
          sha256: candidateArtifacts.instruction.sha256,
        },
        proof: {
          artifactId: candidateArtifacts.proof.artifactId,
          sha256: candidateArtifacts.proof.sha256,
        },
      },
      poisoningStatus: assessment.poisoningStatus,
      blockerCodes: assessment.blockerCodes,
      distinctSessionCount: recurrence.distinctSessionCount,
      governance: {
        callable: false,
        memoryMutation: false,
        evaluationRequired: true,
        approvalRequired: true,
        promotionRequired: true,
      },
    },
    createdAt: identity.createdAt,
    updatedAt: identity.createdAt,
  };
}

function buildProvenance(
  input: PersistLearningInput,
  identity: LearningIdentity,
  artifacts?: { source: SkillLearningArtifactRef; correction: SkillLearningArtifactRef },
): SkillCorrectionProvenanceV1 {
  return {
    version: SKILL_CORRECTION_PROVENANCE_VERSION,
    action: "learn_candidate",
    correctionActionId: identity.correctionActionId,
    actorId: input.actorId,
    workspaceId: input.workspaceId,
    source: {
      kind: "chat_turn",
      sessionId: input.sessionId,
      turnId: input.turnId,
      messageId: input.sourceMessageId,
    },
    sourceSha256: identity.sourceSha256,
    correctionSha256: identity.correctionSha256,
    sourceArtifact: artifacts?.source,
    correctionArtifact: artifacts?.correction,
    fingerprint: identity.fingerprint,
    capturedAt: identity.createdAt,
  };
}

function buildJourneyEvent(
  input: PersistLearningInput,
  identity: LearningIdentity,
  evidence: SkillLearningEvidenceRecord,
  relatedCandidate: CandidateSkillVersionRecord | undefined,
  candidateCreated: boolean,
  evidenceArtifacts: { source: SkillLearningArtifactRef; correction: SkillLearningArtifactRef } | undefined,
  candidateArtifacts: CandidateArtifacts | undefined,
) {
  const artifactRefs = [
    evidenceArtifacts?.source.artifactId,
    evidenceArtifacts?.correction.artifactId,
    candidateArtifacts?.manifest.artifactId,
    candidateArtifacts?.instruction.artifactId,
    candidateArtifacts?.proof.artifactId,
  ]
    .filter((item): item is string => Boolean(item))
    .map((refId) => ({ owner: "artifact" as const, refId }));
  return {
    schemaVersion: "goatcitadel.journey-event.v1" as const,
    eventId: identity.journeyEventId,
    idempotencyKey: `journey:${identity.idempotencyKey}`,
    scopeKind: "workspace" as const,
    workspaceId: input.workspaceId,
    eventType: "skill_learning_evidence_assessed",
    subjectKind: relatedCandidate ? "candidate_skill_version" : "skill_learning_evidence",
    subjectId: relatedCandidate?.versionId ?? evidence.evidenceId,
    action: candidateCreated
      ? "candidate_staged_inactive"
      : relatedCandidate
        ? "evidence_linked_to_existing_candidate"
        : evidence.poisoningStatus === "clean"
          ? "evidence_recorded_no_candidate"
          : "candidate_staging_blocked",
    actorId: input.actorId,
    actorType: "operator" as const,
    sessionId: input.sessionId,
    turnId: input.turnId,
    fingerprint: identity.fingerprint,
    sourceKind: input.sourceKind,
    sourceId: evidence.evidenceId,
    trustDisposition: candidateCreated ? "candidate" : evidence.poisoningStatus === "clean" ? "review_only" : "blocked",
    poisoningStatus: evidence.poisoningStatus,
    evidenceRefs: [
      ...artifactRefs,
      ...(relatedCandidate ? [{ owner: "candidate" as const, refId: relatedCandidate.versionId }] : []),
    ],
    provenance: {
      sourceRequired: true,
      approvalRequired: false,
      correctionProvenanceVersion: SKILL_CORRECTION_PROVENANCE_VERSION,
      correctionActionId: identity.correctionActionId,
      sourceSha256: identity.sourceSha256,
      correctionSha256: identity.correctionSha256,
      workspaceRevision: input.workspaceRevision,
      effectiveConfigRevision: input.effectiveConfigRevision,
      reviewOutcome: "selected",
      reviewActorId: input.actorId,
      reviewSource: reviewSourceFor(input.sourceKind),
      correctionOrigin: input.correctionOrigin,
      ...(input.correctionSource ? { correctionSource: input.correctionSource } : {}),
      ...(input.highWater ? { highWater: input.highWater } : {}),
    },
    summary: {
      poisoningStatus: evidence.poisoningStatus,
      blockerCodes: evidence.blockerCodes,
      callable: false,
      memoryMutation: false,
      directPromotion: false,
    },
    occurredAt: identity.createdAt,
    recordedAt: identity.createdAt,
  };
}

function buildCandidateLifecycleJourneyEvents(
  input: PersistLearningInput,
  identity: LearningIdentity,
  evidence: SkillLearningEvidenceRecord,
  candidate: CandidateSkillVersionRecord,
  candidateArtifacts: CandidateArtifacts,
) {
  const provenance = {
    sourceRequired: true,
    approvalRequired: false,
    correctionProvenanceVersion: SKILL_CORRECTION_PROVENANCE_VERSION,
    correctionActionId: identity.correctionActionId,
    sourceSha256: identity.sourceSha256,
    correctionSha256: identity.correctionSha256,
    workspaceRevision: input.workspaceRevision,
    effectiveConfigRevision: input.effectiveConfigRevision,
    reviewOutcome: "selected",
    reviewActorId: input.actorId,
    reviewSource: reviewSourceFor(input.sourceKind),
    correctionOrigin: input.correctionOrigin,
    ...(input.correctionSource ? { correctionSource: input.correctionSource } : {}),
    ...(input.highWater ? { highWater: input.highWater } : {}),
  };
  const artifactRefs = [
    candidateArtifacts.manifest.artifactId,
    candidateArtifacts.instruction.artifactId,
    candidateArtifacts.proof.artifactId,
  ].map((refId) => ({ owner: "artifact" as const, refId }));
  const common = {
    schemaVersion: "goatcitadel.journey-event.v1" as const,
    scopeKind: "workspace" as const,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    actorType: "operator" as const,
    sessionId: input.sessionId,
    turnId: input.turnId,
    fingerprint: identity.fingerprint,
    sourceKind: input.sourceKind,
    sourceId: evidence.evidenceId,
    poisoningStatus: "clean" as const,
    provenance,
    occurredAt: identity.createdAt,
    recordedAt: identity.createdAt,
  };
  return [
    {
      ...common,
      eventId: `${identity.journeyEventId}-candidate-created`,
      idempotencyKey: `journey:${identity.idempotencyKey}:candidate-created`,
      eventType: "candidate_skill_lifecycle",
      subjectKind: "candidate_skill_version",
      subjectId: candidate.versionId,
      action: "candidate_created_inactive",
      trustDisposition: "candidate",
      evidenceRefs: [...artifactRefs, { owner: "candidate" as const, refId: candidate.versionId }],
      summary: {
        candidateId: candidate.candidateId,
        versionId: candidate.versionId,
        lifecycleState: "candidate",
        callable: false,
        directPromotion: false,
      },
    },
    {
      ...common,
      eventId: `${identity.journeyEventId}-proposal-created`,
      idempotencyKey: `journey:${identity.idempotencyKey}:proposal-created`,
      eventType: "capability_proposal_lifecycle",
      subjectKind: "capability_proposal",
      subjectId: identity.proposalId,
      action: "proposal_created",
      trustDisposition: "review_only",
      evidenceRefs: [...artifactRefs, { owner: "candidate" as const, refId: candidate.versionId }],
      summary: {
        proposalId: identity.proposalId,
        candidateId: candidate.candidateId,
        versionId: candidate.versionId,
        status: "proposed",
        activationRequired: true,
      },
    },
  ];
}

function normalizeJourneyEventForReplay(event: ReturnType<typeof buildCandidateLifecycleJourneyEvents>[number]) {
  const byKey = new Map(event.evidenceRefs.map((item) => [`${item.owner}:${item.refId}`, item]));
  return {
    ...event,
    evidenceRefs: [...byKey.values()].sort((left, right) =>
      `${left.owner}:${left.refId}`.localeCompare(`${right.owner}:${right.refId}`),
    ),
  };
}

function buildResult(
  sourceKind: "learned_correction" | "history_workshop",
  evidence: SkillLearningEvidenceRecord,
  recurrence: SkillLearningRecurrenceSummary,
  candidate: CandidateSkillVersionRecord | undefined,
  proposalId: string | undefined,
  replayed: boolean,
): SkillLearningResult {
  return {
    outcome: candidate
      ? "candidate_created"
      : evidence.poisoningStatus === "clean"
        ? "evidence_recorded"
        : evidence.poisoningStatus,
    evidenceId: evidence.evidenceId,
    candidateId: candidate?.candidateId,
    versionId: candidate?.versionId,
    proposalId,
    sourceKind,
    poisoningStatus: evidence.poisoningStatus,
    blockerCodes: evidence.blockerCodes,
    recurrence,
    callable: false,
    memoryMutation: false,
    reviewOutcome: "selected",
    replayed,
  };
}

function reviewSourceFor(
  sourceKind: PersistLearningInput["sourceKind"],
): "explicit_chat_command" | "history_dry_run_selection" {
  return sourceKind === "learned_correction" ? "explicit_chat_command" : "history_dry_run_selection";
}

function assertEvidenceReplayMatches(
  evidence: SkillLearningEvidenceRecord,
  input: PersistLearningInput,
  identity: LearningIdentity,
): void {
  const expected = {
    evidenceId: identity.evidenceId,
    workspaceId: input.workspaceId,
    targetKey: identity.targetKey,
    fingerprint: identity.fingerprint,
    sourceSessionId: input.sessionId,
    sourceTurnId: input.turnId,
    sourceMessageId: input.sourceMessageId,
    correctionActionId: identity.correctionActionId,
    actorId: input.actorId,
    sourceSha256: identity.sourceSha256,
    correctionSha256: identity.correctionSha256,
  };
  const actual = {
    evidenceId: evidence.evidenceId,
    workspaceId: evidence.workspaceId,
    targetKey: evidence.targetKey,
    fingerprint: evidence.fingerprint,
    sourceSessionId: evidence.sourceSessionId,
    sourceTurnId: evidence.sourceTurnId,
    sourceMessageId: evidence.sourceMessageId,
    correctionActionId: evidence.correctionActionId,
    actorId: evidence.actorId,
    sourceSha256: evidence.sourceSha256,
    correctionSha256: evidence.correctionSha256,
  };
  if (canonicalJsonString(expected) !== canonicalJsonString(actual)) {
    throw new ConflictError({
      message: `Skill-learning idempotency key ${identity.idempotencyKey} has different bytes.`,
    });
  }
}

function assertJourneyReplayMatches(
  event: GovernanceJourneyEventRecord,
  input: PersistLearningInput,
  identity: LearningIdentity,
  evidence: SkillLearningEvidenceRecord,
): void {
  const expectedProvenance = {
    sourceRequired: true,
    approvalRequired: false,
    correctionProvenanceVersion: SKILL_CORRECTION_PROVENANCE_VERSION,
    correctionActionId: identity.correctionActionId,
    sourceSha256: identity.sourceSha256,
    correctionSha256: identity.correctionSha256,
    workspaceRevision: input.workspaceRevision,
    effectiveConfigRevision: input.effectiveConfigRevision,
    reviewOutcome: "selected",
    reviewActorId: input.actorId,
    reviewSource: reviewSourceFor(input.sourceKind),
    correctionOrigin: input.correctionOrigin,
    ...(input.correctionSource ? { correctionSource: input.correctionSource } : {}),
    ...(input.highWater ? { highWater: input.highWater } : {}),
  };
  const expected = {
    eventId: identity.journeyEventId,
    idempotencyKey: `journey:${identity.idempotencyKey}`,
    scopeKind: "workspace",
    workspaceId: input.workspaceId,
    eventType: "skill_learning_evidence_assessed",
    actorId: input.actorId,
    actorType: "operator",
    sessionId: input.sessionId,
    turnId: input.turnId,
    fingerprint: identity.fingerprint,
    sourceKind: input.sourceKind,
    sourceId: evidence.evidenceId,
    poisoningStatus: evidence.poisoningStatus,
    provenance: expectedProvenance,
    occurredAt: identity.createdAt,
    recordedAt: identity.createdAt,
  };
  const actual = {
    eventId: event.eventId,
    idempotencyKey: event.idempotencyKey,
    scopeKind: event.scopeKind,
    workspaceId: event.workspaceId,
    eventType: event.eventType,
    actorId: event.actorId,
    actorType: event.actorType,
    sessionId: event.sessionId,
    turnId: event.turnId,
    fingerprint: event.fingerprint,
    sourceKind: event.sourceKind,
    sourceId: event.sourceId,
    poisoningStatus: event.poisoningStatus,
    provenance: event.provenance,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
  };
  if (canonicalJsonString(expected) !== canonicalJsonString(actual)) {
    throw new ConflictError({ message: "Skill-learning Journey provenance failed immutable replay verification." });
  }
}

function immutableCandidateProjection(candidate: CandidateSkillVersionRecord) {
  return {
    candidateId: candidate.candidateId,
    versionId: candidate.versionId,
    sourceKind: candidate.sourceKind,
    lineageStatus: candidate.lineageStatus,
    workspaceId: candidate.workspaceId,
    sourceFingerprint: candidate.sourceFingerprint,
    upstreamSnapshotId: candidate.upstreamSnapshotId,
    supersedesVersionId: candidate.supersedesVersionId,
    createdByActorId: candidate.createdByActorId,
    title: candidate.title,
    summary: candidate.summary,
    bundleRoot: candidate.bundleRoot,
    originatingRunId: candidate.originatingRunId,
    wrapperManifestHash: candidate.wrapperManifestHash,
    manifestArtifact: candidate.manifestArtifact,
    instructionArtifact: candidate.instructionArtifact,
    proofArtifact: candidate.proofArtifact,
    programArtifact: candidate.programArtifact,
    schemaArtifact: candidate.schemaArtifact,
    createdAt: candidate.createdAt,
  };
}

function immutableProposalProjection(proposal: CapabilityProposalRecord) {
  return {
    proposalId: proposal.proposalId,
    proposalKind: proposal.proposalKind,
    title: proposal.title,
    summary: proposal.summary,
    candidateId: proposal.candidateId,
    activationTargetId: proposal.activationTargetId,
    payload: proposal.payload,
    createdAt: proposal.createdAt,
  };
}

function parseImmutableRecurrenceProof(
  proofText: string,
  candidateCreatingEvidenceId: string,
): { evidenceIds: string[]; distinctSessionCount: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(proofText);
  } catch {
    throw new ConflictError({ message: "Skill-learning candidate proof is malformed." });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConflictError({ message: "Skill-learning candidate proof is malformed." });
  }
  const proof = parsed as Record<string, unknown>;
  const recurrence = proof.recurrenceEvidence;
  if (
    proof.proofVersion !== "goatcitadel.hx401-proof.v1" ||
    proof.evidenceId !== candidateCreatingEvidenceId ||
    !recurrence ||
    typeof recurrence !== "object" ||
    Array.isArray(recurrence)
  ) {
    throw new ConflictError({ message: "Skill-learning candidate proof has invalid immutable recurrence metadata." });
  }
  const value = recurrence as Record<string, unknown>;
  if (
    !Array.isArray(value.evidenceIds) ||
    value.evidenceIds.length < MINIMUM_DISTINCT_SESSIONS ||
    value.evidenceIds.length > 500
  ) {
    throw new ConflictError({ message: "Skill-learning candidate proof has invalid immutable recurrence evidence." });
  }
  const evidenceIds = value.evidenceIds.filter(
    (item): item is string => typeof item === "string" && item.length > 0 && item.length <= 256 && item.trim() === item,
  );
  const canonicalEvidenceIds = [...new Set(evidenceIds)].sort((left, right) => left.localeCompare(right));
  if (
    evidenceIds.length !== value.evidenceIds.length ||
    canonicalJsonString(evidenceIds) !== canonicalJsonString(canonicalEvidenceIds) ||
    !evidenceIds.includes(candidateCreatingEvidenceId) ||
    !Number.isSafeInteger(value.distinctSessionCount) ||
    (value.distinctSessionCount as number) < MINIMUM_DISTINCT_SESSIONS ||
    (value.distinctSessionCount as number) > evidenceIds.length
  ) {
    throw new ConflictError({ message: "Skill-learning candidate proof has invalid immutable recurrence evidence." });
  }
  return { evidenceIds, distinctSessionCount: value.distinctSessionCount as number };
}

function buildCapabilityArtifact(
  rootDir: string,
  absolutePath: string,
  artifactId: string,
  content: string,
  mimeType: string,
  createdAt: string,
): CapabilityArtifactRecord {
  return {
    artifactId,
    relPath: normalizeRelPath(path.relative(rootDir, absolutePath)),
    sha256: sha256Text(content),
    bytes: Buffer.byteLength(content, "utf8"),
    mimeType,
    createdAt,
  };
}

function buildLearnedSkillMarkdown(title: string, correction: string, targetKey: string): string {
  const skillName = `learned-${sha256Text(targetKey).slice(0, 12)}`;
  return [
    "---",
    `name: ${skillName}`,
    `description: Governed candidate instructions for ${yamlScalar(title)}; review is required before use.`,
    "---",
    "",
    `# ${title}`,
    "",
    "## When to use",
    "",
    "Use only after this inactive candidate has completed separate evaluation, approval, and promotion.",
    "",
    "## Instructions",
    "",
    correction,
    "",
    "## Boundaries",
    "",
    "- This candidate is not callable in its current lifecycle state.",
    "- This candidate does not create or update durable memory.",
    "- Any future activation remains subject to normal policy and approval checks.",
    "",
  ].join("\n");
}

function requireAuthenticatedOperator(actor: SkillLearningActor): string {
  const actorId = normalizeIdentity(actor.actorId, "authenticated actor ID", 256);
  if (!actor.authActorSource || !AUTHENTICATED_OPERATOR_SOURCES.has(actor.authActorSource)) {
    throw new ConflictError({ message: "Skill learning requires an authenticated operator action." });
  }
  if (containsSecretLikeContent(actorId)) {
    throw new ConflictError({ message: "Skill learning rejects secret-like authenticated actor identifiers." });
  }
  return actorId;
}

function safeActorIdLabel(actorId: string): string {
  return `sha256:${sha256Text(actorId).slice(0, 16)}`;
}

function resolveHistoryCorrectionProvenance(input: {
  storage: Storage;
  workspaceId: string;
  sessionId: string;
  correction: ChatMessageRecord;
  correctionTraces: ChatTurnTraceRecord[];
  reviewingActorId: string;
}): {
  correctionOrigin: CorrectionOrigin;
  correctionAuthentication: CorrectionAuthenticationBindingV1;
} {
  const correctionAuthentication = resolveCorrectionAuthenticationBinding(input);
  const storedOrigin = classifyStoredCorrectionOrigin(input.correction.actorType, input.correction.actorId);
  const canonicalChatOperatorProjection =
    input.correction.actorType === "user" && input.correction.actorId === "operator";
  return {
    correctionOrigin:
      canonicalChatOperatorProjection && correctionAuthentication.state === "verified"
        ? "authenticated_operator"
        : storedOrigin,
    correctionAuthentication,
  };
}

function resolveCorrectionAuthenticationBinding(input: {
  storage: Storage;
  workspaceId: string;
  sessionId: string;
  correction: ChatMessageRecord;
  correctionTraces: ChatTurnTraceRecord[];
  reviewingActorId: string;
}): CorrectionAuthenticationBindingV1 {
  if (input.correctionTraces.length !== 1) {
    return emptyCorrectionAuthenticationBinding(input.correctionTraces.length === 0 ? "unavailable" : "invalid");
  }
  const trace = input.correctionTraces[0]!;
  const unavailable = emptyCorrectionAuthenticationBinding("unavailable", trace.turnId);
  let profile: ChatTurnCapabilityProfileRecord | undefined;
  try {
    profile = input.storage.chatTurnCapabilityProfiles.findByTurn(trace.turnId);
  } catch {
    return emptyCorrectionAuthenticationBinding("invalid", trace.turnId);
  }
  if (!profile) return unavailable;
  const authActorId = profile.identity.authActorId;
  const authActorSource = profile.identity.authActorSource ?? null;
  const binding = {
    state: "invalid" as const,
    correctionTurnId: trace.turnId,
    capabilityProfileId: profile.profileId,
    capabilityProfileHash: profile.hashes.profileHash,
    profileContentHash: profile.selection.contentHash,
    authActorIdSha256: authActorId ? sha256Text(authActorId) : null,
    authActorSource,
  } satisfies CorrectionAuthenticationBindingV1;
  const structurallyBound =
    trace.sessionId === input.sessionId &&
    trace.userMessageId === input.correction.messageId &&
    trace.capabilityProfileId === profile.profileId &&
    trace.capabilityProfileHash === profile.hashes.profileHash &&
    profile.identity.turnId === trace.turnId &&
    profile.identity.sessionId === input.sessionId &&
    profile.identity.workspaceId === input.workspaceId &&
    profile.selection.contentHash === canonicalProfileContentHash(input.correction.content) &&
    Boolean(authActorId) &&
    authActorSource !== null &&
    AUTHENTICATED_OPERATOR_SOURCES.has(authActorSource);
  if (!structurallyBound || !authActorId) return binding;
  return {
    ...binding,
    state: authActorId === input.reviewingActorId ? "verified" : "foreign",
  };
}

function emptyCorrectionAuthenticationBinding(
  state: Extract<CorrectionAuthenticationBindingV1["state"], "unavailable" | "invalid">,
  correctionTurnId: string | null = null,
): CorrectionAuthenticationBindingV1 {
  return {
    state,
    correctionTurnId,
    capabilityProfileId: null,
    capabilityProfileHash: null,
    profileContentHash: null,
    authActorIdSha256: null,
    authActorSource: null,
  };
}

function canonicalProfileContentHash(content: string): string {
  return sha256Text(canonicalJsonString(content));
}

function classifyStoredCorrectionOrigin(
  actorType: "user" | "agent" | "system",
  actorId: string,
): Exclude<CorrectionOrigin, "authenticated_operator"> {
  const normalized = actorId.toLowerCase();
  if (normalized.startsWith("browser:") || normalized.includes("browser")) return "browser";
  if (normalized.startsWith("tool:") || normalized.includes("tool")) return "tool";
  if (actorType === "agent") return "model";
  return "unknown";
}

function containsSecretLikeContent(value: string): boolean {
  SECRET_CONTENT_PATTERN.lastIndex = 0;
  return SECRET_CONTENT_PATTERN.test(value) || redactSecretText(value).redactionCount > 0;
}

function deriveLearningTitle(correction: string): string {
  const normalized = correction.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const colon = normalized.indexOf(":");
  const candidate = colon > 2 && colon <= 96 ? normalized.slice(0, colon) : normalized.split(" ").slice(0, 8).join(" ");
  return candidate.slice(0, 160).trim() || "Learned correction candidate";
}

function deriveTargetKey(title: string): string {
  const slug = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return `skill:${slug || sha256Text(title).slice(0, 24)}`;
}

function historyDryRunSha256(input: Omit<HistorySelectionTokenV1, "version" | "dryRunSha256">): string {
  return sha256Text(`goatcitadel.skill-learning-history-dry-run.v1\u0000${canonicalJsonString(input)}`);
}

function emptyPermissionEnvelopeSha256(): string {
  return sha256Text(canonicalSkillPermissionEnvelope(EMPTY_PERMISSION_ENVELOPE));
}

function decodeHistoryCursor(value: string): HistoryCursorV1 {
  const parsed = decodeToken(value);
  const keys = Object.keys(parsed).sort();
  const required = [
    "offset",
    "sessionId",
    "snapshotMaxSequence",
    "snapshotMessageCount",
    "version",
    "workspaceRevision",
    "effectiveConfigRevision",
    "workspaceId",
  ].sort();
  const allowed = new Set([...required, "boundaryMessageId"]);
  if (
    !required.every((key) => keys.includes(key)) ||
    keys.some((key) => !allowed.has(key)) ||
    parsed.version !== "goatcitadel.skill-learning-history-cursor.v1"
  ) {
    throw new TypeError("Malformed skill-learning history cursor.");
  }
  const cursor = parsed as unknown as HistoryCursorV1;
  validateHistoryPosition(cursor);
  if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 1 || cursor.offset >= HISTORY_SCAN_MAX_MESSAGES) {
    throw new TypeError("Malformed skill-learning history cursor offset.");
  }
  if (cursor.boundaryMessageId !== undefined) {
    normalizeIdentity(cursor.boundaryMessageId, "history boundary message ID", 256);
  }
  if (!Number.isSafeInteger(cursor.workspaceRevision) || cursor.workspaceRevision < 1) {
    throw new TypeError("Malformed skill-learning history workspace revision.");
  }
  if (!Number.isSafeInteger(cursor.effectiveConfigRevision) || cursor.effectiveConfigRevision < 1) {
    throw new TypeError("Malformed skill-learning history effective config revision.");
  }
  return cursor;
}

function decodeHistorySelection(value: string): HistorySelectionTokenV1 {
  const parsed = decodeToken(value);
  const expected = [
    "version",
    "workspaceId",
    "sessionId",
    "turnId",
    "sourceMessageId",
    "correctionMessageId",
    "sourceRole",
    "sourceActorType",
    "sourceActorIdSha256",
    "correctionRole",
    "correctionActorType",
    "correctionActorIdSha256",
    "correctionOrigin",
    "correctionAuthentication",
    "traceStatus",
    "sourceSha256",
    "correctionSha256",
    "permissionEnvelopeSha256",
    "workspaceRevision",
    "effectiveConfigRevision",
    "snapshotMaxSequence",
    "snapshotMessageCount",
    "dryRunSha256",
  ].sort();
  if (
    canonicalJsonString(Object.keys(parsed).sort()) !== canonicalJsonString(expected) ||
    parsed.version !== "goatcitadel.skill-learning-selection.v1"
  ) {
    throw new TypeError("Malformed skill-learning selection token.");
  }
  const token = parsed as unknown as HistorySelectionTokenV1;
  validateHistoryPosition(token);
  normalizeIdentity(token.turnId, "selection turn ID", 256);
  normalizeIdentity(token.sourceMessageId, "selection source message ID", 256);
  normalizeIdentity(token.correctionMessageId, "selection correction message ID", 256);
  assertSha256(token.sourceActorIdSha256, "selection source actor hash");
  assertSha256(token.correctionActorIdSha256, "selection correction actor hash");
  validateCorrectionAuthenticationBinding(token.correctionAuthentication);
  if (
    token.sourceRole !== "assistant" ||
    token.correctionRole !== "user" ||
    !["user", "agent", "system"].includes(token.sourceActorType) ||
    !["user", "agent", "system"].includes(token.correctionActorType) ||
    !["authenticated_operator", "model", "tool", "browser", "unknown"].includes(token.correctionOrigin) ||
    token.traceStatus !== "completed"
  ) {
    throw new TypeError("Malformed skill-learning selection actor or canonical-turn metadata.");
  }
  assertSha256(token.sourceSha256, "selection source hash");
  assertSha256(token.correctionSha256, "selection correction hash");
  assertSha256(token.permissionEnvelopeSha256, "selection permission hash");
  assertSha256(token.dryRunSha256, "selection dry-run hash");
  if (!Number.isSafeInteger(token.workspaceRevision) || token.workspaceRevision < 1) {
    throw new TypeError("Malformed skill-learning workspace revision.");
  }
  if (!Number.isSafeInteger(token.effectiveConfigRevision) || token.effectiveConfigRevision < 1) {
    throw new TypeError("Malformed skill-learning effective config revision.");
  }
  return token;
}

function validateCorrectionAuthenticationBinding(value: unknown): asserts value is CorrectionAuthenticationBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Malformed skill-learning correction authentication binding.");
  }
  const binding = value as Record<string, unknown>;
  const expected = [
    "state",
    "correctionTurnId",
    "capabilityProfileId",
    "capabilityProfileHash",
    "profileContentHash",
    "authActorIdSha256",
    "authActorSource",
  ].sort();
  if (canonicalJsonString(Object.keys(binding).sort()) !== canonicalJsonString(expected)) {
    throw new TypeError("Malformed skill-learning correction authentication binding fields.");
  }
  if (!["verified", "foreign", "unavailable", "invalid"].includes(String(binding.state))) {
    throw new TypeError("Malformed skill-learning correction authentication state.");
  }
  for (const [key, label] of [
    ["correctionTurnId", "correction turn ID"],
    ["capabilityProfileId", "correction capability profile ID"],
  ] as const) {
    if (binding[key] !== null) normalizeIdentity(binding[key] as string, label, 256);
  }
  for (const [key, label] of [
    ["capabilityProfileHash", "correction capability profile hash"],
    ["profileContentHash", "correction profile content hash"],
    ["authActorIdSha256", "correction auth actor hash"],
  ] as const) {
    if (binding[key] !== null) assertSha256(binding[key] as string, label);
  }
  if (
    binding.authActorSource !== null &&
    (typeof binding.authActorSource !== "string" ||
      !CAPABILITY_PROFILE_AUTH_SOURCES.has(
        binding.authActorSource as NonNullable<ToolPolicyActorContext["authActorSource"]>,
      ))
  ) {
    throw new TypeError("Malformed skill-learning correction auth actor source.");
  }
  const completeVerifiedBinding =
    binding.correctionTurnId !== null &&
    binding.capabilityProfileId !== null &&
    binding.capabilityProfileHash !== null &&
    binding.profileContentHash !== null &&
    binding.authActorIdSha256 !== null &&
    binding.authActorSource !== null &&
    AUTHENTICATED_OPERATOR_SOURCES.has(
      binding.authActorSource as NonNullable<ToolPolicyActorContext["authActorSource"]>,
    );
  if ((binding.state === "verified" || binding.state === "foreign") && !completeVerifiedBinding) {
    throw new TypeError("Incomplete skill-learning correction authentication receipt.");
  }
  if (
    binding.state === "unavailable" &&
    [
      binding.capabilityProfileId,
      binding.capabilityProfileHash,
      binding.profileContentHash,
      binding.authActorIdSha256,
      binding.authActorSource,
    ].some((item) => item !== null)
  ) {
    throw new TypeError("Malformed unavailable skill-learning correction authentication receipt.");
  }
}

function validateHistoryPosition(value: {
  workspaceId: string;
  sessionId: string;
  snapshotMaxSequence: number;
  snapshotMessageCount: number;
}): void {
  normalizeIdentity(value.workspaceId, "history workspace ID", 256);
  normalizeIdentity(value.sessionId, "history session ID", 256);
  if (!Number.isSafeInteger(value.snapshotMaxSequence) || value.snapshotMaxSequence < 1) {
    throw new TypeError("Malformed skill-learning history high-water.");
  }
  if (!Number.isSafeInteger(value.snapshotMessageCount) || value.snapshotMessageCount < 1) {
    throw new TypeError("Malformed skill-learning history count.");
  }
}

function encodeToken(value: object): string {
  const encoded = Buffer.from(canonicalJsonString(value), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > SELECTION_TOKEN_MAX_BYTES) {
    throw new TypeError("Skill-learning token exceeds its byte bound.");
  }
  return encoded;
}

function decodeToken(value: string): Record<string, unknown> {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > SELECTION_TOKEN_MAX_BYTES) {
    throw new TypeError("Malformed or oversized skill-learning token.");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) throw new Error("noncanonical base64url");
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new TypeError("Malformed skill-learning token.");
  }
}

async function verifyExactDirectory(directory: string, expected: Record<string, string>): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ConflictError({ message: "Skill-learning artifact directory is not a real directory." });
  }
  const entries = (await fs.readdir(directory)).sort();
  const expectedNames = Object.keys(expected).map(sanitizePathSegment).sort();
  if (canonicalJsonString(entries) !== canonicalJsonString(expectedNames)) {
    throw new ConflictError({ message: "Skill-learning artifact directory has unexpected or missing files." });
  }
  for (const [filename, content] of Object.entries(expected)) {
    const targetPath = path.join(directory, sanitizePathSegment(filename));
    const expectedBytes = Buffer.byteLength(content, "utf8");
    const stored = await readExactRegularFile(targetPath, expectedBytes, MAX_REPLAY_ARTIFACT_BYTES);
    if (sha256Text(stored) !== sha256Text(content)) {
      throw new ConflictError({ message: `Skill-learning artifact ${filename} failed immutable hash verification.` });
    }
  }
}

async function readVerifiedArtifactText(
  directory: string,
  filename: string,
  artifact: CapabilityArtifactRecord,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > maxBytes) {
    throw new ConflictError({ message: `Skill-learning artifact ${filename} has an invalid bounded size.` });
  }
  const content = await readExactRegularFile(
    path.join(directory, sanitizePathSegment(filename)),
    artifact.bytes,
    maxBytes,
  );
  if (sha256Text(content) !== artifact.sha256) {
    throw new ConflictError({ message: `Skill-learning artifact ${filename} failed immutable hash verification.` });
  }
  return content;
}

async function readExactRegularFile(targetPath: string, expectedBytes: number, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes) {
    throw new ConflictError({ message: "Skill-learning artifact exceeds its bounded replay size." });
  }
  const beforeOpen = await fs.lstat(targetPath);
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) {
    throw new ConflictError({ message: "Skill-learning artifact is not a regular file." });
  }
  if (beforeOpen.size !== expectedBytes) {
    throw new ConflictError({ message: "Skill-learning artifact failed immutable byte-size verification." });
  }
  const handle = await fs.open(targetPath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== expectedBytes) {
      throw new ConflictError({ message: "Skill-learning artifact failed bounded regular-file verification." });
    }
    const buffer = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const { bytesRead } = await handle.read(buffer, offset, expectedBytes - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const trailing = Buffer.alloc(1);
    const { bytesRead: trailingBytes } = await handle.read(trailing, 0, 1, offset);
    if (offset !== expectedBytes || trailingBytes !== 0) {
      throw new ConflictError({ message: "Skill-learning artifact changed during bounded replay verification." });
    }
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function ensureRealDirectories(root: string, segments: string[]): Promise<string> {
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  for (const rawSegment of segments) {
    const segment = sanitizePathSegment(rawSegment);
    const next = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await fs.mkdir(next, { recursive: false });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      stat = await fs.lstat(next);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ConflictError({ message: "Skill-learning artifact path contains a symlink or non-directory parent." });
    }
    const realNext = await fs.realpath(next);
    assertPathInside(realNext, realRoot, "skill-learning artifact parent");
    current = realNext;
  }
  return current;
}

async function resolveExistingRealDirectories(root: string, segments: string[]): Promise<string> {
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  for (const rawSegment of segments) {
    const segment = sanitizePathSegment(rawSegment);
    const next = path.join(current, segment);
    const stat = await fs.lstat(next);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ConflictError({ message: "Skill-learning replay path contains a symlink or non-directory parent." });
    }
    const realNext = await fs.realpath(next);
    assertPathInside(realNext, realRoot, "skill-learning replay artifact parent");
    current = realNext;
  }
  return current;
}

function assertPathInside(target: string, root: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError(`${label} escapes its managed root.`);
  }
}

function sanitizePathSegment(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    /[\\/:*?"<>|]/u.test(normalized) ||
    hasControlCharacter
  ) {
    throw new TypeError("Skill-learning artifact path segment is invalid.");
  }
  return normalized;
}

function normalizeRelPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new TypeError("Skill-learning artifact path escapes the repository root.");
  }
  return normalized;
}

function requireBoundedUtf8(value: string, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`Skill-learning ${label} is required.`);
  if (Buffer.byteLength(value, "utf8") > maxBytes)
    throw new TypeError(`Skill-learning ${label} exceeds ${maxBytes} bytes.`);
  return value;
}

function normalizeIdentity(value: string | undefined, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError(`Skill-learning ${label} is required.`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength || normalized !== value) {
    throw new TypeError(`Skill-learning ${label} is missing, oversized, or noncanonical.`);
  }
  return normalized;
}

function canonicalTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError("Skill-learning clock returned a noncanonical timestamp.");
  }
  return value;
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 digest.`);
}

function normalizeLimit(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)) throw new TypeError("Skill-learning limit must be an integer.");
  return Math.max(min, Math.min(max, value));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function yamlScalar(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]+/gu, " "));
}

function previewText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 180);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
