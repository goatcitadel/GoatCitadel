import type { DatabaseClient } from "./db.js";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";

export interface ChatSessionRevisionRecord {
  sessionId: string;
  revision: number;
}

export interface ChatSessionRevisionMutation<T> {
  value: T;
  changed: boolean;
}

export interface ChatSessionRevisionMutationResult<T> extends ChatSessionRevisionMutation<T> {
  revision: number;
}

interface ChatSessionRevisionRow {
  session_id: string;
  revision: number;
}

/**
 * Owns the single operator-facing revision for the Chat session aggregate.
 *
 * Child repositories fence this row before mutating session metadata, prefs,
 * autonomy prefs, or project assignment. Because every repository shares the
 * same DatabaseClient, callers can wrap a multi-repository mutation in the
 * outer storage transaction and retain one rollback boundary.
 */
export class ChatSessionRevisionRepository {
  private readonly getStmt;
  private readonly fenceStmt;
  private readonly bumpStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT session_id, revision FROM chat_session_meta WHERE session_id = ?");
    this.fenceStmt = db.prepare(`
      UPDATE chat_session_meta
      SET revision = revision
      WHERE session_id = @sessionId
        AND revision = @expectedRevision
    `);
    this.bumpStmt = db.prepare(`
      UPDATE chat_session_meta
      SET revision = revision + 1,
          updated_at = @updatedAt
      WHERE session_id = @sessionId
        AND revision = @expectedRevision
    `);
  }

  public get(sessionId: string): ChatSessionRevisionRecord | undefined {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const row = toRevisionRow(this.getStmt.get(normalizedSessionId));
    return row ? { sessionId: row.session_id, revision: row.revision } : undefined;
  }

  public ensure(sessionId: string, _now = new Date().toISOString()): ChatSessionRevisionRecord {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const record = this.get(normalizedSessionId);
    if (!record) {
      throw new NotFoundError({ entity: "chat session revision", id: normalizedSessionId });
    }
    return record;
  }

  public runWithRevision<T>(
    sessionId: string,
    expectedRevision: number,
    mutation: () => ChatSessionRevisionMutation<T>,
    now = new Date().toISOString(),
  ): ChatSessionRevisionMutationResult<T> {
    const normalizedSessionId = normalizeSessionId(sessionId);
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      this.fence(normalizedSessionId, expectedRevision);
      const result = mutation();
      if (!result.changed) {
        return { ...result, revision: expectedRevision };
      }
      const bumped = this.bumpStmt.run({
        sessionId: normalizedSessionId,
        expectedRevision,
        updatedAt: now,
      });
      if (bumped.changes === 0) {
        this.throwCasMiss(normalizedSessionId, expectedRevision);
      }
      return { ...result, revision: expectedRevision + 1 };
    });
  }

  public runDeleteWithRevision<T>(sessionId: string, expectedRevision: number, mutation: () => T): T {
    const normalizedSessionId = normalizeSessionId(sessionId);
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      this.fence(normalizedSessionId, expectedRevision);
      return mutation();
    });
  }

  private fence(sessionId: string, expectedRevision: number): void {
    const fenced = this.fenceStmt.run({ sessionId, expectedRevision });
    if (fenced.changes === 0) {
      this.throwCasMiss(sessionId, expectedRevision);
    }
  }

  private throwCasMiss(sessionId: string, expectedRevision: number): never {
    const current = this.get(sessionId);
    if (!current) {
      throw new NotFoundError({ entity: "Chat session", id: sessionId });
    }
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `chat_session ${sessionId} changed since revision ${expectedRevision}`,
      details: {
        resourceKind: "chat_session",
        resourceId: sessionId,
        expectedRevision,
        currentRevision: current.revision,
      },
    });
  }
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "sessionId" });
  }
  return normalized;
}

function validateExpectedRevision(expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ValidationError({ field: "expectedRevision" });
  }
}

function toRevisionRow(value: unknown): ChatSessionRevisionRow | undefined {
  return isRecord(value) &&
    typeof value.session_id === "string" &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0
    ? { session_id: value.session_id, revision: Number(value.revision) }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
