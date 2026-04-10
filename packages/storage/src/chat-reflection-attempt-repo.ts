import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";

export interface ChatReflectionAttemptRecord {
  attemptId: string;
  turnId: string;
  sessionId: string;
  reason: string;
  outcome: string;
  attemptCount: number;
  strategy?: string;
  error?: string;
  createdAt: string;
}

export interface CreateChatReflectionAttemptInput {
  attemptId?: string;
  turnId: string;
  sessionId: string;
  reason: string;
  outcome: string;
  attemptCount?: number;
  strategy?: string;
  error?: string | null;
  createdAt?: string;
}

export class ChatReflectionAttemptRepository {
  private readonly insertStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO chat_reflection_attempts (
        attempt_id, turn_id, session_id, reason, outcome, attempt_count, strategy, error, created_at
      ) VALUES (
        @attemptId, @turnId, @sessionId, @reason, @outcome, @attemptCount, @strategy, @error, @createdAt
      )
    `);
  }

  public create(input: CreateChatReflectionAttemptInput): ChatReflectionAttemptRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const record: ChatReflectionAttemptRecord = {
      attemptId: input.attemptId ?? randomUUID(),
      turnId: input.turnId,
      sessionId: input.sessionId,
      reason: input.reason,
      outcome: input.outcome,
      attemptCount: Math.max(1, Math.floor(input.attemptCount ?? 1)),
      strategy: input.strategy?.trim() || undefined,
      error: input.error?.trim() || undefined,
      createdAt,
    };
    this.insertStmt.run({
      attemptId: record.attemptId,
      turnId: record.turnId,
      sessionId: record.sessionId,
      reason: record.reason,
      outcome: record.outcome,
      attemptCount: record.attemptCount,
      strategy: record.strategy ?? null,
      error: record.error ?? null,
      createdAt: record.createdAt,
    });
    return record;
  }
}
