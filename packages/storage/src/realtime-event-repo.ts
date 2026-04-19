import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";
import { getRequestAttribution } from "./request-attribution.js";

const REALTIME_EVENT_CLASS_KEY = "__gcEventClass";
const REALTIME_EVENT_AUTHORITY_KEY = "__gcEventAuthority";
const REALTIME_EVENT_LINKS_KEY = "__gcEventLinks";

interface RealtimeEventRow {
  event_id: string;
  sequence: number;
  event_type: string;
  source: string;
  payload_json: string;
  created_at: string;
}

export class RealtimeEventRepository {
  private readonly insertStmt;
  private readonly allocateSequenceStmt;
  private readonly listLatestStmt;
  private readonly listBySequenceStmt;
  private readonly listAfterSequenceStmt;
  private readonly boundsStmt;
  private readonly listStmt;
  private readonly countStmt;
  private readonly pruneOverflowStmt;
  private readonly pruneOlderThanStmt;
  private appendCount = 0;

  public constructor(private readonly db: DatabaseClient) {
    this.allocateSequenceStmt = db.prepare(`
      UPDATE realtime_event_sequence_state
      SET last_sequence = last_sequence + 1
      WHERE stream_name = 'events'
      RETURNING last_sequence
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO realtime_events (
        event_id, sequence, event_type, source, payload_json, created_at
      ) VALUES (
        @eventId, @sequence, @eventType, @source, @payloadJson, @createdAt
      )
    `);

    this.listLatestStmt = db.prepare(`
      SELECT * FROM realtime_events
      ORDER BY sequence DESC
      LIMIT @limit
    `);

    this.listBySequenceStmt = db.prepare(`
      SELECT * FROM realtime_events
      WHERE sequence < @cursorSequence
      ORDER BY sequence DESC
      LIMIT @limit
    `);

    this.listAfterSequenceStmt = db.prepare(`
      SELECT * FROM realtime_events
      WHERE sequence > @afterSequence
      ORDER BY sequence ASC
      LIMIT @limit
    `);

    this.boundsStmt = db.prepare(`
      SELECT
        MIN(sequence) AS oldest_sequence,
        MAX(sequence) AS newest_sequence
      FROM realtime_events
    `);

    this.listStmt = db.prepare(`
      SELECT * FROM realtime_events
      WHERE (
        @cursorCreatedAt IS NULL
        OR created_at < @cursorCreatedAt
        OR (created_at = @cursorCreatedAt AND event_id < @cursorEventId)
      )
      ORDER BY created_at DESC, event_id DESC
      LIMIT @limit
    `);

    this.countStmt = db.prepare(`
      SELECT COUNT(*) AS count
      FROM realtime_events
    `);
    this.pruneOverflowStmt = db.prepare(`
      DELETE FROM realtime_events
      WHERE event_id IN (
        SELECT event_id
        FROM realtime_events
        ORDER BY created_at ASC, event_id ASC
        LIMIT @overflowRows
      )
    `);
    this.pruneOlderThanStmt = db.prepare(`
      DELETE FROM realtime_events
      WHERE created_at < @cutoff
    `);
  }

  public append(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
    createdAt = new Date().toISOString(),
  ): RealtimeEvent {
    const normalizedOptions = normalizeRealtimeEventOptions(eventType, source, payload, options);
    const attribution = getRequestAttribution();
    const attributedPayload = {
      ...embedRealtimeEnvelope(payload, normalizedOptions),
      correlationId: options?.correlationId ?? payload.correlationId ?? attribution?.correlationId,
      traceId: payload.traceId ?? attribution?.traceId,
      originSurface: payload.originSurface ?? attribution?.originSurface,
      actorId: payload.actorId ?? attribution?.actorId,
      deviceId: payload.deviceId ?? attribution?.deviceId,
      grantId: payload.grantId ?? attribution?.grantId,
    };
    const eventId = randomUUID();
    const sequence = this.db.transaction("immediate", () => {
      const nextSequenceRow = toSequenceStateRow(this.allocateSequenceStmt.get());
      const allocatedSequence = Number(nextSequenceRow?.last_sequence ?? 1);
      this.insertStmt.run({
        eventId,
        sequence: allocatedSequence,
        eventType,
        source,
        payloadJson: JSON.stringify(attributedPayload),
        createdAt,
      });
      return allocatedSequence;
    });
    this.appendCount += 1;
    if (this.appendCount % 100 === 0) {
      this.pruneToMaxRows(10000);
    }

    return {
      eventId,
      sequence,
      eventType,
      source,
      timestamp: createdAt,
      ...extractRealtimeMetadata(attributedPayload),
      payload: stripRealtimeEnvelope(attributedPayload),
    };
  }

