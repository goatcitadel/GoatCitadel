import {
  ConflictError,
  NotFoundError,
  assertGovernedLifecycleEventRecord,
  canonicalJsonString,
  type GovernanceJourneyEventRecord,
  type GovernedLifecycleEventRecord,
  type GovernedMutationDomain,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { GovernanceJourneyEventRepository } from "./governance-journey-event-repo.js";

/**
 * HX-402 P0: the ONE immutable lifecycle source for governed memory and direct
 * skill/capability transitions (and improvement settlements once P3 lands).
 *
 * Append-only in both dialects (no-update/no-delete triggers), fail-closed on
 * any kind outside the frozen governed-mutation registry, exact on replay
 * (identical bytes return the original event; the same identity with
 * different material conflicts), and transactionally coupled to the
 * governance Journey owner: `createWithJourney` writes the lifecycle event
 * and its Journey events in one nested-safe database transaction, so a
 * Journey failure rolls the lifecycle event back.
 */
interface GovernedLifecycleEventRow {
  schema_version: GovernedLifecycleEventRecord["schemaVersion"];
  event_id: string;
  idempotency_key: string;
  domain: GovernedLifecycleEventRecord["domain"];
  operation: GovernedLifecycleEventRecord["operation"];
  target_kind: GovernedLifecycleEventRecord["targetKind"];
  target_id: string;
  material_sha256: string;
  scope_kind: GovernedLifecycleEventRecord["scopeKind"];
  workspace_id: string | null;
  actor_id: string;
  actor_type: GovernedLifecycleEventRecord["actorType"];
  session_id: string | null;
  turn_id: string | null;
  source_required: number | string;
  approval_required: number | string;
  source_kind: string | null;
  source_id: string | null;
  approval_id: string | null;
  occurred_at: string;
  recorded_at: string;
}

export class GovernedLifecycleEventRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly getByIdempotencyKeyStmt;
  private readonly listByTargetStmt;
  private readonly journeyEvents: GovernanceJourneyEventRepository;

  public constructor(private readonly db: DatabaseClient) {
    this.journeyEvents = new GovernanceJourneyEventRepository(db);
    this.insertStmt = db.prepare(`
      INSERT INTO governed_lifecycle_events (
        schema_version, event_id, idempotency_key, domain, operation, target_kind, target_id,
        material_sha256, scope_kind, workspace_id, actor_id, actor_type, session_id, turn_id,
        source_required, approval_required, source_kind, source_id, approval_id,
        occurred_at, recorded_at
      ) VALUES (
        @schemaVersion, @eventId, @idempotencyKey, @domain, @operation, @targetKind, @targetId,
        @materialSha256, @scopeKind, @workspaceId, @actorId, @actorType, @sessionId, @turnId,
        @sourceRequired, @approvalRequired, @sourceKind, @sourceId, @approvalId,
        @occurredAt, @recordedAt
      )
      ON CONFLICT DO NOTHING
    `);
    this.getStmt = db.prepare("SELECT * FROM governed_lifecycle_events WHERE event_id = ?");
    this.getByIdempotencyKeyStmt = db.prepare("SELECT * FROM governed_lifecycle_events WHERE idempotency_key = ?");
    this.listByTargetStmt = db.prepare(`
      SELECT * FROM governed_lifecycle_events
      WHERE domain = @domain AND target_kind = @targetKind AND target_id = @targetId
      ORDER BY recorded_at DESC, event_id DESC
      LIMIT @limit
    `);
  }

  /**
   * Append one governed lifecycle event. Exact replay (identical canonical
   * bytes) returns the original stored event; the same event ID or
   * idempotency key with different material throws a write conflict.
   */
  public create(input: GovernedLifecycleEventRecord): GovernedLifecycleEventRecord {
    assertGovernedLifecycleEventRecord(input);
    this.insertStmt.run(toBindings(input));
    const stored = this.findByIdempotencyKey(input.idempotencyKey) ?? this.find(input.eventId);
    if (!stored) throw new Error(`Governed lifecycle event ${input.eventId} was not persisted.`);
    assertImmutableReplay(stored, input);
    return stored;
  }

  /**
   * Append the lifecycle event and its Journey events in ONE nested-safe
   * database transaction. The Journey builder receives the stored lifecycle
   * event so producers can derive exact evidence linkage
   * (`{ owner: "governed_lifecycle", refId: event.eventId }`); any Journey
   * failure rolls the lifecycle event back.
   */
  public createWithJourney(
    input: GovernedLifecycleEventRecord,
    buildJourneyEvents: (stored: GovernedLifecycleEventRecord) => readonly GovernanceJourneyEventRecord[],
  ): { event: GovernedLifecycleEventRecord; journeyEvents: GovernanceJourneyEventRecord[] } {
    return this.db.transaction("immediate", () => {
      const event = this.create(input);
      const journeyEvents = [...buildJourneyEvents(event)].map((journeyEvent) =>
        this.journeyEvents.create(journeyEvent),
      );
      return { event, journeyEvents };
    });
  }

  public get(eventId: string): GovernedLifecycleEventRecord {
    const found = this.find(eventId);
    if (!found) throw new NotFoundError({ entity: "governed lifecycle event", id: eventId });
    return found;
  }

  public find(eventId: string): GovernedLifecycleEventRecord | undefined {
    assertCanonicalIdentity(eventId, "event ID", 256);
    const row = this.getStmt.get(eventId) as GovernedLifecycleEventRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public findByIdempotencyKey(idempotencyKey: string): GovernedLifecycleEventRecord | undefined {
    assertCanonicalIdentity(idempotencyKey, "idempotency key", 512);
    const row = this.getByIdempotencyKeyStmt.get(idempotencyKey) as GovernedLifecycleEventRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  /**
   * Exact-scope read: a workspace event is only visible under its own
   * workspace, and global events only when explicitly requested. Missing
   * scope is never replaced with an inferred default.
   */
  public findScoped(
    eventId: string,
    workspaceId: string,
    includeGlobal = false,
  ): GovernedLifecycleEventRecord | undefined {
    assertCanonicalIdentity(workspaceId, "workspace ID", 256);
    const event = this.find(eventId);
    if (!event) return undefined;
    if (event.scopeKind === "global") return includeGlobal ? event : undefined;
    return event.workspaceId === workspaceId ? event : undefined;
  }

  public listByTarget(
    domain: GovernedMutationDomain,
    targetKind: string,
    targetId: string,
    limit = 100,
  ): GovernedLifecycleEventRecord[] {
    assertCanonicalIdentity(targetKind, "target kind", 128);
    assertCanonicalIdentity(targetId, "target ID", 256);
    const rows = this.listByTargetStmt.all({
      domain,
      targetKind,
      targetId,
      limit: Math.max(1, Math.min(Math.trunc(limit), 500)),
    }) as unknown as GovernedLifecycleEventRow[];
    return rows.map(mapRow);
  }
}

function toBindings(input: GovernedLifecycleEventRecord): Record<string, unknown> {
  return {
    schemaVersion: input.schemaVersion,
    eventId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    domain: input.domain,
    operation: input.operation,
    targetKind: input.targetKind,
    targetId: input.targetId,
    materialSha256: input.materialSha256,
    scopeKind: input.scopeKind,
    workspaceId: input.workspaceId ?? null,
    actorId: input.actorId,
    actorType: input.actorType,
    sessionId: input.sessionId ?? null,
    turnId: input.turnId ?? null,
    sourceRequired: input.sourceRequired ? 1 : 0,
    approvalRequired: input.approvalRequired ? 1 : 0,
    sourceKind: input.sourceKind ?? null,
    sourceId: input.sourceId ?? null,
    approvalId: input.approvalId ?? null,
    occurredAt: input.occurredAt,
    recordedAt: input.recordedAt,
  };
}

function mapRow(row: GovernedLifecycleEventRow): GovernedLifecycleEventRecord {
  const record: GovernedLifecycleEventRecord = {
    schemaVersion: row.schema_version,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    domain: row.domain,
    operation: row.operation,
    targetKind: row.target_kind,
    targetId: row.target_id,
    materialSha256: row.material_sha256,
    scopeKind: row.scope_kind,
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    actorId: row.actor_id,
    actorType: row.actor_type,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    sourceRequired: Number(row.source_required) === 1,
    approvalRequired: Number(row.approval_required) === 1,
    ...(row.source_kind === null ? {} : { sourceKind: row.source_kind }),
    ...(row.source_id === null ? {} : { sourceId: row.source_id }),
    ...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
  assertGovernedLifecycleEventRecord(record);
  return record;
}

function assertImmutableReplay(stored: GovernedLifecycleEventRecord, attempted: GovernedLifecycleEventRecord): void {
  // canonicalJsonString drops undefined members, so an attempt with explicit
  // undefined optionals compares byte-identically to the stored omitted form.
  if (canonicalJsonString(stored) !== canonicalJsonString(attempted)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Governed lifecycle event ${attempted.eventId} conflicts with an existing immutable record.`,
    });
  }
}

function assertCanonicalIdentity(value: string, label: string, maxLength: number): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    value !== value.normalize("NFKC").trim()
  ) {
    throw new TypeError(`Governed lifecycle ${label} must use its bounded canonical identity form.`);
  }
}
