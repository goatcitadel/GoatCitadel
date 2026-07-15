/* eslint-disable max-lines -- Lifecycle authority and cross-dialect transactional invariants stay co-located for this checkpoint. */
import { createHash } from "node:crypto";
import { canonicalJsonString, ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export type ChatSessionLifecycleIntentKind = "initialize" | "reactivate" | "delete";

export interface ChatSessionLifecycleIntentRecord {
  intentId: string;
  sessionIncarnationId: string;
  workspaceId: string;
  sessionId: string;
  intentKind: ChatSessionLifecycleIntentKind;
  expectedGeneration?: number;
  nextGeneration: number;
  expectedRevision?: number;
  actorKind: "operator" | "system";
  actorId: string;
  idempotencyKey: string;
  requestSha256: string;
  correlationId: string;
  eventId: string;
  createdAt: string;
}

export interface InitializeChatSessionLifecycleInput {
  workspaceId: string;
  sessionId: string;
  actorId: string;
  idempotencyKey: string;
  correlationId: string;
  metadataTimestamp?: string;
}

export interface ReactivateChatSessionLifecycleInput extends InitializeChatSessionLifecycleInput {
  expectedTerminalGeneration: number;
}

export interface EnsureActiveChatSessionLifecycleInput {
  workspaceId: string;
  sessionId: string;
  actorId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  metadataTimestamp?: string;
}

export interface ChatSessionLifecycleActivationOutcome {
  disposition: "initialized" | "reactivated" | "existing";
  generation: number;
  intent: ChatSessionLifecycleIntentRecord;
}

export interface PrepareChatSessionDeletionTreeInput {
  workspaceId: string;
  rootSessionId: string;
  expectedRootRevision: number;
  actorId: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface ChatSessionLifecycleDeletionNode {
  workspaceId: string;
  sessionId: string;
  revision: number;
  generation: number;
  sessionIncarnationId: string;
  intentId: string;
  cleanupOrder: number;
}

export interface ChatSessionLifecycleDeletionOutcome<T> {
  disposition: "deleted" | "replayed";
  workspaceId: string;
  rootSessionId: string;
  nodes: ChatSessionLifecycleDeletionNode[];
  /** Present only for a fresh delete. Replay never repeats physical/content cleanup callbacks. */
  results: T[];
}

interface LifecycleIntentRow {
  intent_id: string;
  session_incarnation_id: string;
  workspace_id: string;
  session_id: string;
  intent_kind: ChatSessionLifecycleIntentKind;
  expected_generation: number | bigint | string | null;
  next_generation: number | bigint | string;
  expected_revision: number | bigint | string | null;
  actor_kind: "operator" | "system";
  actor_id: string;
  idempotency_key: string;
  request_sha256: string;
  correlation_id: string;
  event_id: string;
  created_at: string;
}

interface MetaAuthorityRow {
  session_id: string;
  workspace_id: string;
  revision: number | bigint | string;
  lifecycle_intent_id: string | null;
  deletion_intent_id: string | null;
}

interface ControlAuthorityRow {
  workspace_id: string;
  session_id: string;
  generation: number | bigint | string;
  control_revision: number | bigint | string;
  owner_kind: string;
  lease_state: string;
  is_current: number | bigint | string;
  request_id: string | null;
  companion_session_id: string | null;
  device_grant_id: string | null;
  transition_idempotency_key: string;
  transition_request_sha256: string;
}

interface ControlEventEvidenceRow {
  event_id: string;
  workspace_id: string;
  session_id: string;
  previous_generation: number | bigint | string | null;
  next_generation: number | bigint | string;
  reason_code: string;
  actor_kind: string;
  actor_id: string;
  idempotency_key: string;
  request_sha256: string;
  correlation_id: string;
  created_at: string;
}

export class ChatSessionLifecycleRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public initialize(input: InitializeChatSessionLifecycleInput): ChatSessionLifecycleActivationOutcome {
    const normalized = normalizeInitializeInput(input);
    return this.db.transaction("immediate", () => {
      this.acquireSessionLock(normalized.sessionId);
      return this.initializeLocked(normalized);
    });
  }

  public reactivate(input: ReactivateChatSessionLifecycleInput): ChatSessionLifecycleActivationOutcome {
    const normalized = {
      ...normalizeInitializeInput(input),
      expectedTerminalGeneration: positiveInteger(input.expectedTerminalGeneration, "expectedTerminalGeneration"),
    };
    return this.db.transaction("immediate", () => {
      this.acquireSessionLock(normalized.sessionId);
      return this.reactivateLocked(normalized);
    });
  }

  public ensureActive(input: EnsureActiveChatSessionLifecycleInput): ChatSessionLifecycleActivationOutcome {
    const workspaceId = identifier(input.workspaceId, "workspaceId");
    const sessionId = identifier(input.sessionId, "sessionId");
    return this.db.transaction("immediate", () => {
      this.acquireSessionLock(sessionId);
      const existing = this.getMetaForUpdate(sessionId);
      if (existing) {
        if (existing.workspace_id !== workspaceId) {
          throw lifecycleConflict("CHAT_SESSION_WORKSPACE_MISMATCH", "Chat session workspace is immutable.");
        }
        const control = this.requireCurrentControl(workspaceId, sessionId, true);
        const intent = this.requireBoundIntent(existing);
        return { disposition: "existing", generation: asPositiveInteger(control.generation), intent };
      }
      const terminal = this.getMaxControl(sessionId, true);
      if (!terminal) {
        const idempotencyKey = input.idempotencyKey ?? `lifecycle:init:${sessionId}`;
        return this.initializeLocked({
          workspaceId,
          sessionId,
          actorId: input.actorId ?? "system",
          idempotencyKey,
          correlationId: input.correlationId ?? idempotencyKey,
          metadataTimestamp: input.metadataTimestamp,
        });
      }
      const generation = asPositiveInteger(terminal.generation);
      const idempotencyKey = input.idempotencyKey ?? `lifecycle:reactivate:${sessionId}:${generation + 1}`;
      return this.reactivateLocked({
        workspaceId,
        sessionId,
        expectedTerminalGeneration: generation,
        actorId: input.actorId ?? "operator",
        idempotencyKey,
        correlationId: input.correlationId ?? idempotencyKey,
        metadataTimestamp: input.metadataTimestamp,
      });
    });
  }

  /**
   * Owns the complete logical/content deletion transaction. The callback must be
   * synchronous and must delete only the supplied node while using this same
   * DatabaseClient transaction. A replay validates canonical tombstones but
   * never calls the callback or claims physical cleanup replay.
   */
  public deleteTree<T>(
    input: PrepareChatSessionDeletionTreeInput,
    deleteNode: (node: ChatSessionLifecycleDeletionNode) => T,
  ): ChatSessionLifecycleDeletionOutcome<T> {
    const normalized = normalizeDeletionInput(input);
    return this.db.transaction("immediate", () => {
      this.acquireSessionLock(normalized.rootSessionId);
      const rootMeta = this.getMetaForUpdate(normalized.rootSessionId);
      if (!rootMeta) {
        return this.replayDeletedTree(normalized);
      }

      const discovered = this.discoverDeletionTree(normalized.rootSessionId);

      const locked = new Map<string, { meta: MetaAuthorityRow; control: ControlAuthorityRow }>();
      for (const sessionId of discovered) {
        const meta = sessionId === normalized.rootSessionId ? rootMeta : this.getMetaForUpdate(sessionId);
        if (!meta) throw new NotFoundError({ entity: "Chat session", id: sessionId });
        if (meta.workspace_id !== normalized.workspaceId) {
          throw lifecycleConflict("CHAT_SESSION_TREE_WORKSPACE_MISMATCH", "Chat session tree crosses workspaces.");
        }
        if (
          sessionId === normalized.rootSessionId &&
          asPositiveInteger(meta.revision) !== normalized.expectedRootRevision
        ) {
          throw writeConflict(sessionId, normalized.expectedRootRevision, asPositiveInteger(meta.revision));
        }
        const control = this.requireCurrentControl(normalized.workspaceId, sessionId, true);
        if (control.owner_kind !== "operator" || control.lease_state !== "operator_active") {
          throw lifecycleConflict(
            "CHAT_SESSION_TREE_NOT_OPERATOR_OWNED",
            "Every Chat session tree node must be operator-owned.",
          );
        }
        locked.set(sessionId, { meta, control });
      }

      const nodes: ChatSessionLifecycleDeletionNode[] = [];
      for (const [index, sessionId] of discovered.entries()) {
        const authority = locked.get(sessionId)!;
        const generation = asPositiveInteger(authority.control.generation);
        const revision = asPositiveInteger(authority.meta.revision);
        const sessionIncarnationId = resolveMetaIncarnationId(authority.meta);
        const idempotencyKey =
          sessionId === normalized.rootSessionId
            ? normalized.idempotencyKey
            : deriveChildDeleteIdempotencyKey(normalized.idempotencyKey, sessionId);
        const correlationId = normalized.correlationId;
        const createdAt = this.readDatabaseTime();
        const material = {
          actorId: normalized.actorId,
          correlationId,
          expectedGeneration: generation,
          expectedRevision: revision,
          sessionIncarnationId,
          idempotencyKey,
          intentKind: "delete",
          sessionId,
          workspaceId: normalized.workspaceId,
        } as const;
        const requestSha256 = deleteRequestSha256(material);
        const intentId = deriveId("csli", idempotencyKey, requestSha256);
        const eventId = deriveId("sce", normalized.workspaceId, sessionId, idempotencyKey, "session_deleted");
        this.insertIntent({
          intentId,
          sessionIncarnationId,
          workspaceId: normalized.workspaceId,
          sessionId,
          intentKind: "delete",
          expectedGeneration: generation,
          nextGeneration: generation,
          expectedRevision: revision,
          actorKind: "operator",
          actorId: normalized.actorId,
          idempotencyKey,
          requestSha256,
          correlationId,
          eventId,
          createdAt,
        });
        const bound = this.db
          .prepare(
            `UPDATE chat_session_meta SET deletion_intent_id = @intentId
             WHERE session_id = @sessionId AND workspace_id = @workspaceId AND revision = @revision`,
          )
          .run({ intentId, sessionId, workspaceId: normalized.workspaceId, revision });
        if (bound.changes !== 1) throw lifecycleConflict("WRITE_CONFLICT", "Chat session deletion binding is stale.");

        this.cancelPendingRequests(sessionId, normalized.actorId, createdAt);
        this.cancelActiveAdmissions(sessionId, normalized.actorId, correlationId, createdAt, intentId);
        const terminalized = this.db
          .prepare(
            `UPDATE chat_session_control_grants
             SET is_current = 0, lease_state = 'deleted', control_revision = control_revision + 1,
                 updated_at = @createdAt, terminal_at = @createdAt
             WHERE session_id = @sessionId AND generation = @generation AND is_current = 1`,
          )
          .run({ sessionId, generation, createdAt });
        if (terminalized.changes !== 1) {
          throw lifecycleConflict("CHAT_SESSION_CONTROL_STALE", "Chat session control changed during deletion.");
        }
        const eventSequence = this.nextControlEventSequence(sessionId);
        this.db
          .prepare(
            `INSERT INTO chat_session_control_events (
               event_id, workspace_id, session_id, event_sequence, request_id,
               previous_generation, next_generation, previous_owner_kind, next_owner_kind,
               previous_lease_state, next_lease_state, reason_code, actor_kind, actor_id,
               companion_session_id, device_grant_id, idempotency_key, request_sha256,
               correlation_id, created_at
             ) VALUES (
               @eventId, @workspaceId, @sessionId, @eventSequence, NULL,
               @generation, @generation, 'operator', NULL,
               'operator_active', 'deleted', 'session_deleted', 'operator', @actorId,
               NULL, NULL, @idempotencyKey, @requestSha256, @correlationId, @createdAt
             )`,
          )
          .run({
            eventId,
            workspaceId: normalized.workspaceId,
            sessionId,
            eventSequence,
            generation,
            actorId: normalized.actorId,
            idempotencyKey,
            requestSha256,
            correlationId,
            createdAt,
          });
        nodes.push({
          workspaceId: normalized.workspaceId,
          sessionId,
          revision,
          generation,
          sessionIncarnationId,
          intentId,
          cleanupOrder: discovered.length - index - 1,
        });
      }
      const cleanupNodes = nodes.reverse().map((node, cleanupOrder) => ({ ...node, cleanupOrder }));
      const results = cleanupNodes.map((node) => deleteNode(node));
      this.deleteMetadata(cleanupNodes);
      return {
        disposition: "deleted",
        workspaceId: normalized.workspaceId,
        rootSessionId: normalized.rootSessionId,
        nodes: cleanupNodes,
        results,
      };
    });
  }

  public replayDeletionTree(
    input: Omit<PrepareChatSessionDeletionTreeInput, "workspaceId">,
  ): ChatSessionLifecycleDeletionOutcome<never> {
    const withoutWorkspace = {
      rootSessionId: identifier(input.rootSessionId, "rootSessionId"),
      expectedRootRevision: positiveInteger(input.expectedRootRevision, "expectedRootRevision"),
      actorId: identifier(input.actorId, "actorId"),
      idempotencyKey: boundedIdentifier(input.idempotencyKey, "idempotencyKey", 512),
      correlationId: identifier(input.correlationId, "correlationId"),
    };
    return this.db.transaction("immediate", () => {
      this.acquireSessionLock(withoutWorkspace.rootSessionId);
      const rootIntent = this.findIntentByIdempotency(withoutWorkspace.idempotencyKey);
      if (this.getMetaForUpdate(withoutWorkspace.rootSessionId)) {
        throw lifecycleConflict(
          rootIntent ? "CHAT_SESSION_DELETE_REPLAY_REACTIVATED" : "CHAT_SESSION_DELETE_REPLAY_LIVE",
          rootIntent
            ? "A deleted Chat session root is live again."
            : "Chat session is live and has no deletion tombstone to replay.",
        );
      }
      if (!rootIntent) throw new NotFoundError({ entity: "Chat session", id: withoutWorkspace.rootSessionId });
      return this.replayDeletedTree({ ...withoutWorkspace, workspaceId: rootIntent.workspaceId });
    });
  }

  private deleteMetadata(nodes: readonly ChatSessionLifecycleDeletionNode[]): void {
    for (const node of nodes) {
      const deleted = this.db
        .prepare(
          `DELETE FROM chat_session_meta
           WHERE session_id = @sessionId AND workspace_id = @workspaceId
              AND revision = @revision AND deletion_intent_id = @intentId`,
        )
        .run({
          sessionId: node.sessionId,
          workspaceId: node.workspaceId,
          revision: node.revision,
          intentId: node.intentId,
        });
      if (deleted.changes !== 1) {
        throw lifecycleConflict("CHAT_SESSION_DELETE_STALE", "Chat session deletion is stale.");
      }
    }
  }

  public getIntent(intentId: string): ChatSessionLifecycleIntentRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM chat_session_lifecycle_intents WHERE intent_id = @intentId")
      .get<LifecycleIntentRow>({ intentId: identifier(intentId, "intentId") });
    return row ? mapIntent(row) : undefined;
  }

  private initializeLocked(
    normalized: ReturnType<typeof normalizeInitializeInput>,
  ): ChatSessionLifecycleActivationOutcome {
    const activation = {
      ...normalized,
      actorKind: "system" as const,
      intentKind: "initialize" as const,
      expectedGeneration: undefined,
      nextGeneration: 1,
    };
    const existing = this.getMetaForUpdate(normalized.sessionId);
    if (existing) return this.replayExistingActivation(existing, activation);
    if (this.getMaxControl(normalized.sessionId, true)) {
      throw lifecycleConflict("CHAT_SESSION_REQUIRES_REACTIVATION", "Chat session has terminal lifecycle history.");
    }
    return this.insertActivation(activation);
  }

  private reactivateLocked(
    normalized: ReturnType<typeof normalizeInitializeInput> & { expectedTerminalGeneration: number },
  ): ChatSessionLifecycleActivationOutcome {
    const activation = {
      ...normalized,
      actorKind: "operator" as const,
      intentKind: "reactivate" as const,
      expectedGeneration: normalized.expectedTerminalGeneration,
      nextGeneration: increment(normalized.expectedTerminalGeneration),
    };
    const existing = this.getMetaForUpdate(normalized.sessionId);
    if (existing) return this.replayExistingActivation(existing, activation);
    const terminal = this.getMaxControl(normalized.sessionId, true);
    if (
      !terminal ||
      asPositiveInteger(terminal.generation) !== normalized.expectedTerminalGeneration ||
      isCurrent(terminal.is_current) ||
      terminal.workspace_id !== normalized.workspaceId ||
      terminal.owner_kind !== "operator" ||
      terminal.lease_state !== "deleted"
    ) {
      throw lifecycleConflict(
        "CHAT_SESSION_TERMINAL_GENERATION_MISMATCH",
        "Chat session terminal generation is stale.",
      );
    }
    return this.insertActivation(activation);
  }

  private insertActivation(input: {
    workspaceId: string;
    sessionId: string;
    actorId: string;
    idempotencyKey: string;
    correlationId: string;
    metadataTimestamp?: string;
    actorKind: "operator" | "system";
    intentKind: "initialize" | "reactivate";
    expectedGeneration?: number;
    nextGeneration: number;
  }): ChatSessionLifecycleActivationOutcome {
    const createdAt = this.readDatabaseTime();
    const requestSha256 = activationRequestSha256(input);
    const intent: ChatSessionLifecycleIntentRecord = {
      intentId: deriveId("csli", input.idempotencyKey, requestSha256),
      sessionIncarnationId: "",
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      intentKind: input.intentKind,
      expectedGeneration: input.expectedGeneration,
      nextGeneration: input.nextGeneration,
      actorKind: input.actorKind,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      requestSha256,
      correlationId: input.correlationId,
      eventId: deriveId(
        "sce",
        input.workspaceId,
        input.sessionId,
        input.idempotencyKey,
        input.intentKind === "initialize" ? "session_initialized" : "session_reactivated",
      ),
      createdAt,
    };
    intent.sessionIncarnationId = intent.intentId;
    this.insertIntent(intent);
    const metadataTimestamp = input.metadataTimestamp ?? createdAt;
    this.db
      .prepare(
        `INSERT INTO chat_session_meta (
           session_id, workspace_id, revision, lifecycle_intent_id, created_at, updated_at
         ) VALUES (@sessionId, @workspaceId, 1, @intentId, @metadataTimestamp, @metadataTimestamp)`,
      )
      .run({
        sessionId: intent.sessionId,
        workspaceId: intent.workspaceId,
        intentId: intent.intentId,
        metadataTimestamp,
      });
    this.requireCurrentControl(input.workspaceId, input.sessionId, false);
    return {
      disposition: input.intentKind === "initialize" ? "initialized" : "reactivated",
      generation: input.nextGeneration,
      intent,
    };
  }

  private insertIntent(intent: ChatSessionLifecycleIntentRecord): void {
    this.db
      .prepare(
        `INSERT INTO chat_session_lifecycle_intents (
           intent_id, session_incarnation_id, workspace_id, session_id, intent_kind, expected_generation, next_generation,
           expected_revision, actor_kind, actor_id, idempotency_key, request_sha256,
           correlation_id, event_id, created_at
         ) VALUES (
           @intentId, @sessionIncarnationId, @workspaceId, @sessionId, @intentKind, @expectedGeneration, @nextGeneration,
           @expectedRevision, @actorKind, @actorId, @idempotencyKey, @requestSha256,
           @correlationId, @eventId, @createdAt
         )`,
      )
      .run({
        ...intent,
        expectedGeneration: intent.expectedGeneration ?? null,
        expectedRevision: intent.expectedRevision ?? null,
      });
  }

  private replayExistingActivation(
    existing: MetaAuthorityRow,
    input: {
      workspaceId: string;
      sessionId: string;
      actorId: string;
      idempotencyKey: string;
      correlationId: string;
      actorKind: "operator" | "system";
      intentKind: "initialize" | "reactivate";
      expectedGeneration?: number;
      nextGeneration: number;
    },
  ): ChatSessionLifecycleActivationOutcome {
    if (existing.workspace_id !== input.workspaceId || existing.session_id !== input.sessionId) {
      throw lifecycleConflict("CHAT_SESSION_WORKSPACE_MISMATCH", "Chat session workspace is immutable.");
    }
    const intent = this.requireBoundIntent(existing);
    const requestSha256 = activationRequestSha256(input);
    const intentId = deriveId("csli", input.idempotencyKey, requestSha256);
    const eventId = deriveId(
      "sce",
      input.workspaceId,
      input.sessionId,
      input.idempotencyKey,
      input.intentKind === "initialize" ? "session_initialized" : "session_reactivated",
    );
    if (
      intent.intentId !== intentId ||
      intent.sessionIncarnationId !== intent.intentId ||
      intent.workspaceId !== input.workspaceId ||
      intent.sessionId !== input.sessionId ||
      intent.intentKind !== input.intentKind ||
      intent.expectedGeneration !== input.expectedGeneration ||
      intent.nextGeneration !== input.nextGeneration ||
      intent.expectedRevision !== undefined ||
      intent.actorKind !== input.actorKind ||
      intent.actorId !== input.actorId ||
      intent.idempotencyKey !== input.idempotencyKey ||
      intent.requestSha256 !== requestSha256 ||
      intent.correlationId !== input.correlationId ||
      intent.eventId !== eventId
    ) {
      throw lifecycleConflict("CHAT_SESSION_ACTIVATION_REPLAY_CONFLICT", "Chat session activation replay conflicts.");
    }
    const control = this.requireCurrentControl(input.workspaceId, existing.session_id, false);
    const currentGeneration = asPositiveInteger(control.generation);
    if (currentGeneration < input.nextGeneration) {
      throw lifecycleConflict("CHAT_SESSION_ACTIVATION_REPLAY_CORRUPT", "Chat session activation authority conflicts.");
    }
    this.requireExactControlEvent(
      intent,
      input.intentKind === "initialize" ? "session_initialized" : "session_reactivated",
    );
    return { disposition: "existing", generation: currentGeneration, intent };
  }

  private replayDeletedTree<T>(
    input: ReturnType<typeof normalizeDeletionInput>,
  ): ChatSessionLifecycleDeletionOutcome<T> {
    const rootIntent = this.findIntentByIdempotency(input.idempotencyKey);
    if (!rootIntent) throw new NotFoundError({ entity: "Chat session", id: input.rootSessionId });
    this.assertExactDeleteIntent(
      rootIntent,
      input,
      input.rootSessionId,
      input.idempotencyKey,
      input.expectedRootRevision,
    );

    const childPrefix = childDeleteIdempotencyPrefix(input.idempotencyKey);
    const childRows = this.db
      .prepare(
        `SELECT * FROM chat_session_lifecycle_intents
         WHERE intent_kind = 'delete'
           AND substr(idempotency_key, 1, length(@childPrefix)) = @childPrefix
         ORDER BY session_id ASC, intent_id ASC`,
      )
      .all<LifecycleIntentRow>({ childPrefix })
      .map(mapIntent);
    const seen = new Set<string>([input.rootSessionId]);
    for (const intent of childRows) {
      if (seen.has(intent.sessionId)) {
        throw lifecycleConflict("CHAT_SESSION_DELETE_REPLAY_CORRUPT", "Chat session delete tombstones are ambiguous.");
      }
      seen.add(intent.sessionId);
      const childKey = deriveChildDeleteIdempotencyKey(input.idempotencyKey, intent.sessionId);
      if (intent.expectedRevision === undefined) {
        throw lifecycleConflict(
          "CHAT_SESSION_DELETE_REPLAY_CORRUPT",
          "Chat session delete tombstone lacks a revision.",
        );
      }
      this.assertExactDeleteIntent(intent, input, intent.sessionId, childKey, intent.expectedRevision);
    }

    const intents = [...childRows, rootIntent];
    const nodes = intents.map((intent, cleanupOrder) => ({
      workspaceId: intent.workspaceId,
      sessionId: intent.sessionId,
      revision: intent.expectedRevision!,
      generation: intent.expectedGeneration!,
      sessionIncarnationId: intent.sessionIncarnationId,
      intentId: intent.intentId,
      cleanupOrder,
    }));
    return {
      disposition: "replayed",
      workspaceId: input.workspaceId,
      rootSessionId: input.rootSessionId,
      nodes,
      results: [],
    };
  }

  private assertExactDeleteIntent(
    intent: ChatSessionLifecycleIntentRecord,
    input: ReturnType<typeof normalizeDeletionInput>,
    sessionId: string,
    idempotencyKey: string,
    expectedRevision: number,
  ): void {
    const expectedGeneration = intent.expectedGeneration;
    if (expectedGeneration === undefined) {
      throw lifecycleConflict(
        "CHAT_SESSION_DELETE_REPLAY_CORRUPT",
        "Chat session delete tombstone lacks a generation.",
      );
    }
    const requestSha256 = deleteRequestSha256({
      actorId: input.actorId,
      correlationId: input.correlationId,
      expectedGeneration,
      expectedRevision,
      sessionIncarnationId: intent.sessionIncarnationId,
      idempotencyKey,
      sessionId,
      workspaceId: input.workspaceId,
    });
    const intentId = deriveId("csli", idempotencyKey, requestSha256);
    const eventId = deriveId("sce", input.workspaceId, sessionId, idempotencyKey, "session_deleted");
    if (
      intent.intentId !== intentId ||
      !intent.sessionIncarnationId ||
      intent.workspaceId !== input.workspaceId ||
      intent.sessionId !== sessionId ||
      intent.intentKind !== "delete" ||
      intent.nextGeneration !== expectedGeneration ||
      intent.expectedRevision !== expectedRevision ||
      intent.actorKind !== "operator" ||
      intent.actorId !== input.actorId ||
      intent.idempotencyKey !== idempotencyKey ||
      intent.requestSha256 !== requestSha256 ||
      intent.correlationId !== input.correlationId ||
      intent.eventId !== eventId
    ) {
      throw lifecycleConflict("CHAT_SESSION_DELETE_REPLAY_CONFLICT", "Chat session delete replay conflicts.");
    }
    if (this.getMetaForUpdate(sessionId)) {
      throw lifecycleConflict("CHAT_SESSION_DELETE_REPLAY_CONFLICT", "A deleted Chat session tree node is live again.");
    }
    const terminal = this.getMaxControl(sessionId, true);
    if (
      !terminal ||
      terminal.workspace_id !== input.workspaceId ||
      asPositiveInteger(terminal.generation) !== expectedGeneration ||
      isCurrent(terminal.is_current) ||
      terminal.owner_kind !== "operator" ||
      terminal.lease_state !== "deleted"
    ) {
      throw lifecycleConflict("CHAT_SESSION_DELETE_REPLAY_CORRUPT", "Chat session delete authority is not terminal.");
    }
    if (
      this.db
        .prepare("SELECT 1 FROM chat_session_control_requests WHERE session_id = @sessionId AND status = 'pending'")
        .get({ sessionId }) ||
      this.db
        .prepare("SELECT 1 FROM chat_session_mutation_admissions WHERE session_id = @sessionId AND status = 'active'")
        .get({ sessionId })
    ) {
      throw lifecycleConflict("CHAT_SESSION_DELETE_REPLAY_CORRUPT", "Chat session delete has live mutation authority.");
    }
    this.requireExactControlEvent(intent, "session_deleted");
  }

  private requireExactControlEvent(intent: ChatSessionLifecycleIntentRecord, reasonCode: string): void {
    const row = this.db
      .prepare("SELECT * FROM chat_session_control_events WHERE event_id = @eventId")
      .get<ControlEventEvidenceRow>({ eventId: intent.eventId });
    const expectedPrevious = intent.expectedGeneration;
    if (
      !row ||
      row.workspace_id !== intent.workspaceId ||
      row.session_id !== intent.sessionId ||
      (row.previous_generation === null ? undefined : asPositiveInteger(row.previous_generation)) !==
        expectedPrevious ||
      asPositiveInteger(row.next_generation) !== intent.nextGeneration ||
      row.reason_code !== reasonCode ||
      row.actor_kind !== intent.actorKind ||
      row.actor_id !== intent.actorId ||
      row.idempotency_key !== intent.idempotencyKey ||
      row.request_sha256 !== intent.requestSha256 ||
      row.correlation_id !== intent.correlationId ||
      row.created_at !== intent.createdAt
    ) {
      throw lifecycleConflict("CHAT_SESSION_LIFECYCLE_EVIDENCE_CORRUPT", "Chat session lifecycle evidence conflicts.");
    }
  }

  private requireBoundIntent(meta: MetaAuthorityRow): ChatSessionLifecycleIntentRecord {
    if (!meta.lifecycle_intent_id) {
      throw lifecycleConflict("CHAT_SESSION_LEGACY_LIFECYCLE", "Legacy Chat session has no initialization intent.");
    }
    const intent = this.getIntent(meta.lifecycle_intent_id);
    if (!intent) throw lifecycleConflict("CHAT_SESSION_LIFECYCLE_CORRUPT", "Chat session lifecycle intent is missing.");
    return intent;
  }

  private getMeta(sessionId: string): MetaAuthorityRow | undefined {
    return this.db
      .prepare(
        `SELECT session_id, workspace_id, revision, lifecycle_intent_id
                 , deletion_intent_id
         FROM chat_session_meta WHERE session_id = @sessionId`,
      )
      .get<MetaAuthorityRow>({ sessionId });
  }

  private getMetaForUpdate(sessionId: string): MetaAuthorityRow | undefined {
    return this.db
      .prepare(
        `SELECT session_id, workspace_id, revision, lifecycle_intent_id
                 , deletion_intent_id
         FROM chat_session_meta WHERE session_id = @sessionId${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      )
      .get<MetaAuthorityRow>({ sessionId });
  }

  private getMaxControl(sessionId: string, forUpdate: boolean): ControlAuthorityRow | undefined {
    return this.db
      .prepare(
        `SELECT workspace_id, session_id, generation, control_revision, owner_kind, lease_state,
                is_current, request_id, companion_session_id, device_grant_id,
                transition_idempotency_key, transition_request_sha256
         FROM chat_session_control_grants WHERE session_id = @sessionId
         ORDER BY generation DESC LIMIT 1${forUpdate && this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      )
      .get<ControlAuthorityRow>({ sessionId });
  }

  private requireCurrentControl(workspaceId: string, sessionId: string, forUpdate: boolean): ControlAuthorityRow {
    const row = this.db
      .prepare(
        `SELECT workspace_id, session_id, generation, control_revision, owner_kind, lease_state,
                is_current, request_id, companion_session_id, device_grant_id,
                transition_idempotency_key, transition_request_sha256
         FROM chat_session_control_grants
         WHERE session_id = @sessionId AND is_current = 1${
           forUpdate && this.db.dialect === "postgres" ? " FOR UPDATE" : ""
         }`,
      )
      .get<ControlAuthorityRow>({ sessionId });
    if (!row || row.workspace_id !== workspaceId) {
      throw lifecycleConflict("CHAT_SESSION_CONTROL_MISSING", "Chat session has no workspace-matched current owner.");
    }
    return row;
  }

  private discoverDeletionTree(rootSessionId: string): string[] {
    const sessions: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = rootSessionId;
    while (cursor) {
      if (seen.has(cursor))
        throw lifecycleConflict("CHAT_SESSION_TREE_CYCLE", "Chat session side-chat tree is corrupt.");
      seen.add(cursor);
      sessions.push(cursor);
      if (cursor !== rootSessionId) this.acquireSessionLock(cursor);
      this.lockCanonicalTopologyRow(cursor);
      const row: { child_session_id: string } | undefined = this.db
        .prepare(
          `SELECT child_session_id FROM chat_side_chats WHERE parent_session_id = @sessionId${
            this.db.dialect === "postgres" ? " FOR UPDATE" : ""
          }`,
        )
        .get<{ child_session_id: string }>({ sessionId: cursor });
      cursor = row?.child_session_id;
    }
    return sessions;
  }

  private lockCanonicalTopologyRow(sessionId: string): void {
    this.db
      .prepare(
        `SELECT session_id FROM sessions WHERE session_id = @sessionId${
          this.db.dialect === "postgres" ? " FOR UPDATE" : ""
        }`,
      )
      .get({ sessionId });
  }

  private findIntentByIdempotency(idempotencyKey: string): ChatSessionLifecycleIntentRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM chat_session_lifecycle_intents WHERE idempotency_key = @idempotencyKey")
      .get<LifecycleIntentRow>({ idempotencyKey });
    return row ? mapIntent(row) : undefined;
  }

  private cancelPendingRequests(sessionId: string, actorId: string, decidedAt: string): void {
    const rows = this.db
      .prepare(
        `SELECT request_id, expires_at FROM chat_session_control_requests
         WHERE session_id = @sessionId AND status = 'pending' ORDER BY request_id${
           this.db.dialect === "postgres" ? " FOR UPDATE" : ""
         }`,
      )
      .all<{ request_id: string; expires_at: string }>({ sessionId });
    for (const row of rows) {
      const expired = row.expires_at <= decidedAt;
      this.db
        .prepare(
          `UPDATE chat_session_control_requests
           SET status = @status, decided_at = @decidedAt, decided_by_actor_id = @actorId,
               decision_reason_code = @reason
           WHERE request_id = @requestId AND status = 'pending'`,
        )
        .run({
          status: expired ? "expired" : "cancelled",
          decidedAt,
          actorId,
          reason: expired ? "request_expired" : "request_cancelled",
          requestId: row.request_id,
        });
    }
  }

  private cancelActiveAdmissions(
    sessionId: string,
    actorId: string,
    correlationId: string,
    closedAt: string,
    lifecycleIntentId: string,
  ): void {
    const rows = this.db
      .prepare(
        `SELECT admission_id FROM chat_session_mutation_admissions
         WHERE session_id = @sessionId AND status = 'active' ORDER BY admission_id${
           this.db.dialect === "postgres" ? " FOR UPDATE" : ""
         }`,
      )
      .all<{ admission_id: string }>({ sessionId });
    for (const row of rows) {
      const terminalIdempotencyKey = `lifecycle:delete:admission:${row.admission_id}`;
      this.db
        .prepare(
          `UPDATE chat_session_mutation_admissions
           SET status = 'cancelled', closed_at = @closedAt, terminal_actor_id = @actorId,
               terminal_event_id = @terminalEventId,
               terminal_idempotency_key = @terminalIdempotencyKey,
               terminal_correlation_id = @correlationId,
               terminal_authority_kind = 'lifecycle_delete',
               terminal_lifecycle_intent_id = @lifecycleIntentId
           WHERE admission_id = @admissionId AND status = 'active'`,
        )
        .run({
          admissionId: row.admission_id,
          closedAt,
          actorId,
          terminalEventId: deriveId("csmae", row.admission_id, terminalIdempotencyKey),
          terminalIdempotencyKey,
          correlationId,
          lifecycleIntentId,
        });
    }
  }

  private nextControlEventSequence(sessionId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(event_sequence), 0) AS sequence FROM chat_session_control_events WHERE session_id = @sessionId",
      )
      .get<{ sequence: number | bigint | string }>({ sessionId });
    return asNonNegativeInteger(row?.sequence ?? 0) + 1;
  }

  private readDatabaseTime(): string {
    const sql =
      this.db.dialect === "postgres"
        ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`;
    const row = this.db.prepare(sql).get<{ now: string }>();
    if (!row?.now) throw new TypeError("database clock did not return a timestamp");
    return row.now;
  }

  private acquireSessionLock(sessionId: string): void {
    if (this.db.dialect === "postgres") {
      this.db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(@sessionId, 411))").get({ sessionId });
    }
  }
}

function normalizeInitializeInput(input: InitializeChatSessionLifecycleInput) {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    sessionId: identifier(input.sessionId, "sessionId"),
    actorId: identifier(input.actorId, "actorId"),
    idempotencyKey: boundedIdentifier(input.idempotencyKey, "idempotencyKey", 512),
    correlationId: identifier(input.correlationId, "correlationId"),
    metadataTimestamp: input.metadataTimestamp,
  };
}

function normalizeDeletionInput(input: PrepareChatSessionDeletionTreeInput) {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    rootSessionId: identifier(input.rootSessionId, "rootSessionId"),
    expectedRootRevision: positiveInteger(input.expectedRootRevision, "expectedRootRevision"),
    actorId: identifier(input.actorId, "actorId"),
    idempotencyKey: boundedIdentifier(input.idempotencyKey, "idempotencyKey", 512),
    correlationId: identifier(input.correlationId, "correlationId"),
  };
}

function activationRequestSha256(input: {
  workspaceId: string;
  sessionId: string;
  actorId: string;
  idempotencyKey: string;
  correlationId: string;
  intentKind: "initialize" | "reactivate";
  expectedGeneration?: number;
  nextGeneration: number;
}): string {
  return sha256(
    canonicalJsonString({
      actorId: input.actorId,
      correlationId: input.correlationId,
      expectedGeneration: input.expectedGeneration ?? null,
      idempotencyKey: input.idempotencyKey,
      intentKind: input.intentKind,
      nextGeneration: input.nextGeneration,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    }),
  );
}

function deleteRequestSha256(input: {
  workspaceId: string;
  sessionId: string;
  actorId: string;
  idempotencyKey: string;
  correlationId: string;
  expectedGeneration: number;
  expectedRevision: number;
  sessionIncarnationId: string;
}): string {
  return sha256(
    canonicalJsonString({
      actorId: input.actorId,
      correlationId: input.correlationId,
      expectedGeneration: input.expectedGeneration,
      expectedRevision: input.expectedRevision,
      sessionIncarnationId: input.sessionIncarnationId,
      idempotencyKey: input.idempotencyKey,
      intentKind: "delete",
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    }),
  );
}

function childDeleteIdempotencyPrefix(rootIdempotencyKey: string): string {
  return `lifecycle:delete-child:${sha256(rootIdempotencyKey).slice(0, 40)}:`;
}

function deriveChildDeleteIdempotencyKey(rootIdempotencyKey: string, childSessionId: string): string {
  return `${childDeleteIdempotencyPrefix(rootIdempotencyKey)}${sha256(
    canonicalJsonString([rootIdempotencyKey, childSessionId]),
  ).slice(0, 48)}`;
}

function mapIntent(row: LifecycleIntentRow): ChatSessionLifecycleIntentRecord {
  return {
    intentId: row.intent_id,
    sessionIncarnationId: row.session_incarnation_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    intentKind: row.intent_kind,
    expectedGeneration: row.expected_generation === null ? undefined : asPositiveInteger(row.expected_generation),
    nextGeneration: asPositiveInteger(row.next_generation),
    expectedRevision: row.expected_revision === null ? undefined : asPositiveInteger(row.expected_revision),
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
    correlationId: row.correlation_id,
    eventId: row.event_id,
    createdAt: row.created_at,
  };
}

function resolveMetaIncarnationId(meta: MetaAuthorityRow): string {
  return meta.lifecycle_intent_id ?? legacySessionIncarnationId(meta.session_id);
}

function legacySessionIncarnationId(sessionId: string): string {
  return `legacy-session-incarnation:${sessionId}`;
}

function identifier(value: string, field: string): string {
  return boundedIdentifier(value, field, 256);
}

function boundedIdentifier(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (!normalized) throw new ValidationError({ code: "FIELD_REQUIRED", field });
  if (normalized.length > max) throw new ValidationError({ field });
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new ValidationError({ field });
  return value;
}

function asPositiveInteger(value: number | bigint | string): number {
  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw lifecycleConflict("CHAT_SESSION_LIFECYCLE_CORRUPT", "Chat session lifecycle numeric state is corrupt.");
  }
  return parsed;
}

function asNonNegativeInteger(value: number | bigint | string): number {
  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw lifecycleConflict("CHAT_SESSION_LIFECYCLE_CORRUPT", "Chat session lifecycle numeric state is corrupt.");
  }
  return parsed;
}

function isCurrent(value: number | bigint | string): boolean {
  return value === 1 || value === 1n || value === "1";
}

function increment(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw lifecycleConflict("CHAT_SESSION_GENERATION_EXHAUSTED", "Chat session generation is exhausted.");
  }
  return value + 1;
}

function deriveId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256(canonicalJsonString(parts)).slice(0, 48)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function lifecycleConflict(code: string, message: string): ConflictError {
  return new ConflictError({ code: "STATE_CONFLICT", message, details: { sessionLifecycleCode: code } });
}

function writeConflict(sessionId: string, expectedRevision: number, currentRevision: number): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: `chat_session ${sessionId} changed since revision ${expectedRevision}`,
    details: {
      resourceKind: "chat_session",
      resourceId: sessionId,
      expectedRevision,
      currentRevision,
    },
  });
}