  public list(limit: number, cursor?: string): RealtimeEvent[] {
    const sequenceCursor = parseSequenceCursor(cursor);
    if (sequenceCursor !== undefined) {
      const rows =
        sequenceCursor > 0
          ? this.listBySequenceStmt.all({
              limit,
              cursorSequence: sequenceCursor,
            })
          : this.listLatestStmt.all({ limit });
      return toRealtimeEventRows(rows).map(mapRealtimeEventRow);
    }

    const parsedCursor = parseCompositeCursor(cursor);
    const rows = parsedCursor
      ? this.listStmt.all({
          limit,
          cursorCreatedAt: parsedCursor.timestamp,
          cursorEventId: parsedCursor.key,
        })
      : this.listLatestStmt.all({ limit });

    return toRealtimeEventRows(rows).map(mapRealtimeEventRow);
  }

  public listAfterSequence(afterSequence: number, limit: number): RealtimeEvent[] {
    const rows = toRealtimeEventRows(
      this.listAfterSequenceStmt.all({
        afterSequence,
        limit,
      }),
    );
    return rows.map(mapRealtimeEventRow);
  }

  public getSequenceBounds(): { oldestSequence?: number; newestSequence?: number } {
    const row = this.boundsStmt.get() as
      | {
          oldest_sequence?: number | null;
          newest_sequence?: number | null;
        }
      | undefined;
    return {
      oldestSequence: typeof row?.oldest_sequence === "number" ? row.oldest_sequence : undefined,
      newestSequence: typeof row?.newest_sequence === "number" ? row.newest_sequence : undefined,
    };
  }

  public pruneOlderThan(cutoffIso: string): number {
    const before = this.db.prepare("SELECT COUNT(*) AS count FROM realtime_events WHERE created_at < ?").get(cutoffIso);
    const countRow = toCountRow(before);
    const count = Number(countRow?.count ?? 0);
    if (count <= 0) {
      return 0;
    }
    this.pruneOlderThanStmt.run({ cutoff: cutoffIso });
    return count;
  }

  public pruneToMaxRows(maxRows: number): number {
    const normalizedMaxRows = Math.max(1, Math.floor(maxRows));
    return this.db.transaction("immediate", () => {
      const countRow = toCountRow(this.countStmt.get());
      const totalRows = Number(countRow?.count ?? 0);
      if (totalRows <= normalizedMaxRows) {
        return 0;
      }
      const overflowRows = totalRows - normalizedMaxRows;
      this.pruneOverflowStmt.run({
        overflowRows,
      });
      return overflowRows;
    });
  }
}

interface CompositeCursor {
  timestamp: string;
  key: string;
}

function parseCompositeCursor(cursor?: string): CompositeCursor | undefined {
  if (!cursor) {
    return undefined;
  }

  const separator = cursor.lastIndexOf("|");
  if (separator <= 0) {
    return {
      timestamp: cursor,
      key: "",
    };
  }

  const timestamp = cursor.slice(0, separator);
  const key = cursor.slice(separator + 1);
  if (!timestamp || !key) {
    return undefined;
  }

  return { timestamp, key };
}

function parseSequenceCursor(cursor?: string): number | undefined {
  if (!cursor || !/^\d+$/.test(cursor.trim())) {
    return undefined;
  }
  const value = Number.parseInt(cursor.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRealtimeEventRow(value: unknown): value is RealtimeEventRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.event_id === "string" &&
    typeof value.sequence === "number" &&
    typeof value.event_type === "string" &&
    typeof value.source === "string" &&
    typeof value.payload_json === "string" &&
    typeof value.created_at === "string"
  );
}

