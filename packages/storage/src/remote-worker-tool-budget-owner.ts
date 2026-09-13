import {
  canonicalJsonString, isModelUsageProvenNotDispatched, normalizeRemoteWorkerInferenceEffectiveRouteReceipt,
  readDurableChatTurnExecutionPayloadAuthority, remoteWorkerInferenceCanonicalSha256 as digest,
  type ModelUsageEventRecord, type RemoteWorkerBudgetBalance, type RemoteWorkerBudgetGrant,
  type RemoteWorkerInferenceEffectiveRouteReceipt,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerAssignmentRepository, type RemoteWorkerAssignmentProtectedCommitFence } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerEffectRepository } from "./remote-worker-effect-repo.js";
import { ModelUsageEventRepository } from "./model-usage-event-repo.js";
import { ChatTurnCapabilityProfileRepository } from "./chat-turn-capability-profile-repo.js";

export interface RemoteWorkerToolBudgetKey {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  intentId: string;
}
export interface AuthorizeRemoteWorkerToolAttempt extends RemoteWorkerToolBudgetKey {
  leaseTokenSha256: string;
  protectedAuthority: RemoteWorkerAssignmentProtectedCommitFence;
  effectSelector: string;
  canonicalArgsSha256: string;
  workerIdempotencyKey: string;
  usageEventId: string;
  route: RemoteWorkerInferenceEffectiveRouteReceipt;
}
type UsageAuthority = Pick<ModelUsageEventRecord, "workspaceId" | "sessionId" | "turnId" | "durableRunId" |
  "taskId" | "workerId" | "contextIntentHash" | "parentOperationId">;
interface ToolDispatchRow {
  usage_event_id: string; grant_id: string; intent_sha256: string;
  registry_workspace_id: string; assignment_id: string; assignment_generation: number; intent_id: string;
  authority_json: string; authority_sha256: string; route_json: string; route_sha256: string;
  status: "held" | "settled" | "released";
}
interface GrantOwner {
  lock(grantId: string): RemoteWorkerBudgetGrant;
  balance(grant: RemoteWorkerBudgetGrant): RemoteWorkerBudgetBalance;
  price(route: RemoteWorkerInferenceEffectiveRouteReceipt, outputTokenCeiling: number): number;
}

export function remoteWorkerToolBudgetOperationId(intentId: string): string { return `worker-tool:${intentId}`; }

/** Collaborator of RemoteWorkerBudgetRepository, sharing its canonical grant
 * lock and aggregate balance. Each transport attempt consumes exactly one hold. */
export class RemoteWorkerToolBudgetOwner {
  private readonly assignments: RemoteWorkerAssignmentRepository;
  private readonly effects: RemoteWorkerEffectRepository;
  private readonly usage: ModelUsageEventRepository;
  constructor(private readonly db: DatabaseClient, private readonly grants: GrantOwner) {
    this.assignments = new RemoteWorkerAssignmentRepository(db);
    this.effects = new RemoteWorkerEffectRepository(db);
    this.usage = new ModelUsageEventRepository(db);
  }

