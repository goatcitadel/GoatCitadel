import type { DatabaseClient } from "./db.js";
import type {
  ChatCitationRecord,
  ChatDelegationStepRecord,
  ChatDelegationStepStatus,
  ChatSessionDelegationParentRecord,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface ChatDelegationStepRow {
  step_id: string;
  run_id: string;
  role: string;
  label: string | null;
  step_index: number;
  status: ChatDelegationStepStatus;
  parallelizable: number | boolean;
  depends_on_step_ids_json: string;
  provider_id: string | null;
  model: string | null;
  summary: string | null;
  output: string | null;
  error: string | null;
  failure_guidance: string | null;
  durable_run_id: string | null;
  child_session_id: string | null;
  child_turn_id: string | null;
  dispatch_claim_token: string | null;
  dispatch_claim_expires_at: string | null;
  citations_json: string | null;
  degraded_handoff_step_ids_json: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface ChatDelegationDispatchClaim {
  token: string;
  expiresAt: string;
}

export interface ChatDelegationApprovalMaterializationResult {
  outcome: "applied" | "converged" | "rejected";
  step: ChatDelegationStepRecord;
}

interface ChatDelegationParentRow extends ChatDelegationStepRow {
  parent_session_id: string;
}

export class ChatDelegationStepRepository {
  private readonly databaseNowStmt;
  private readonly getStmt;
  private readonly getForUpdateStmt;
  private readonly getDispatchClaimStmt;
  private readonly insertStmt;
  private readonly patchStmt;
  private readonly materializeApprovalOutcomeStmt;
  private readonly listByRunStmt;
  private readonly listByRunForUpdateStmt;
  private readonly claimPendingDispatchStmt;
  private readonly claimUnlinkedRunningDispatchStmt;
  private readonly reclaimDispatchMarkerStmt;
  private readonly linkClaimedDispatchStmt;
  private readonly claimLinkedDispatchStmt;
  private readonly claimFinalizedLinkedDispatchStmt;
  private readonly reclaimLinkedDispatchStmt;
  private readonly finalizeLinkedDispatchStmt;
  private readonly ownsLinkedDispatchStmt;
  private readonly finishOwnedDispatchWithErrorStmt;
  private readonly finishOwnedDispatchWithResponseStmt;
  private readonly releaseOwnedWaitingDispatchStmt;
  private readonly finishUnclaimedPendingWithErrorStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.databaseNowStmt = db.prepare(
      db.dialect === "postgres"
        ? `
          SELECT to_char(
            clock_timestamp() AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS now_iso
        `
        : `
          SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now_iso
        `,
    );
    this.getStmt = db.prepare("SELECT * FROM chat_delegation_steps WHERE step_id = ?");
    this.getForUpdateStmt = db.prepare(
      db.dialect === "postgres"
        ? "SELECT * FROM chat_delegation_steps WHERE step_id = ? FOR UPDATE"
        : "SELECT * FROM chat_delegation_steps WHERE step_id = ?",
    );
    this.getDispatchClaimStmt = db.prepare(
      "SELECT dispatch_claim_token, dispatch_claim_expires_at FROM chat_delegation_steps WHERE step_id = ?",
    );
    this.insertStmt = db.prepare(`
      INSERT INTO chat_delegation_steps (
        step_id, run_id, role, label, step_index, status, parallelizable, depends_on_step_ids_json,
        provider_id, model, summary, output, error, started_at, finished_at, duration_ms
        , failure_guidance, durable_run_id, child_session_id, child_turn_id, citations_json, degraded_handoff_step_ids_json
      ) VALUES (
        @stepId, @runId, @role, @label, @index, @status, @parallelizable, @dependsOnStepIdsJson,
        @providerId, @model, @summary, @output, @error, @startedAt, @finishedAt, @durationMs,
        @failureGuidance, @durableRunId, @childSessionId, @childTurnId, @citationsJson, @degradedHandoffStepIdsJson
      )
    `);
    this.patchStmt = db.prepare(`
      UPDATE chat_delegation_steps
      SET
        status = @status,
        parallelizable = @parallelizable,
        depends_on_step_ids_json = @dependsOnStepIdsJson,
        provider_id = @providerId,
        model = @model,
        label = @label,
        summary = @summary,
        output = @output,
        error = @error,
        failure_guidance = @failureGuidance,
        durable_run_id = @durableRunId,
        child_session_id = @childSessionId,
        child_turn_id = @childTurnId,
        dispatch_claim_token = CASE
          WHEN @status IN ('completed', 'failed', 'cancelled', 'skipped') THEN NULL
          ELSE dispatch_claim_token
        END,
        dispatch_claim_expires_at = CASE
          WHEN @status IN ('completed', 'failed', 'cancelled', 'skipped') THEN NULL
          ELSE dispatch_claim_expires_at
        END,
        citations_json = @citationsJson,
        degraded_handoff_step_ids_json = @degradedHandoffStepIdsJson,
        started_at = @startedAt,
        finished_at = @finishedAt,
        duration_ms = @durationMs
      WHERE step_id = @stepId
    `);
    this.materializeApprovalOutcomeStmt = db.prepare(`
      UPDATE chat_delegation_steps
      SET
        status = @status,
        summary = @summary,
        output = @output,
        error = @error,
        failure_guidance = @failureGuidance,
        durable_run_id = COALESCE(@durableRunId, durable_run_id),
        citations_json = @citationsJson,
        finished_at = @finishedAt,
        duration_ms = @durationMs,
        dispatch_claim_token = NULL,
        dispatch_claim_expires_at = NULL
      WHERE step_id = @stepId
        AND status = 'running'
        AND child_session_id = @expectedChildSessionId
        AND child_turn_id = @expectedChildTurnId
        AND dispatch_claim_token IS NULL
        AND dispatch_claim_expires_at IS NULL
    `);
    this.listByRunStmt = db.prepare(`
      SELECT * FROM chat_delegation_steps
      WHERE run_id = @runId
      ORDER BY step_index ASC, started_at ASC, step_id ASC
    `);
    this.listByRunForUpdateStmt = db.prepare(`
      SELECT * FROM chat_delegation_steps
      WHERE run_id = @runId
      ORDER BY step_index ASC, started_at ASC, step_id ASC
      ${db.dialect === "postgres" ? "FOR UPDATE" : ""}
    `);
    this.claimPendingDispatchStmt = db.prepare(`
      UPDATE chat_delegation_steps
      SET status = 'running', dispatch_claim_token = @claimToken,
          dispatch_claim_expires_at = @claimExpiresAt, started_at = @startedAt
      WHERE step_id = @stepId AND status = 'pending'
        AND dispatch_claim_token IS NULL AND child_session_id IS NULL AND child_turn_id IS NULL
    `);
    this.claimUnlinkedRunningDispatchStmt = db.prepare(`
      UPDATE chat_delegation_steps
      SET dispatch_claim_token = @claimToken, dispatch_claim_expires_at = @claimExpiresAt, started_at = @startedAt
      WHERE step_id = @stepId AND status = 'running' AND dispatch_claim_token IS NULL
        AND child_session_id IS NULL AND child_turn_id IS NULL
    `);
    this.reclaimDispatchMarkerStmt = db.prepare(`
      UPDATE chat_delegation_steps
      SET dispatch_claim_token = @claimToken, dispatch_claim_expires_at = @claimExpiresAt, started_at = @startedAt
      WHERE step_id = @stepId AND status = 'running'
        AND dispatch_claim_token = @expectedClaimToken AND child_session_id IS NULL AND child_turn_id IS NULL
    `);
    this.linkClaimedDispatchStmt = db.prepare(`
      UPDATE chat_delegation_steps
      SET child_session_id = @childSessionId, dispatch_claim_token = @dispatchToken,
          dispatch_claim_expires_at = @dispatchExpiresAt
      WHERE step_id = @stepId AND status = 'running' AND dispatch_claim_token = @claimToken
        AND child_session_id IS NULL AND child_turn_id IS NULL
    `);
    this.reclaimLinkedDispatchStmt = db.prepare(`
      UPDATE chat_delegation_steps
      SET dispatch_claim_token = @dispatchToken, dispatch_claim_expires_at = @dispatchExpiresAt,
          started_at = @startedAt
      WHERE step_id = @stepId AND status = 'running'
        AND child_session_id = @childSessionId AND dispatch_claim_token = @expectedDispatchToken
    `);
    this.claimLinkedDispatchStmt = db.prepare(`
      UPDATE chat_delegation_steps
      SET dispatch_claim_token = @dispatchToken, dispatch_claim_expires_at = @dispatchExpiresAt,
          started_at = @startedAt
      WHERE step_id = @stepId AND status = 'running'
        AND child_session_id = @childSessionId AND child_turn_id IS NULL AND dispatch_claim_token IS NULL
    `);
    this.claimFinalizedLinkedDispatchStmt = db.prepare(`
      UPDATE chat_delegation_steps
      SET dispatch_claim_token = @dispatchToken, dispatch_claim_expires_at = @dispatchExpiresAt,
          started_at = @startedAt
      WHERE step_id = @stepId AND status = 'running'
        AND child_session_id = @childSessionId AND child_turn_id = @expectedChildTurnId
        AND dispatch_claim_token IS NULL
    `);
    this.finalizeLinkedDispatchStmt = db.prepare(`
      UPDATE chat_delegation_steps
      SET child_turn_id = @childTurnId, dispatch_claim_token = NULL, dispatch_claim_expires_at = NULL
      WHERE step_id = @stepId AND status = 'running'
        AND child_session_id = @childSessionId AND dispatch_claim_token = @expectedDispatchToken
        AND (child_turn_id IS NULL OR child_turn_id = @childTurnId)
    `);
    this.ownsLinkedDispatchStmt = db.prepare(`
      SELECT step_id
      FROM chat_delegation_steps
      WHERE step_id = @stepId AND status = 'running'
        AND child_session_id = @childSessionId AND dispatch_claim_token = @dispatchToken
        AND dispatch_claim_expires_at IS NOT NULL
        AND ${
          db.dialect === "postgres"
            ? "gc_try_parse_timestamptz(dispatch_claim_expires_at) > clock_timestamp()"
            : "julianday(dispatch_claim_expires_at) > julianday('now')"
        }
      LIMIT 1
    `);
    this.finishOwnedDispatchWithErrorStmt = db.prepare(
      db.dialect === "postgres"
        ? `
          UPDATE chat_delegation_steps
          SET status = @status,
              label = @label,
              summary = @summary,
              error = @error,
              failure_guidance = @failureGuidance,
              finished_at = @finishedAt,
              duration_ms = @durationMs,
              dispatch_claim_token = NULL,
              dispatch_claim_expires_at = NULL
          WHERE step_id = @stepId
            AND status = 'running'
            AND dispatch_claim_token = @expectedDispatchToken
            AND dispatch_claim_expires_at IS NOT NULL
            AND gc_try_parse_timestamptz(dispatch_claim_expires_at) > clock_timestamp()
            AND (
              (CAST(@expectedChildSessionId AS TEXT) IS NULL AND child_session_id IS NULL)
              OR child_session_id = CAST(@expectedChildSessionId AS TEXT)
            )
        `
        : `
          UPDATE chat_delegation_steps
          SET status = @status,
              label = @label,
              summary = @summary,
              error = @error,
              failure_guidance = @failureGuidance,
              finished_at = @finishedAt,
              duration_ms = @durationMs,
              dispatch_claim_token = NULL,
              dispatch_claim_expires_at = NULL
          WHERE step_id = @stepId
            AND status = 'running'
            AND dispatch_claim_token = @expectedDispatchToken
            AND dispatch_claim_expires_at IS NOT NULL
            AND julianday(dispatch_claim_expires_at) > julianday('now')
            AND (
              (@expectedChildSessionId IS NULL AND child_session_id IS NULL)
              OR child_session_id = @expectedChildSessionId
            )
        `,
    );
    this.finishOwnedDispatchWithResponseStmt = db.prepare(
      db.dialect === "postgres"
        ? `
          UPDATE chat_delegation_steps
          SET status = @status,
              provider_id = @providerId,
              model = @model,
              label = @label,
              summary = @summary,
              output = @output,
              error = @error,
              failure_guidance = @failureGuidance,
              durable_run_id = COALESCE(CAST(@durableRunId AS TEXT), durable_run_id),
              child_turn_id = @childTurnId,
              citations_json = @citationsJson,
              finished_at = @finishedAt,
              duration_ms = @durationMs,
              dispatch_claim_token = CASE WHEN @status = 'running' THEN dispatch_claim_token ELSE NULL END,
              dispatch_claim_expires_at = CASE WHEN @status = 'running' THEN dispatch_claim_expires_at ELSE NULL END
          WHERE step_id = @stepId
            AND status = 'running'
            AND child_session_id = @childSessionId
            AND (child_turn_id IS NULL OR child_turn_id = @childTurnId)
            AND dispatch_claim_token = @expectedDispatchToken
            AND dispatch_claim_expires_at IS NOT NULL
            AND gc_try_parse_timestamptz(dispatch_claim_expires_at) > clock_timestamp()
        `
        : `
          UPDATE chat_delegation_steps
          SET status = @status,
              provider_id = @providerId,
              model = @model,
              label = @label,
              summary = @summary,
              output = @output,
              error = @error,
              failure_guidance = @failureGuidance,
              durable_run_id = COALESCE(@durableRunId, durable_run_id),
              child_turn_id = @childTurnId,
              citations_json = @citationsJson,
              finished_at = @finishedAt,
              duration_ms = @durationMs,
              dispatch_claim_token = CASE WHEN @status = 'running' THEN dispatch_claim_token ELSE NULL END,
              dispatch_claim_expires_at = CASE WHEN @status = 'running' THEN dispatch_claim_expires_at ELSE NULL END
          WHERE step_id = @stepId
            AND status = 'running'
            AND child_session_id = @childSessionId
            AND (child_turn_id IS NULL OR child_turn_id = @childTurnId)
            AND dispatch_claim_token = @expectedDispatchToken
            AND dispatch_claim_expires_at IS NOT NULL
            AND julianday(dispatch_claim_expires_at) > julianday('now')
        `,
    );
    this.releaseOwnedWaitingDispatchStmt = db.prepare(
      db.dialect === "postgres"
        ? `
          UPDATE chat_delegation_steps
          SET dispatch_claim_token = NULL,
              dispatch_claim_expires_at = NULL
          WHERE step_id = @stepId
            AND status = 'running'
            AND child_session_id = @childSessionId
            AND child_turn_id = @childTurnId
            AND dispatch_claim_token = @expectedDispatchToken
            AND dispatch_claim_expires_at IS NOT NULL
            AND gc_try_parse_timestamptz(dispatch_claim_expires_at) > clock_timestamp()
        `
        : `
          UPDATE chat_delegation_steps
          SET dispatch_claim_token = NULL,
              dispatch_claim_expires_at = NULL
          WHERE step_id = @stepId
            AND status = 'running'
            AND child_session_id = @childSessionId
            AND child_turn_id = @childTurnId
            AND dispatch_claim_token = @expectedDispatchToken
            AND dispatch_claim_expires_at IS NOT NULL
            AND julianday(dispatch_claim_expires_at) > julianday('now')
        `,
    );
    this.finishUnclaimedPendingWithErrorStmt = db.prepare(`
      UPDATE chat_delegation_steps
      SET status = @status,
          label = @label,
          summary = @summary,
          error = @error,
          failure_guidance = @failureGuidance,
          finished_at = @finishedAt,
          duration_ms = @durationMs
      WHERE step_id = @stepId
        AND status = 'pending'
        AND dispatch_claim_token IS NULL
        AND dispatch_claim_expires_at IS NULL
        AND child_session_id IS NULL
        AND child_turn_id IS NULL
    `);
  }

  public get(stepId: string): ChatDelegationStepRecord {
    const row = toChatDelegationStepRow(this.getStmt.get(stepId));
    if (!row) {
      throw new NotFoundError({ entity: "Delegation step", id: stepId });
    }
    return mapRow(row);
  }

  /** Locks one delegation step for a transactionally fenced transition. */
  public getForUpdate(stepId: string): ChatDelegationStepRecord {
    const row = toChatDelegationStepRow(this.getForUpdateStmt.get(stepId));
    if (!row) {
      throw new NotFoundError({ entity: "Delegation step", id: stepId });
    }
    return mapRow(row);
  }

  public readDatabaseNow(): string {
    const row = this.databaseNowStmt.get<{ now_iso?: unknown }>();
    if (typeof row?.now_iso !== "string" || !Number.isFinite(Date.parse(row.now_iso))) {
      throw new Error("Database did not return a valid delegation dispatch clock.");
    }
    return row.now_iso;
  }

  public getDispatchClaim(stepId: string): ChatDelegationDispatchClaim | undefined {
    const row = this.getDispatchClaimStmt.get<{
      dispatch_claim_token?: unknown;
      dispatch_claim_expires_at?: unknown;
    }>(stepId);
    if (!row || (row.dispatch_claim_token === null && row.dispatch_claim_expires_at === null)) {
      return undefined;
    }
    if (
      typeof row.dispatch_claim_token !== "string" ||
      typeof row.dispatch_claim_expires_at !== "string" ||
      !Number.isFinite(Date.parse(row.dispatch_claim_expires_at))
    ) {
      throw new Error(`Delegation step ${stepId} has a malformed dispatch claim.`);
    }
    return { token: row.dispatch_claim_token, expiresAt: row.dispatch_claim_expires_at };
  }

  public create(input: {
    stepId: string;
    runId: string;
    role: string;
    label?: string;
    index: number;
    status?: ChatDelegationStepStatus;
    parallelizable?: boolean;
    dependsOnStepIds?: string[];
    providerId?: string;
    model?: string;
    summary?: string;
    output?: string;
    error?: string;
    failureGuidance?: string;
    durableRunId?: string;
    childSessionId?: string;
    childTurnId?: string;
    citations?: ChatCitationRecord[];
    degradedHandoffStepIds?: string[];
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
  }): ChatDelegationStepRecord {
    this.insertStmt.run({
      stepId: input.stepId,
      runId: input.runId,
      role: input.role,
      label: input.label ?? null,
      index: input.index,
      status: input.status ?? "pending",
      parallelizable: input.parallelizable ? 1 : 0,
      dependsOnStepIdsJson: JSON.stringify(input.dependsOnStepIds ?? []),
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      summary: input.summary ?? null,
      output: input.output ?? null,
      error: input.error ?? null,
      failureGuidance: input.failureGuidance ?? null,
      durableRunId: input.durableRunId ?? null,
      childSessionId: input.childSessionId ?? null,
      childTurnId: input.childTurnId ?? null,
      citationsJson: input.citations ? JSON.stringify(input.citations) : null,
      degradedHandoffStepIdsJson:
        input.degradedHandoffStepIds !== undefined ? JSON.stringify(input.degradedHandoffStepIds) : null,
      startedAt: input.startedAt ?? new Date().toISOString(),
      finishedAt: input.finishedAt ?? null,
      durationMs: input.durationMs ?? null,
    });
    return this.get(input.stepId);
  }

  public patch(
    stepId: string,
    input: {
      status?: ChatDelegationStepStatus;
      parallelizable?: boolean;
      dependsOnStepIds?: string[];
      providerId?: string;
      model?: string;
      label?: string;
      summary?: string;
      output?: string;
      error?: string;
      failureGuidance?: string;
      durableRunId?: string;
      childSessionId?: string | null;
      childTurnId?: string | null;
      citations?: ChatCitationRecord[];
      degradedHandoffStepIds?: string[];
      startedAt?: string;
      finishedAt?: string;
      durationMs?: number;
    },
  ): ChatDelegationStepRecord {
    return this.db.transaction("immediate", () => {
      const current = this.getForUpdate(stepId);
      this.patchStmt.run({
        stepId,
        status: input.status ?? current.status,
        parallelizable:
          input.parallelizable !== undefined ? (input.parallelizable ? 1 : 0) : current.parallelizable ? 1 : 0,
        dependsOnStepIdsJson: JSON.stringify(input.dependsOnStepIds ?? current.dependsOnStepIds ?? []),
        providerId: input.providerId !== undefined ? input.providerId : (current.providerId ?? null),
        model: input.model !== undefined ? input.model : (current.model ?? null),
        label: input.label !== undefined ? input.label : (current.label ?? null),
        summary: input.summary !== undefined ? input.summary : (current.summary ?? null),
        output: input.output !== undefined ? input.output : (current.output ?? null),
        error: input.error !== undefined ? input.error : (current.error ?? null),
        failureGuidance:
          input.failureGuidance !== undefined ? input.failureGuidance : (current.failureGuidance ?? null),
        durableRunId: input.durableRunId !== undefined ? input.durableRunId : (current.durableRunId ?? null),
        childSessionId: input.childSessionId !== undefined ? input.childSessionId : (current.childSessionId ?? null),
        childTurnId: input.childTurnId !== undefined ? input.childTurnId : (current.childTurnId ?? null),
        citationsJson:
          input.citations !== undefined
            ? JSON.stringify(input.citations)
            : current.citations
              ? JSON.stringify(current.citations)
              : null,
        degradedHandoffStepIdsJson:
          input.degradedHandoffStepIds !== undefined
            ? JSON.stringify(input.degradedHandoffStepIds)
            : current.degradedHandoffStepIds !== undefined
              ? JSON.stringify(current.degradedHandoffStepIds)
              : null,
        startedAt: input.startedAt ?? current.startedAt,
        finishedAt: input.finishedAt !== undefined ? input.finishedAt : (current.finishedAt ?? null),
        durationMs: input.durationMs !== undefined ? input.durationMs : (current.durationMs ?? null),
      });
      return this.get(stepId);
    });
  }

  /**
   * Materializes a child approval result only while the exact linked waiting
   * generation is still active and no replacement dispatcher owns it.
   */
  public materializeApprovalOutcome(input: {
    stepId: string;
    expectedChildSessionId: string;
    expectedChildTurnId: string;
    status: "completed" | "failed";
    output?: string;
    summary: string;
    error?: string;
    failureGuidance?: string;
    durableRunId?: string;
    citations: ChatCitationRecord[];
    finishedAt: string;
    durationMs?: number;
  }): ChatDelegationApprovalMaterializationResult {
    return this.db.transaction("immediate", () => {
      const current = this.getForUpdate(input.stepId);
      const ownsExpectedChild =
        current.childSessionId === input.expectedChildSessionId && current.childTurnId === input.expectedChildTurnId;
      if (!ownsExpectedChild) {
        return { outcome: "rejected", step: current };
      }
      if (current.status === input.status) {
        return { outcome: "converged", step: current };
      }
      if (current.status !== "running" || this.getDispatchClaim(input.stepId)) {
        return { outcome: "rejected", step: current };
      }

      const startedMs = Date.parse(current.startedAt);
      const finishedMs = Date.parse(input.finishedAt);
      const durationMs =
        input.durationMs ??
        (Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : undefined);

      const result = this.materializeApprovalOutcomeStmt.run({
        stepId: input.stepId,
        expectedChildSessionId: input.expectedChildSessionId,
        expectedChildTurnId: input.expectedChildTurnId,
        status: input.status,
        summary: input.summary,
        output: input.output ?? null,
        error: input.error ?? null,
        failureGuidance: input.failureGuidance ?? null,
        durableRunId: input.durableRunId ?? null,
        citationsJson: JSON.stringify(input.citations),
        finishedAt: input.finishedAt,
        durationMs: durationMs === undefined ? null : Math.max(0, Math.floor(durationMs)),
      });
      const step = this.getForUpdate(input.stepId);
      if (Number(result.changes ?? 0) > 0) {
        return { outcome: "applied", step };
      }
      return {
        outcome:
          step.status === input.status &&
          step.childSessionId === input.expectedChildSessionId &&
          step.childTurnId === input.expectedChildTurnId
            ? "converged"
            : "rejected",
        step,
      };
    });
  }

  public listByRun(runId: string): ChatDelegationStepRecord[] {
    const rows = toChatDelegationStepRows(this.listByRunStmt.all({ runId }));
    return rows.map(mapRow);
  }

  /** Locks all steps for an aggregate transition. Call inside a storage transaction. */
  public listByRunForUpdate(runId: string): ChatDelegationStepRecord[] {
    const rows = toChatDelegationStepRows(this.listByRunForUpdateStmt.all({ runId }));
    return rows.map(mapRow);
  }

  public claimPendingForDispatch(
    stepId: string,
    claimToken: string,
    claimExpiresAt: string,
    startedAt: string,
  ): ChatDelegationStepRecord | undefined {
    const result = this.claimPendingDispatchStmt.run({ stepId, claimToken, claimExpiresAt, startedAt });
    return Number(result.changes ?? 0) > 0 ? this.get(stepId) : undefined;
  }

  public reclaimRunningForDispatch(
    stepId: string,
    expectedClaimToken: string | undefined,
    claimToken: string,
    claimExpiresAt: string,
    startedAt: string,
  ): ChatDelegationStepRecord | undefined {
    const result = expectedClaimToken
      ? this.reclaimDispatchMarkerStmt.run({ stepId, expectedClaimToken, claimToken, claimExpiresAt, startedAt })
      : this.claimUnlinkedRunningDispatchStmt.run({ stepId, claimToken, claimExpiresAt, startedAt });
    return Number(result.changes ?? 0) > 0 ? this.get(stepId) : undefined;
  }

  public linkClaimedDispatch(
    stepId: string,
    claimToken: string,
    childSessionId: string,
    dispatchToken: string,
    dispatchExpiresAt: string,
  ): ChatDelegationStepRecord | undefined {
    const result = this.linkClaimedDispatchStmt.run({
      stepId,
      claimToken,
      childSessionId,
      dispatchToken,
      dispatchExpiresAt,
    });
    return Number(result.changes ?? 0) > 0 ? this.get(stepId) : undefined;
  }

  public reclaimLinkedDispatch(
    stepId: string,
    childSessionId: string,
    expectedDispatchToken: string,
    dispatchToken: string,
    dispatchExpiresAt: string,
    startedAt: string,
  ): ChatDelegationStepRecord | undefined {
    const result = this.reclaimLinkedDispatchStmt.run({
      stepId,
      childSessionId,
      expectedDispatchToken,
      dispatchToken,
      dispatchExpiresAt,
      startedAt,
    });
    return Number(result.changes ?? 0) > 0 ? this.get(stepId) : undefined;
  }

  public claimLinkedForDispatch(
    stepId: string,
    childSessionId: string,
    expectedChildTurnId: string | undefined,
    dispatchToken: string,
    dispatchExpiresAt: string,
    startedAt: string,
  ): ChatDelegationStepRecord | undefined {
    const result = expectedChildTurnId
      ? this.claimFinalizedLinkedDispatchStmt.run({
          stepId,
          childSessionId,
          expectedChildTurnId,
          dispatchToken,
          dispatchExpiresAt,
          startedAt,
        })
      : this.claimLinkedDispatchStmt.run({ stepId, childSessionId, dispatchToken, dispatchExpiresAt, startedAt });
    return Number(result.changes ?? 0) > 0 ? this.get(stepId) : undefined;
  }

  public finalizeLinkedDispatch(
    stepId: string,
    childSessionId: string,
    expectedDispatchToken: string,
    childTurnId: string,
  ): ChatDelegationStepRecord | undefined {
    const result = this.finalizeLinkedDispatchStmt.run({
      stepId,
      childSessionId,
      expectedDispatchToken,
      childTurnId,
    });
    return Number(result.changes ?? 0) > 0 ? this.get(stepId) : undefined;
  }

  public ownsLinkedDispatch(stepId: string, childSessionId: string, dispatchToken: string): boolean {
    return Boolean(this.ownsLinkedDispatchStmt.get({ stepId, childSessionId, dispatchToken }));
  }

  /**
   * Atomically records an owned dispatch failure/cancellation only while the
   * exact dispatch token still has a live lease according to the database.
   */
  public finishOwnedDispatchWithError(input: {
    stepId: string;
    expectedDispatchToken: string;
    expectedChildSessionId?: string;
    status: "failed" | "cancelled";
    label?: string;
    summary?: string;
    error: string;
    failureGuidance?: string;
    finishedAt: string;
    durationMs: number;
  }): ChatDelegationStepRecord | undefined {
    const result = this.finishOwnedDispatchWithErrorStmt.run({
      stepId: input.stepId,
      expectedDispatchToken: input.expectedDispatchToken,
      expectedChildSessionId: input.expectedChildSessionId ?? null,
      status: input.status,
      label: input.label ?? null,
      summary: input.summary ?? null,
      error: input.error,
      failureGuidance: input.failureGuidance ?? null,
      finishedAt: input.finishedAt,
      durationMs: Math.max(0, Math.floor(input.durationMs)),
    });
    return Number(result.changes ?? 0) > 0 ? this.get(input.stepId) : undefined;
  }

  /** Atomically commits a child response, retaining the dispatch fence while it remains active. */
  public finishOwnedDispatchWithResponse(input: {
    stepId: string;
    expectedDispatchToken: string;
    childSessionId: string;
    childTurnId: string;
    status: "running" | "completed" | "failed" | "cancelled";
    providerId?: string;
    model?: string;
    label?: string;
    summary?: string;
    output: string;
    error?: string;
    failureGuidance?: string;
    durableRunId?: string;
    citations: ChatCitationRecord[];
    finishedAt?: string;
    durationMs?: number;
  }): ChatDelegationStepRecord | undefined {
    const result = this.finishOwnedDispatchWithResponseStmt.run({
      stepId: input.stepId,
      expectedDispatchToken: input.expectedDispatchToken,
      childSessionId: input.childSessionId,
      childTurnId: input.childTurnId,
      status: input.status,
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      label: input.label ?? null,
      summary: input.summary ?? null,
      output: input.output,
      error: input.error ?? null,
      failureGuidance: input.failureGuidance ?? null,
      durableRunId: input.durableRunId ?? null,
      citationsJson: JSON.stringify(input.citations),
      finishedAt: input.finishedAt ?? null,
      durationMs: input.durationMs === undefined ? null : Math.max(0, Math.floor(input.durationMs)),
    });
    return Number(result.changes ?? 0) > 0 ? this.get(input.stepId) : undefined;
  }

  /** Releases a waiting response only for the exact database-fresh dispatch generation. */
  public releaseOwnedWaitingDispatch(input: {
    stepId: string;
    expectedDispatchToken: string;
    childSessionId: string;
    childTurnId: string;
  }): ChatDelegationStepRecord | undefined {
    const result = this.releaseOwnedWaitingDispatchStmt.run(input);
    return Number(result.changes ?? 0) > 0 ? this.get(input.stepId) : undefined;
  }

  /** Atomically records a pre-dispatch error only while no worker owns the step. */
  public finishUnclaimedPendingWithError(input: {
    stepId: string;
    status: "failed" | "cancelled" | "skipped";
    label?: string;
    summary?: string;
    error: string;
    failureGuidance?: string;
    finishedAt: string;
    durationMs: number;
  }): ChatDelegationStepRecord | undefined {
    const result = this.finishUnclaimedPendingWithErrorStmt.run({
      stepId: input.stepId,
      status: input.status,
      label: input.label ?? null,
      summary: input.summary ?? null,
      error: input.error,
      failureGuidance: input.failureGuidance ?? null,
      finishedAt: input.finishedAt,
      durationMs: Math.max(0, Math.floor(input.durationMs)),
    });
    return Number(result.changes ?? 0) > 0 ? this.get(input.stepId) : undefined;
  }

  public listParentsByChildSessionIds(
    sessionIds: string[],
    workspaceId?: string,
  ): Map<string, ChatSessionDelegationParentRecord> {
    const childSessionIds = [...new Set(sessionIds.map((item) => item.trim()).filter(Boolean))];
    if (childSessionIds.length === 0) {
      return new Map();
    }
    const placeholders = childSessionIds.map(() => "?").join(", ");
    const workspace = workspaceId?.trim();
    const rows = toChatDelegationParentRows(
      this.db
        .prepare(
          workspace
            ? `
            SELECT steps.*, runs.session_id AS parent_session_id
            FROM chat_delegation_steps steps
            INNER JOIN chat_delegation_runs runs ON runs.run_id = steps.run_id
            INNER JOIN chat_session_meta child_meta
              ON child_meta.session_id = steps.child_session_id
             AND child_meta.workspace_id = ?
            INNER JOIN chat_session_meta parent_meta
              ON parent_meta.session_id = runs.session_id
             AND parent_meta.workspace_id = child_meta.workspace_id
            WHERE steps.child_session_id IN (${placeholders})
            ORDER BY steps.started_at DESC, steps.step_index DESC, steps.step_id DESC
          `
            : `
            SELECT steps.*, runs.session_id AS parent_session_id
            FROM chat_delegation_steps steps
            INNER JOIN chat_delegation_runs runs ON runs.run_id = steps.run_id
            WHERE steps.child_session_id IN (${placeholders})
            ORDER BY steps.started_at DESC, steps.step_index DESC, steps.step_id DESC
          `,
        )
        .all(...(workspace ? [workspace, ...childSessionIds] : childSessionIds)),
    );
    const byChildSessionId = new Map<string, ChatSessionDelegationParentRecord>();
    for (const row of rows) {
      const childSessionId = row.child_session_id;
      if (!childSessionId || byChildSessionId.has(childSessionId)) {
        continue;
      }
      byChildSessionId.set(childSessionId, {
        parentSessionId: row.parent_session_id,
        runId: row.run_id,
        stepId: row.step_id,
        role: row.role,
        label: row.label ?? undefined,
        index: row.step_index,
      });
    }
    return byChildSessionId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatDelegationStepRow(value: unknown): value is ChatDelegationStepRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.step_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.role === "string" &&
    (typeof value.label === "string" || value.label === null) &&
    typeof value.step_index === "number" &&
    typeof value.status === "string" &&
    (typeof value.parallelizable === "number" || typeof value.parallelizable === "boolean") &&
    typeof value.depends_on_step_ids_json === "string" &&
    (typeof value.provider_id === "string" || value.provider_id === null) &&
    (typeof value.model === "string" || value.model === null) &&
    (typeof value.summary === "string" || value.summary === null) &&
    (typeof value.output === "string" || value.output === null) &&
    (typeof value.error === "string" || value.error === null) &&
    (typeof value.failure_guidance === "string" || value.failure_guidance === null) &&
    (typeof value.durable_run_id === "string" || value.durable_run_id === null) &&
    (typeof value.child_session_id === "string" || value.child_session_id === null) &&
    (typeof value.child_turn_id === "string" || value.child_turn_id === null) &&
    (typeof value.citations_json === "string" || value.citations_json === null) &&
    (typeof value.degraded_handoff_step_ids_json === "string" ||
      value.degraded_handoff_step_ids_json === null ||
      value.degraded_handoff_step_ids_json === undefined) &&
    typeof value.started_at === "string" &&
    (typeof value.finished_at === "string" || value.finished_at === null) &&
    (typeof value.duration_ms === "number" || value.duration_ms === null)
  );
}

function toChatDelegationStepRow(value: unknown): ChatDelegationStepRow | undefined {
  return isChatDelegationStepRow(value) ? value : undefined;
}

function toChatDelegationStepRows(value: unknown): ChatDelegationStepRow[] {
  return Array.isArray(value) ? value.filter(isChatDelegationStepRow) : [];
}

function isChatDelegationParentRow(value: unknown): value is ChatDelegationParentRow {
  if (!isChatDelegationStepRow(value) || !isRecord(value)) {
    return false;
  }
  return typeof value.parent_session_id === "string";
}

function toChatDelegationParentRows(value: unknown): ChatDelegationParentRow[] {
  return Array.isArray(value) ? value.filter(isChatDelegationParentRow) : [];
}

function mapRow(row: ChatDelegationStepRow): ChatDelegationStepRecord {
  return {
    stepId: row.step_id,
    runId: row.run_id,
    role: row.role,
    label: row.label ?? undefined,
    status: row.status,
    index: row.step_index,
    parallelizable: row.parallelizable === true || row.parallelizable === 1,
    dependsOnStepIds: parseStringArray(row.depends_on_step_ids_json) ?? [],
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    summary: row.summary ?? undefined,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    failureGuidance: row.failure_guidance ?? undefined,
    durableRunId: row.durable_run_id ?? undefined,
    childSessionId: row.child_session_id ?? undefined,
    childTurnId: row.child_turn_id ?? undefined,
    citations: parseCitations(row.citations_json),
    degradedHandoffStepIds: parseStringArray(row.degraded_handoff_step_ids_json),
  };
}

function parseCitations(raw: string | null): ChatCitationRecord[] | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = safeJsonParse<unknown>(raw, []);
  return Array.isArray(parsed) ? (parsed as ChatCitationRecord[]) : [];
}

function parseStringArray(raw: string | null | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = safeJsonParse<unknown>(raw, []);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === "string");
}