function toRealtimeEventRows(value: unknown): RealtimeEventRow[] {
  return Array.isArray(value) ? value.filter(isRealtimeEventRow) : [];
}

function toSequenceStateRow(value: unknown): { last_sequence?: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.last_sequence === "number" || value.last_sequence === undefined
    ? { last_sequence: value.last_sequence as number | undefined }
    : undefined;
}

function toCountRow(value: unknown): { count?: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.count === "number" || value.count === undefined
    ? { count: value.count as number | undefined }
    : undefined;
}

function isRealtimeEventClass(value: string): value is NonNullable<RealtimeEvent["eventClass"]> {
  return value === "domain_fact" || value === "operational_signal" || value === "ui_notification";
}

function isRealtimeEventAuthority(value: string): value is NonNullable<RealtimeEvent["eventAuthority"]> {
  return value === "retained_stream" || value === "durable_history" || value === "derived_projection";
}

function parseRealtimePayload(raw: string): Record<string, unknown> {
  const parsed = safeJsonParse<unknown>(raw, {});
  return isRecord(parsed) ? parsed : {};
}

function mapRealtimeEventRow(row: RealtimeEventRow): RealtimeEvent {
  const payload = parseRealtimePayload(row.payload_json);
  return {
    eventId: row.event_id,
    sequence: Number(row.sequence),
    eventType: row.event_type,
    source: row.source,
    timestamp: row.created_at,
    ...extractRealtimeMetadata(payload),
    payload: stripRealtimeEnvelope(payload),
  };
}

function extractRealtimeMetadata(
  payload: Record<string, unknown>,
): Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId" | "traceId" | "originSurface"> {
  const links = payload[REALTIME_EVENT_LINKS_KEY];
  return {
    eventClass:
      typeof payload[REALTIME_EVENT_CLASS_KEY] === "string" && isRealtimeEventClass(payload[REALTIME_EVENT_CLASS_KEY])
        ? payload[REALTIME_EVENT_CLASS_KEY]
        : undefined,
    eventAuthority:
      typeof payload[REALTIME_EVENT_AUTHORITY_KEY] === "string" &&
      isRealtimeEventAuthority(payload[REALTIME_EVENT_AUTHORITY_KEY])
        ? payload[REALTIME_EVENT_AUTHORITY_KEY]
        : undefined,
    links:
      links && typeof links === "object" && !Array.isArray(links)
        ? Object.fromEntries(
            Object.entries(links).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
          )
        : undefined,
    correlationId: typeof payload.correlationId === "string" ? payload.correlationId : undefined,
    traceId: typeof payload.traceId === "string" ? payload.traceId : undefined,
    originSurface: typeof payload.originSurface === "string" ? payload.originSurface : undefined,
  };
}

function embedRealtimeEnvelope(
  payload: Record<string, unknown>,
  options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links">,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...stripRealtimeEnvelope(payload),
  };
  if (options?.eventClass) {
    next[REALTIME_EVENT_CLASS_KEY] = options.eventClass;
  }
  if (options?.eventAuthority) {
    next[REALTIME_EVENT_AUTHORITY_KEY] = options.eventAuthority;
  }
  if (options?.links) {
    const links = Object.fromEntries(
      Object.entries(options.links).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
    );
    if (Object.keys(links).length > 0) {
      next[REALTIME_EVENT_LINKS_KEY] = links;
    }
  }
  return next;
}

function normalizeRealtimeEventOptions(
  eventType: string,
  source: string,
  payload: Record<string, unknown>,
  options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links">,
): Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links"> | undefined {
  if (requiresExplicitRealtimeMetadata(eventType, source)) {
    return requireExplicitRealtimeEventOptions(eventType, source, options);
  }
  const inferred = inferRealtimeEventMetadata(eventType, source, payload);
  const normalizedLinks = normalizeRealtimeLinks({
    ...(inferred.links ?? {}),
    ...(options?.links ?? {}),
  });
  const next = {
    eventClass: options?.eventClass ?? inferred.eventClass,
    eventAuthority: options?.eventAuthority ?? inferred.eventAuthority,
    links: normalizedLinks,
  };
  return next.eventClass || next.eventAuthority || next.links ? next : undefined;
}

