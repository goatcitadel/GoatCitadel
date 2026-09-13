import { randomUUID } from "node:crypto";
import {
  REMOTE_WORKER_BUDGET_MAX_ATTEMPTS,
  REMOTE_WORKER_BUDGET_OWNER_ID,
  REMOTE_WORKER_INFERENCE_BUDGET_SCHEMA_VERSION,
  canonicalJsonString,
  isModelUsageProvenNotDispatched,
  normalizeRemoteWorkerBudgetGrant,
  normalizeRemoteWorkerBudgetOperatorId,
  normalizeRemoteWorkerInferenceBudgetReservation,
  normalizeRemoteWorkerInferenceEffectiveRouteReceipt,
  remoteWorkerBudgetGrantIdentity,
  remoteWorkerInferenceBudgetOperationSha256,
  remoteWorkerInferenceCanonicalSha256,
  remoteWorkerInferenceEffectiveRouteSha256,
  remoteWorkerInferenceUsageEventIdsSha256,
  type ModelUsageEventRecord,
  type RemoteWorkerBudgetBalance,
  type RemoteWorkerBudgetGrant,
  type RemoteWorkerBudgetGrantInput,
  type RemoteWorkerInferenceBudgetOperationInput,
  type RemoteWorkerInferenceBudgetReservation,
  type RemoteWorkerInferenceEffectiveRouteReceipt,
  type RemoteWorkerInferenceReleaseReason,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ModelUsageEventRepository } from "./model-usage-event-repo.js";
import {
  RemoteWorkerToolBudgetOwner,
  assertWorkerBudgetUsagePricing,
  type AuthorizeRemoteWorkerToolAttempt,
  type RemoteWorkerToolBudgetKey,
} from "./remote-worker-tool-budget-owner.js";
export { remoteWorkerToolBudgetOperationId } from "./remote-worker-tool-budget-owner.js";
export type { AuthorizeRemoteWorkerToolAttempt, RemoteWorkerToolBudgetKey } from "./remote-worker-tool-budget-owner.js";
import {
  RemoteWorkerInferenceRepository,
  type RemoteWorkerInferenceRequestRecord,
} from "./remote-worker-inference-repo.js";

interface GrantRow {
  grant_id: string;
  identity_json: string;
  created_at: string;
  revoked_at: string | null;
  revision: number;
}
interface ReservationRow {
  reservation_id: string;
  grant_id: string;
  operation_id: string;
  dispatch_generation: string;
  operation_sha256: string;
  receipt_json: string;
  reserved_requests: number;
  reserved_cost_microusd: number;
  status: "held" | "settled" | "released";
  usage_event_ids_sha256: string | null;
}
interface DispatchRow {
  usage_event_id: string;
  parent_reservation_id: string;
  grant_id: string;
  route_sha256: string;
  route_json: string;
  status: "held" | "settled" | "released";
}

export class RemoteWorkerBudgetConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerBudgetConflictError";
  }
}

/** Serializes each grant across all workers, requests, retries and Gateway processes. */
export class RemoteWorkerBudgetRepository {
  private readonly inference: RemoteWorkerInferenceRepository;
  private readonly usage: ModelUsageEventRepository;
  private readonly toolBudgets: RemoteWorkerToolBudgetOwner;

  public constructor(private readonly db: DatabaseClient) {
    this.inference = new RemoteWorkerInferenceRepository(db);
    this.usage = new ModelUsageEventRepository(db);
    this.toolBudgets = new RemoteWorkerToolBudgetOwner(db, {
      lock: (grantId) => this.requireGrant(grantId, true),
      balance: (grant) => this.balance(grant),
      price: (route, outputTokenCeiling) => reservationCost(route, { outputTokenCeiling, reasoningTokenCeiling: 0 }, 1),
    });
  }

  public authorizeToolAttempt(input: AuthorizeRemoteWorkerToolAttempt): void {
    this.toolBudgets.authorize(input);
  }

  public reconcileToolAttempts(key: RemoteWorkerToolBudgetKey): void {
    this.toolBudgets.reconcile(key);
  }

  public listToolAttempts(key: RemoteWorkerToolBudgetKey): ModelUsageEventRecord[] {
    return this.toolBudgets.list(key);
  }