  authorize(input: AuthorizeRemoteWorkerToolAttempt): void {
    const route = normalizeRemoteWorkerInferenceEffectiveRouteReceipt(input.route);
    this.db.transaction("immediate", () => {
      // Canonical assignment/admission locks precede the spending grant lock.
      const execution = this.assignments.resolveActiveChatExecution(input, input.protectedAuthority);
      const { intent } = this.effects.readIntentForDispatch(input);
      if (this.effects.findSettlement(input.registryWorkspaceId, input.assignmentId, input.assignmentGeneration, input.intentId))
        throw new Error("Completed worker tools cannot authorize new model spending.");
      const { manifest } = execution.authority.assignment;
      const profile = new ChatTurnCapabilityProfileRepository(this.db).get(execution.workload.capabilityProfileId);
      if (!manifest.requiredCapabilityClasses.includes("governed_tool") ||
        profile.hashes.profileHash !== manifest.capabilityProfileSha256 ||
        !profile.selection.tools.some((tool) => tool.canonicalName === intent.effectSelector && tool.runtimeOwner && tool.effectPotential))
        throw new Error("Worker tool spending is outside the admitted capability profile.");
      const payload = readDurableChatTurnExecutionPayloadAuthority({ workflowKey: "chat.turn.execute",
        durableRunId: manifest.durableRunId, payload: execution.workload.payload });
      if (!payload) throw new Error("Worker tool spending requires canonical Chat admission.");
      const authority: UsageAuthority = { workspaceId: manifest.executionWorkspaceId, sessionId: manifest.sessionId,
        turnId: manifest.turnId, durableRunId: manifest.durableRunId, taskId: manifest.taskId,
        workerId: execution.authority.generation.workerId, contextIntentHash: execution.workload.contextSnapshotSha256,
        parentOperationId: remoteWorkerToolBudgetOperationId(intent.intentId) };
      const authorityJson = canonicalJsonString(authority), routeJson = canonicalJsonString(route);
      const prior = this.db.prepare("SELECT * FROM remote_worker_tool_budget_dispatches WHERE usage_event_id = ?")
        .get<ToolDispatchRow>(input.usageEventId);
      const candidates = prior ? [{ grant_id: prior.grant_id }] : this.db.prepare(`SELECT grant_id FROM remote_worker_budget_grants
        WHERE registry_workspace_id = ? AND execution_workspace_id = ? AND worker_id = ? AND worker_generation = ? AND operator_id = ?
          AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at, grant_id LIMIT 100`)
        .all<{ grant_id: string }>(input.registryWorkspaceId, manifest.executionWorkspaceId, authority.workerId!,
          execution.authority.generation.workerGeneration, payload.requestActor.actorId, this.now());
      for (const candidate of candidates) {
        const grant = this.grants.lock(candidate.grant_id);
        if (grant.operatorId !== payload.requestActor.actorId || grant.registryWorkspaceId !== input.registryWorkspaceId ||
          grant.executionWorkspaceId !== manifest.executionWorkspaceId || grant.workerId !== authority.workerId ||
          grant.workerGeneration !== execution.authority.generation.workerGeneration || grant.revokedAt || grant.expiresAt <= this.now()) continue;
        // Lock usage after the grant, matching inference and utility accounting.
        const usage = this.usage.findByEventIdForUpdate(input.usageEventId);
        if (!usage || usage.source !== "llm_service" || usage.transportStatus !== "intent" ||
          usage.terminalOutcome !== "in_flight" || usage.finishedAt || !Number.isSafeInteger(usage.effectiveOutputTokenCap) ||
          (usage.effectiveOutputTokenCap ?? 0) <= 0)
          throw new Error("Worker tool spending requires a bounded canonical model intent.");
        assertToolUsage(usage, authority, route);
        if (prior) {
          if (prior.registry_workspace_id !== input.registryWorkspaceId || prior.assignment_id !== input.assignmentId ||
            Number(prior.assignment_generation) !== input.assignmentGeneration || prior.intent_id !== input.intentId ||
            prior.intent_sha256 !== intent.intentSha256 || prior.authority_json !== authorityJson ||
            prior.authority_sha256 !== digest(authority) || prior.route_json !== routeJson || prior.route_sha256 !== digest(route) ||
            prior.status !== "held") throw new Error("Worker tool budget replay changed its authority.");
          return;
        }
        const cost = this.grants.price(route, usage.effectiveOutputTokenCap!);
        const balance = this.grants.balance(grant);
        if (balance.availableRequests < 1 || balance.availableCostMicrousd < cost) continue;
        this.db.prepare(`INSERT INTO remote_worker_tool_budget_dispatches
          (usage_event_id, registry_workspace_id, assignment_id, assignment_generation, intent_id, intent_sha256,
           grant_id, authority_json, authority_sha256, route_json, route_sha256, reserved_cost_microusd, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.usageEventId, input.registryWorkspaceId, input.assignmentId, input.assignmentGeneration, input.intentId,
            intent.intentSha256, grant.grantId, authorityJson, digest(authority), routeJson, digest(route), cost, this.now());
        return;
      }
      throw new Error("No current operator grant can fund this worker tool model request.");
    });
  }

  reconcile(key: RemoteWorkerToolBudgetKey): void {
    // Settlement never needs live execution authority and never dispatches. A
    // revoked grant or expired worker must still retain/settle actual charges.
    const rows = this.rows(key);
    for (const observed of rows) {
      this.db.transaction("immediate", () => {
        this.grants.lock(observed.grant_id);
        const row = this.db.prepare("SELECT * FROM remote_worker_tool_budget_dispatches WHERE usage_event_id = ?")
          .get<ToolDispatchRow>(observed.usage_event_id)!;
        if (row.status !== "held") return;
        const usage = this.usage.findByEventIdForUpdate(row.usage_event_id);
        if (!usage) throw new Error("Worker tool budget usage is unavailable.");
        const authority = JSON.parse(row.authority_json) as UsageAuthority;
        const route = normalizeRemoteWorkerInferenceEffectiveRouteReceipt(JSON.parse(row.route_json));
        if (digest(authority) !== row.authority_sha256 || digest(route) !== row.route_sha256)
          throw new Error("Worker tool budget evidence hash changed.");
        assertToolUsage(usage, authority, route);
        const released = isModelUsageProvenNotDispatched(usage);
        if (!released && (usage.transportStatus !== "accepted" || usage.terminalOutcome === "in_flight" ||
          !usage.finishedAt || usage.costUsd === undefined || !Number.isFinite(usage.costUsd) || usage.costUsd < 0)) return;
        const cost = released ? 0 : Math.ceil(usage.costUsd! * 1_000_000);
        if (!Number.isSafeInteger(cost)) throw new Error("Worker tool budget cost is out of range.");
        this.db.prepare(`UPDATE remote_worker_tool_budget_dispatches SET status = ?, settled_cost_microusd = ?, closed_at = ?
          WHERE usage_event_id = ? AND status = 'held'`).run(released ? "released" : "settled", cost, this.now(), row.usage_event_id);
      });
    }
  }

  list(key: RemoteWorkerToolBudgetKey): ModelUsageEventRecord[] {
    return this.rows(key).map((row) => {
      const usage = this.usage.findByEventId(row.usage_event_id);
      if (!usage) throw new Error("Worker tool budget usage is unavailable.");
      return usage;
    });
  }
  private rows(key: RemoteWorkerToolBudgetKey): ToolDispatchRow[] {
    return this.db.prepare(`SELECT * FROM remote_worker_tool_budget_dispatches
      WHERE registry_workspace_id = ? AND assignment_id = ? AND assignment_generation = ? AND intent_id = ?
      ORDER BY created_at, usage_event_id`).all<ToolDispatchRow>(key.registryWorkspaceId, key.assignmentId, key.assignmentGeneration, key.intentId);
  }
  private now(): string {
    return this.db.prepare(this.db.dialect === "postgres"
      ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`
      : "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get<{ now: string }>()!.now;
  }
}

function assertToolUsage(usage: ModelUsageEventRecord, authority: UsageAuthority, route: RemoteWorkerInferenceEffectiveRouteReceipt): void {
  if (usage.operationId === authority.parentOperationId ||
    Object.entries(authority).some(([key, value]) => usage[key as keyof UsageAuthority] !== value))
    throw new Error("Worker tool model usage belongs to another execution.");
  assertWorkerBudgetUsagePricing(usage, route);
}

export function assertWorkerBudgetUsagePricing(usage: ModelUsageEventRecord, route: RemoteWorkerInferenceEffectiveRouteReceipt): void {
  if (usage.effectiveProviderId !== route.providerId || usage.effectiveModelId !== route.modelId || usage.effectiveApiStyle !== route.apiStyle ||
    usage.credentialType !== route.credentialType || usage.usagePool !== route.usagePool || usage.credentialSource !== route.credentialSource ||
    usage.credentialConfigFingerprint !== route.credentialConfigFingerprint || usage.pricingCatalogHash !== route.pricingCatalogHash ||
    usage.pricingCatalogVersion !== route.pricingCatalogVersion || usage.inputRateUsdPerMillion !== route.inputRateUsdPerMillion ||
    usage.outputRateUsdPerMillion !== route.outputRateUsdPerMillion || usage.cachedInputRateUsdPerMillion !== route.cachedInputRateUsdPerMillion)
    throw new Error("Worker budget usage is bound to different authority or pricing.");
}