function requireExplicitRealtimeEventOptions(
  eventType: string,
  source: string,
  options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links">,
): Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links"> {
  const normalizedLinks = normalizeRealtimeLinks(options?.links);
  if (!options?.eventClass || !options?.eventAuthority || !normalizedLinks) {
    throw new Error(`Explicit realtime metadata is required for protected event ${source}:${eventType}.`);
  }
  return {
    eventClass: options.eventClass,
    eventAuthority: options.eventAuthority,
    links: normalizedLinks,
  };
}

function stripRealtimeEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  if (
    !(REALTIME_EVENT_CLASS_KEY in payload) &&
    !(REALTIME_EVENT_AUTHORITY_KEY in payload) &&
    !(REALTIME_EVENT_LINKS_KEY in payload)
  ) {
    return payload;
  }
  const next = { ...payload };
  delete next[REALTIME_EVENT_CLASS_KEY];
  delete next[REALTIME_EVENT_AUTHORITY_KEY];
  delete next[REALTIME_EVENT_LINKS_KEY];
  return next;
}

function inferRealtimeEventMetadata(
  eventType: string,
  source: string,
  payload: Record<string, unknown>,
): Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links"> {
  const links = normalizeRealtimeLinks({
    approvalId: pickString(payload, ["approvalId"]),
    sessionId: pickString(payload, ["sessionId"]),
    turnId: pickString(payload, ["turnId"]),
    runId: pickString(payload, ["runId", "durableRunId", "durable_run_id"]),
    taskId: pickString(payload, ["taskId"]),
    workspaceId: pickString(payload, ["workspaceId"]),
    connectorId: pickString(payload, ["connectorId"]),
    tokenId: pickString(payload, ["tokenId"]),
    messageId: pickString(payload, ["messageId"]),
  });
  return {
    eventClass: inferRealtimeEventClass(eventType, source),
    eventAuthority: inferRealtimeEventAuthority(eventType, source),
    links,
  };
}

function inferRealtimeEventClass(eventType: string, source: string): RealtimeEvent["eventClass"] {
  const haystack = `${eventType} ${source}`.toLowerCase();
  if (
    haystack.includes("approval_remote_action_ready") ||
    haystack.includes("auth_device_request_created") ||
    haystack.includes("replay_gap")
  ) {
    return "ui_notification";
  }
  if (
    haystack.includes("system") ||
    haystack.includes("cron") ||
    haystack.includes("durable") ||
    haystack.includes("connector") ||
    haystack.includes("integration") ||
    haystack.includes("memory")
  ) {
    return "operational_signal";
  }
  return "domain_fact";
}

function inferRealtimeEventAuthority(eventType: string, source: string): RealtimeEvent["eventAuthority"] {
  const haystack = `${eventType} ${source}`.toLowerCase();
  if (haystack.includes("projection") || haystack.includes("summary")) {
    return "derived_projection";
  }
  return "retained_stream";
}

function requiresExplicitRealtimeMetadata(eventType: string, source: string): boolean {
  const normalizedType = eventType.trim().toLowerCase();
  const normalizedSource = source.trim().toLowerCase();
  if (
    normalizedType === "approval_created" ||
    normalizedType === "approval_resolved" ||
    normalizedType === "session_event" ||
    normalizedType === "auth_device_request_created" ||
    normalizedType === "auth_device_request_resolved" ||
    normalizedType === "task_created" ||
    normalizedType === "task_updated" ||
    normalizedType === "task_deleted" ||
    normalizedType === "orchestration_event"
  ) {
    return true;
  }
  return normalizedSource === "orchestration";
}

function normalizeRealtimeLinks(links?: RealtimeEvent["links"]): RealtimeEvent["links"] {
  if (!links) {
    return undefined;
  }
  const normalized = Object.fromEntries(
    Object.entries(links).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  ) as Record<string, string>;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function pickString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    const record = current as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return undefined;
}