  /** Only an authenticated operator API may call this; worker/proposal paths have no grant creation port. */
  public createGrant(input: RemoteWorkerBudgetGrantInput, operatorId: string): RemoteWorkerBudgetGrant {
    const grant = normalizeRemoteWorkerBudgetGrant(input);
    const identity = remoteWorkerBudgetGrantIdentity(grant, operatorId);
    return this.db.transaction("immediate", () => {
      const existing = this.getGrant(grant.grantId);
      if (existing) return this.assertGrantReplay(existing, identity);
      const now = this.now();
      if (grant.expiresAt <= now || Date.parse(grant.expiresAt) - Date.parse(now) > 86_400_000) {
        throw new RemoteWorkerBudgetConflictError("Worker budget grants must expire within 24 hours.");
      }
      this.db
        .prepare(
          `INSERT INTO remote_worker_budget_grants
        (grant_id, registry_workspace_id, execution_workspace_id, worker_id, worker_generation, operator_id,
         identity_json, max_requests, max_cost_microusd, expires_at, created_at)
        VALUES (@grantId, @registryWorkspaceId, @executionWorkspaceId, @workerId, @workerGeneration, @operatorId,
                @identity, @maxRequests, @maxCostMicrousd, @expiresAt, @now)
        ON CONFLICT(grant_id) DO NOTHING`,
        )
        .run({ ...grant, operatorId, identity, now });
      return this.assertGrantReplay(this.requireGrant(grant.grantId, true), identity);
    });
  }

  public getGrant(grantId: string): RemoteWorkerBudgetGrant | undefined {
    const row = this.db.prepare("SELECT * FROM remote_worker_budget_grants WHERE grant_id = ?").get<GrantRow>(grantId);
    return row ? mapGrant(row) : undefined;
  }

  public listGrants(registryWorkspaceId: string, executionWorkspaceId: string): RemoteWorkerBudgetBalance[] {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_budget_grants WHERE registry_workspace_id = ?
      AND execution_workspace_id = ? ORDER BY created_at DESC, grant_id LIMIT 100`,
      )
      .all<GrantRow>(registryWorkspaceId, executionWorkspaceId)
      .map((row) => this.balance(mapGrant(row)));
  }

  /** Internal placement lookup: registry selection follows this operator's
   * explicit grants for the execution workspace, never caller-supplied routing. */
  public listExecutionGrants(executionWorkspaceId: string, operatorId: string): RemoteWorkerBudgetBalance[] {
    return this.db.prepare(`SELECT * FROM remote_worker_budget_grants
      WHERE execution_workspace_id = ? AND operator_id = ? AND revoked_at IS NULL
        AND expires_at > ? ORDER BY expires_at, grant_id LIMIT 100`)
      .all<GrantRow>(executionWorkspaceId, operatorId, this.now())
      .map((row) => this.balance(mapGrant(row)));
  }

  public revokeGrant(grantId: string, expectedRevision: number): RemoteWorkerBudgetGrant {
    return this.db.transaction("immediate", () => {
      const grant = this.requireGrant(grantId, true);
      if (grant.revokedAt && expectedRevision === grant.revision - 1) return grant;
      if (grant.revision !== expectedRevision || grant.revokedAt)
        throw new RemoteWorkerBudgetConflictError("Worker budget revision changed.");
      this.db
        .prepare(
          "UPDATE remote_worker_budget_grants SET revoked_at = ?, revision = revision + 1 WHERE grant_id = ? AND revision = ?",
        )
        .run(this.now(), grantId, expectedRevision);
      return this.requireGrant(grantId);
    });
  }

  public reserve(input: {
    grantId: string;
    operation: RemoteWorkerInferenceBudgetOperationInput;
    operationSha256: string;
  }): RemoteWorkerInferenceBudgetReservation | undefined {
    const { operation } = input;
    if (remoteWorkerInferenceBudgetOperationSha256(operation) !== input.operationSha256)
      throw new Error("Worker budget operation digest mismatch.");
    return this.db.transaction("immediate", () => {
      const request = this.requireOperation(operation.operationId, operation.dispatchGeneration);
      if (
        request.budgetOperationSha256 !== input.operationSha256 ||
        !request.budgetOperationJson ||
        remoteWorkerInferenceCanonicalSha256(JSON.parse(request.budgetOperationJson)) !== input.operationSha256
      ) {
        throw new Error("Worker budget operation differs from admitted authority.");
      }
      const grant = this.requireGrant(input.grantId, true);
      this.assertScope(grant, request);
      const prior = this.db
        .prepare("SELECT * FROM remote_worker_budget_reservations WHERE operation_id = ? AND dispatch_generation = ?")
        .get<ReservationRow>(operation.operationId, operation.dispatchGeneration);
      if (prior) {
        if (prior.grant_id !== grant.grantId || prior.operation_sha256 !== input.operationSha256)
          throw new Error("Worker budget reservation replay changed.");
        return normalizeRemoteWorkerInferenceBudgetReservation(JSON.parse(prior.receipt_json));
      }
      const now = this.now(); // Sample after acquiring the grant lock, not at transaction start.
      const governanceExpiry = request.continuationGovernanceExpiresAt ?? request.governanceExpiresAt;
      if (grant.revokedAt || grant.expiresAt <= now || governanceExpiry <= now) return undefined;
      if (request.state !== "admitted" || request.budgetAuthorityState !== "reservation_pending")
        throw new Error("Worker inference is not awaiting budget authority.");
      const route = this.route(request);
      const cost = reservationCost(route, operation);
      const balance = this.balance(grant);
      if (balance.availableRequests < REMOTE_WORKER_BUDGET_MAX_ATTEMPTS || balance.availableCostMicrousd < cost)
        return undefined;
      const receipt = normalizeRemoteWorkerInferenceBudgetReservation({
        schemaVersion: REMOTE_WORKER_INFERENCE_BUDGET_SCHEMA_VERSION,
        budgetOwnerId: REMOTE_WORKER_BUDGET_OWNER_ID,
        reservationId: randomUUID(),
        operationId: operation.operationId,
        operationSha256: input.operationSha256,
        requestSha256: operation.requestSha256,
        effectiveRouteSha256: operation.effectiveRouteSha256,
        reservedOutputTokens: operation.outputTokenCeiling,
        reservedReasoningTokens: operation.reasoningTokenCeiling,
        reservedCostMicrousd: cost,
        expiresAt: grant.expiresAt < governanceExpiry ? grant.expiresAt : governanceExpiry,
      });
      this.db
        .prepare(
          `INSERT INTO remote_worker_budget_reservations
        (reservation_id, grant_id, operation_id, dispatch_generation, operation_sha256, receipt_json,
         reserved_requests, reserved_cost_microusd, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receipt.reservationId,
          grant.grantId,
          operation.operationId,
          operation.dispatchGeneration,
          input.operationSha256,
          canonicalJsonString(receipt),
          REMOTE_WORKER_BUDGET_MAX_ATTEMPTS,
          cost,
          now,
        );
      return receipt;
    });
  }

  /**
   * Consume matching operator grants in expiry/id order. The immutable first
   * reservation binds its grant permanently, including across restart/revocation.
   * Neither a worker nor model chooses a grant or widens its worker/workspace scope.
   */
  public reserveForWorker(input: {
    operation: RemoteWorkerInferenceBudgetOperationInput;
    operationSha256: string;
  }): RemoteWorkerInferenceBudgetReservation | undefined {
    return this.db.transaction("immediate", () => {
      const request = this.requireOperation(input.operation.operationId, input.operation.dispatchGeneration);
      const prior = this.db
        .prepare(
          "SELECT grant_id FROM remote_worker_budget_reservations WHERE operation_id = ? AND dispatch_generation = ?",
        )
        .get<{ grant_id: string }>(request.operationId, request.dispatchGeneration);
      if (prior) return this.reserve({ ...input, grantId: prior.grant_id });
      const grants = this.db
        .prepare(
          `SELECT grant_id FROM remote_worker_budget_grants
        WHERE registry_workspace_id = ? AND execution_workspace_id = ? AND worker_id = ?
          AND worker_generation = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY expires_at, grant_id LIMIT 100`,
        )
        .all<{ grant_id: string }>(
          request.registryWorkspaceId,
          request.executionWorkspaceId,
          request.workerId,
          request.workerGeneration,
          this.now(),
        );
      for (const grant of grants) {
        const reservation = this.reserve({ ...input, grantId: grant.grant_id });
        if (reservation) return reservation;
      }
      return undefined;
    });
  }

  /** Revocation forbids subsequent transport attempts; it never releases prior uncertain dispatches. */
  public assertDispatchAllowed(reservation: RemoteWorkerInferenceBudgetReservation): void {
    this.db.transaction("immediate", () => {
      const { row } = this.boundReservation(reservation);
      const grant = this.requireGrant(row.grant_id, true);
      if (row.status !== "held" || grant.revokedAt || reservation.expiresAt <= this.now())
        throw new Error("Worker budget dispatch authority expired or was revoked.");
    });
  }

  public getReservationForOperation(
    operationId: string,
    dispatchGeneration: string,
  ): RemoteWorkerInferenceBudgetReservation | undefined {
    const row = this.db
      .prepare(
        "SELECT receipt_json FROM remote_worker_budget_reservations WHERE operation_id = ? AND dispatch_generation = ?",
      )
      .get<{ receipt_json: string }>(operationId, dispatchGeneration);
    return row ? normalizeRemoteWorkerInferenceBudgetReservation(JSON.parse(row.receipt_json)) : undefined;
  }

  /** Called by LlmService after HX-306 creates its intent, immediately before each HTTP attempt. */
  public authorizeAttempt(reservation: RemoteWorkerInferenceBudgetReservation, usageEventId: string): void {
    this.db.transaction("immediate", () => {
      const { row, request } = this.boundReservation(reservation);
      const grant = this.requireGrant(row.grant_id, true);
      if (
        row.status !== "held" ||
        grant.revokedAt ||
        reservation.expiresAt <= this.now() ||
        request.budgetReservationId !== row.reservation_id ||
        request.budgetAuthorityState !== "reserved" ||
        !["dispatch_claimed", "streaming"].includes(request.state)
      )
        throw new Error("Worker budget dispatch authority is not current.");
      const attempts = this.usage.listOperationAttemptsForUpdate(row.operation_id, row.dispatch_generation);
      const current = attempts.find((attempt) => attempt.eventId === usageEventId);
      if (
        !current ||
        current.transportStatus !== "intent" ||
        current.terminalOutcome !== "in_flight" ||
        attempts.length > REMOTE_WORKER_BUDGET_MAX_ATTEMPTS ||
        current.transportAttemptIndex !== attempts.length - 1 ||
        current.effectiveOutputTokenCap === undefined ||
        current.effectiveOutputTokenCap > reservation.reservedOutputTokens
      ) {
        throw new Error("Worker budget does not authorize this transport attempt.");
      }
      for (const attempt of attempts) assertUsageScope(attempt, request, this.route(request));
    });
  }

  /** Auxiliary calls retain their own HX-306 operation/generation identities.
   * Each actual transport intent consumes one more request from the SAME grant;
   * the parent reservation still covers its original completion and recovery. */
  public authorizeRelatedAttempt(input: {
    reservation: RemoteWorkerInferenceBudgetReservation;
    usageEventId: string;
    route: RemoteWorkerInferenceEffectiveRouteReceipt;
  }): void {
    const route = normalizeRemoteWorkerInferenceEffectiveRouteReceipt(input.route);
    const routeJson = canonicalJsonString(route);
    this.db.transaction("immediate", () => {
      const { row, request } = this.boundReservation(input.reservation);
      const grant = this.requireGrant(row.grant_id, true);
      const now = this.now();
      if (
        row.status !== "held" ||
        grant.revokedAt ||
        input.reservation.expiresAt <= now ||
        request.budgetReservationId !== row.reservation_id ||
        request.budgetAuthorityState !== "reserved" ||
        !["dispatch_claimed", "streaming"].includes(request.state)
      )
        throw new Error("Worker budget dispatch authority is not current.");
      const usage = this.usage.findByEventIdForUpdate(input.usageEventId);
      if (
        !usage ||
        usage.source !== "llm_service" ||
        usage.transportStatus !== "intent" ||
        usage.terminalOutcome !== "in_flight" ||
        usage.finishedAt ||
        !Number.isSafeInteger(usage.effectiveOutputTokenCap) ||
        (usage.effectiveOutputTokenCap ?? 0) <= 0
      )
        throw new Error("Worker budget requires a current canonical related dispatch intent.");
      assertUsageScope(usage, request, route, true);
      const prior = this.db
        .prepare("SELECT * FROM remote_worker_budget_dispatches WHERE usage_event_id = ?")
        .get<DispatchRow>(input.usageEventId);
      if (prior) {
        if (
          prior.parent_reservation_id !== row.reservation_id ||
          prior.grant_id !== row.grant_id ||
          prior.route_json !== routeJson ||
          prior.status !== "held"
        )
          throw new Error("Worker related dispatch reservation replay changed.");
        return;
      }
      const cost = reservationCost(
        route,
        { outputTokenCeiling: usage.effectiveOutputTokenCap!, reasoningTokenCeiling: 0 },
        1,
      );
      const balance = this.balance(grant);
      if (balance.availableRequests < 1 || balance.availableCostMicrousd < cost)
        throw new Error("Worker budget has insufficient capacity for this related dispatch.");
      this.db
        .prepare(
          `INSERT INTO remote_worker_budget_dispatches
        (usage_event_id, parent_reservation_id, grant_id, route_sha256, route_json, reserved_cost_microusd, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.usageEventId,
          row.reservation_id,
          row.grant_id,
          remoteWorkerInferenceEffectiveRouteSha256(route),
          routeJson,
          cost,
          now,
        );
    });
  }

  /** May run after cancellation, revocation, or restart. Canonical usage alone
   * determines settlement; missing/unpriced/ambiguous results keep their hold. */
  public reconcileRelatedAttempts(reservation: RemoteWorkerInferenceBudgetReservation): void {
    this.db.transaction("immediate", () => {
      const { row, request } = this.boundReservation(reservation);
      this.requireGrant(row.grant_id, true);
      const dispatches = this.db
        .prepare(
          `SELECT * FROM remote_worker_budget_dispatches
        WHERE parent_reservation_id = ? AND status = 'held' ORDER BY usage_event_id`,
        )
        .all<DispatchRow>(row.reservation_id);
      for (const dispatch of dispatches) {
        const usage = this.usage.findByEventIdForUpdate(dispatch.usage_event_id);
        if (!usage) throw new Error("Worker related dispatch usage is unavailable.");
        const route = normalizeRemoteWorkerInferenceEffectiveRouteReceipt(JSON.parse(dispatch.route_json));
        if (remoteWorkerInferenceEffectiveRouteSha256(route) !== dispatch.route_sha256)
          throw new Error("Worker related dispatch route digest mismatch.");
        assertUsageScope(usage, request, route, true);
        const released = isModelUsageProvenNotDispatched(usage);
        if (
          !released &&
          (usage.transportStatus !== "accepted" ||
            usage.terminalOutcome === "in_flight" ||
            !usage.finishedAt ||
            usage.costUsd === undefined ||
            !Number.isFinite(usage.costUsd) ||
            usage.costUsd < 0)
        )
          continue;
        const cost = released ? 0 : Math.ceil(usage.costUsd! * 1_000_000);
        if (!Number.isSafeInteger(cost)) throw new Error("Worker related dispatch cost is out of range.");
        this.db
          .prepare(
            `UPDATE remote_worker_budget_dispatches SET status = ?, settled_cost_microusd = ?, closed_at = ?
          WHERE usage_event_id = ? AND status = 'held'`,
          )
          .run(released ? "released" : "settled", cost, this.now(), dispatch.usage_event_id);
      }
    });
  }

  public listRelatedAttempts(reservation: RemoteWorkerInferenceBudgetReservation): ModelUsageEventRecord[] {
    return this.db.transaction("immediate", () => {
      const { row } = this.boundReservation(reservation);
      return this.db
        .prepare(
          `SELECT usage_event_id FROM remote_worker_budget_dispatches
        WHERE parent_reservation_id = ? ORDER BY created_at, usage_event_id`,
        )
        .all<{ usage_event_id: string }>(row.reservation_id)
        .map(({ usage_event_id }) => {
          const usage = this.usage.findByEventId(usage_event_id);
          if (!usage) throw new Error("Worker related dispatch usage is unavailable.");
          return usage;
        });
    });
  }

  /** Only canonical, complete, priced usage can reduce a hold. Unknown usage retains it. */
  public settle(input: {
    reservation: RemoteWorkerInferenceBudgetReservation;
    usageEventIds: readonly string[];
  }): void {
    const hash = remoteWorkerInferenceUsageEventIdsSha256(input.usageEventIds);
    this.db.transaction("immediate", () => {
      const { row, request } = this.boundReservation(input.reservation);
      this.requireGrant(row.grant_id, true);
      if (row.status === "settled" && row.usage_event_ids_sha256 === hash) return;
      if (
        !["held", "released"].includes(row.status) ||
        request.budgetReservationId !== row.reservation_id ||
        !["completed", "failed", "cancelled"].includes(request.state) ||
        request.usageEventIdsSha256 !== hash ||
        request.usageEventIdsJson !== canonicalJsonString(input.usageEventIds)
      )
        throw new Error("Worker budget settlement evidence mismatch.");
      const attempts = this.usage.listOperationAttemptsForUpdate(row.operation_id, row.dispatch_generation);
      if (
        attempts.length === 0 ||
        attempts.length !== input.usageEventIds.length ||
        attempts.length > REMOTE_WORKER_BUDGET_MAX_ATTEMPTS ||
        attempts.some((attempt, index) => attempt.eventId !== input.usageEventIds[index])
      )
        throw new Error("Worker budget attempt inventory is incomplete.");
      const route = this.route(request);
      let cost = 0;
      let dispatchedRequests = 0;
      for (const attempt of attempts) {
        assertUsageScope(attempt, request, route);
        if (isModelUsageProvenNotDispatched(attempt)) continue;
        if (
          attempt.transportStatus !== "accepted" ||
          attempt.terminalOutcome === "in_flight" ||
          !attempt.finishedAt ||
          attempt.costUsd === undefined ||
          !Number.isFinite(attempt.costUsd) ||
          attempt.costUsd < 0
        ) {
          throw new Error("Worker budget retains its reservation while provider usage is uncertain.");
        }
        cost += Math.ceil(attempt.costUsd * 1_000_000);
        dispatchedRequests += 1;
      }
      if (!Number.isSafeInteger(cost)) throw new Error("Worker budget usage cost is out of range.");
      if (dispatchedRequests === 0) {
        if (request.state === "completed")
          throw new Error("Completed worker inference cannot be settled without a provider dispatch.");
        // The canonical inference terminal retains the exact usage-intent
        // inventory. Release the unused capacity without manufacturing a
        // provider attempt; replay revalidates every retained no-dispatch proof.
        if (row.status === "released") return;
        this.db
          .prepare(
            `UPDATE remote_worker_budget_reservations SET status = 'released',
          settled_requests = 0, settled_cost_microusd = 0, closed_at = ?
          WHERE reservation_id = ? AND status = 'held'`,
          )
          .run(this.now(), row.reservation_id);
        return;
      }
      if (row.status !== "held") throw new Error("Worker budget release conflicts with dispatched usage.");
      // Overruns remain visible and consume the full actual cost; availability then clamps to zero.
      this.db
        .prepare(
          `UPDATE remote_worker_budget_reservations SET status = 'settled', settled_requests = ?,
        settled_cost_microusd = ?, usage_event_ids_sha256 = ?, closed_at = ? WHERE reservation_id = ? AND status = 'held'`,
        )
        .run(dispatchedRequests, cost, hash, this.now(), row.reservation_id);
    });
  }

  public release(input: {
    reservation: RemoteWorkerInferenceBudgetReservation;
    reason: RemoteWorkerInferenceReleaseReason;
  }): void {
    this.db.transaction("immediate", () => {
      const { row, request } = this.boundReservation(input.reservation);
      this.requireGrant(row.grant_id, true);
      if (
        request.state !== "blocked" ||
        request.budgetReservationId !== row.reservation_id ||
        request.budgetReleaseReason !== input.reason ||
        !request.budgetReleaseRequestedAt ||
        request.dispatchClaimedAt ||
        this.usage.listOperationAttemptsForUpdate(row.operation_id, row.dispatch_generation).length !== 0
      ) {
        throw new Error("Worker budget release lacks proof of no dispatch.");
      }
      if (row.status === "released") return;
      if (row.status !== "held") throw new Error("Worker budget is already settled.");
      this.db
        .prepare(
          `UPDATE remote_worker_budget_reservations SET status = 'released', settled_requests = 0,
        settled_cost_microusd = 0, closed_at = ? WHERE reservation_id = ? AND status = 'held'`,
        )
        .run(this.now(), row.reservation_id);
    });
  }

  private boundReservation(receipt: RemoteWorkerInferenceBudgetReservation): {
    row: ReservationRow;
    request: RemoteWorkerInferenceRequestRecord;
  } {
    normalizeRemoteWorkerInferenceBudgetReservation(receipt);
    const initial = this.db
      .prepare("SELECT * FROM remote_worker_budget_reservations WHERE reservation_id = ?")
      .get<ReservationRow>(receipt.reservationId);
    if (!initial || initial.receipt_json !== canonicalJsonString(receipt))
      throw new Error("Worker budget receipt does not match its owner.");
    const request = this.requireOperation(initial.operation_id, initial.dispatch_generation);
    // Re-read after acquiring the operation lock; another process may have settled while we waited.
    const row = this.db
      .prepare("SELECT * FROM remote_worker_budget_reservations WHERE reservation_id = ?")
      .get<ReservationRow>(receipt.reservationId)!;
    return { row, request };
  }

  private requireOperation(operationId: string, dispatchGeneration: string): RemoteWorkerInferenceRequestRecord {
    const request = this.inference.findOperationForUpdate(operationId, dispatchGeneration);
    if (!request) throw new Error("Worker budget requires a canonical admitted inference operation.");
    return request;
  }

  private requireGrant(grantId: string, lock = false): RemoteWorkerBudgetGrant {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_budget_grants WHERE grant_id = ?${lock && this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      )
      .get<GrantRow>(grantId);
    if (!row) throw new Error("An explicit operator worker budget grant is required.");
    return mapGrant(row);
  }

  private balance(grant: RemoteWorkerBudgetGrant): RemoteWorkerBudgetBalance {
    const row = this.db
      .prepare(
        `SELECT
      COALESCE(SUM(CASE WHEN status = 'held' THEN reserved_requests ELSE 0 END), 0) AS held_requests,
      COALESCE(SUM(CASE WHEN status = 'held' THEN reserved_cost_microusd ELSE 0 END), 0) AS held_cost,
      COALESCE(SUM(CASE WHEN status = 'settled' THEN settled_requests ELSE 0 END), 0) AS settled_requests,
      COALESCE(SUM(CASE WHEN status = 'settled' THEN settled_cost_microusd ELSE 0 END), 0) AS settled_cost
      FROM (
        SELECT status, reserved_requests, reserved_cost_microusd, settled_requests, settled_cost_microusd
        FROM remote_worker_budget_reservations WHERE grant_id = ?
        UNION ALL
        SELECT status, 1 AS reserved_requests, reserved_cost_microusd,
          CASE WHEN status = 'settled' THEN 1 ELSE 0 END AS settled_requests, settled_cost_microusd
        FROM remote_worker_budget_dispatches WHERE grant_id = ?
        UNION ALL
        SELECT status, 1 AS reserved_requests, reserved_cost_microusd,
          CASE WHEN status = 'settled' THEN 1 ELSE 0 END AS settled_requests, settled_cost_microusd
        FROM remote_worker_tool_budget_dispatches WHERE grant_id = ?
      ) AS grant_reservations`,
      )
      .get<Record<string, number | string>>(grant.grantId, grant.grantId, grant.grantId)!;
    const heldRequests = Number(row.held_requests),
      heldCostMicrousd = Number(row.held_cost);
    const settledRequests = Number(row.settled_requests),
      settledCostMicrousd = Number(row.settled_cost);
    if (![heldRequests, heldCostMicrousd, settledRequests, settledCostMicrousd].every(Number.isSafeInteger))
      throw new Error("Worker budget balance is out of range.");
    const active = !grant.revokedAt && grant.expiresAt > this.now();
    return {
      grant,
      heldRequests,
      heldCostMicrousd,
      settledRequests,
      settledCostMicrousd,
      availableRequests: active ? Math.max(0, grant.maxRequests - heldRequests - settledRequests) : 0,
      availableCostMicrousd: active ? Math.max(0, grant.maxCostMicrousd - heldCostMicrousd - settledCostMicrousd) : 0,
    };
  }

  private assertGrantReplay(grant: RemoteWorkerBudgetGrant, identity: string): RemoteWorkerBudgetGrant {
    const { operatorId, createdAt: _created, revokedAt: _revoked, revision: _revision, ...input } = grant;
    if (remoteWorkerBudgetGrantIdentity(input, operatorId) !== identity)
      throw new RemoteWorkerBudgetConflictError("Worker budget grant replay changed.");
    return grant;
  }

  private assertScope(grant: RemoteWorkerBudgetGrant, request: RemoteWorkerInferenceRequestRecord): void {
    if (
      grant.registryWorkspaceId !== request.registryWorkspaceId ||
      grant.executionWorkspaceId !== request.executionWorkspaceId ||
      grant.workerId !== request.workerId ||
      grant.workerGeneration !== request.workerGeneration
    )
      throw new Error("Worker budget grant scope mismatch.");
  }

  private route(request: RemoteWorkerInferenceRequestRecord): RemoteWorkerInferenceEffectiveRouteReceipt {
    if (!request.effectiveRouteJson) throw new Error("Worker budget requires canonical route pricing.");
    const route = normalizeRemoteWorkerInferenceEffectiveRouteReceipt(JSON.parse(request.effectiveRouteJson));
    if (remoteWorkerInferenceEffectiveRouteSha256(route) !== request.effectiveRouteSha256)
      throw new Error("Worker budget route digest mismatch.");
    return route;
  }

  private now(): string {
    const expression =
      this.db.dialect === "postgres"
        ? "to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    return this.db.prepare(`SELECT ${expression} AS now`).get<{ now: string }>()!.now;
  }
}

function mapGrant(row: GrantRow): RemoteWorkerBudgetGrant {
  const { operatorId, ...input } = JSON.parse(row.identity_json) as RemoteWorkerBudgetGrantInput & {
    operatorId: string;
  };
  return {
    ...normalizeRemoteWorkerBudgetGrant(input),
    operatorId: normalizeRemoteWorkerBudgetOperatorId(operatorId),
    createdAt: row.created_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    revision: Number(row.revision),
  };
}

function reservationCost(
  route: RemoteWorkerInferenceEffectiveRouteReceipt,
  operation: Pick<RemoteWorkerInferenceBudgetOperationInput, "outputTokenCeiling" | "reasoningTokenCeiling">,
  attempts = REMOTE_WORKER_BUDGET_MAX_ATTEMPTS,
): number {
  if (
    !route.configuredContextWindowTokens ||
    route.inputRateUsdPerMillion === undefined ||
    route.outputRateUsdPerMillion === undefined ||
    !route.pricingCatalogHash ||
    !route.pricingCatalogVersion
  )
    throw new Error("Worker inference requires bounded context and pinned pricing before spending.");
  // One microdollar per USD-per-million token. Reserve the whole context, including a retry.
  const inputRate = Math.max(route.inputRateUsdPerMillion, route.cachedInputRateUsdPerMillion ?? 0);
  const cost = Math.ceil(
    (route.configuredContextWindowTokens * inputRate +
      (operation.outputTokenCeiling + operation.reasoningTokenCeiling) * route.outputRateUsdPerMillion) *
      attempts,
  );
  if (!Number.isSafeInteger(cost) || cost < 0) throw new Error("Worker budget pricing is out of range.");
  return cost;
}

function assertUsageScope(
  usage: ModelUsageEventRecord,
  request: RemoteWorkerInferenceRequestRecord,
  route: RemoteWorkerInferenceEffectiveRouteReceipt,
  related = false,
): void {
  if (
    (related
      ? usage.operationId === request.operationId || usage.parentOperationId !== request.operationId
      : usage.operationId !== request.operationId || usage.dispatchGeneration !== request.dispatchGeneration) ||
    usage.workspaceId !== request.executionWorkspaceId ||
    usage.sessionId !== request.sessionId ||
    usage.turnId !== request.turnId ||
    usage.durableRunId !== request.durableRunId ||
    usage.taskId !== request.taskId ||
    usage.workerId !== request.workerId ||
    usage.contextIntentHash !== request.routedContextSha256
  ) {
    throw new Error("Worker budget usage is bound to different authority or pricing.");
  }
  assertWorkerBudgetUsagePricing(usage, route);
}
