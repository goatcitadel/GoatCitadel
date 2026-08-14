import { randomUUID } from "node:crypto";
import type {
  AutonomousActivationGrantCreateInput,
  AutonomousActivationGrantEvaluationInput,
  AutonomousActivationGrantEvaluationResult,
  AutonomousActivationGrantRecord,
  AutonomousActivationGrantReservationInput,
  AutonomousActivationGrantRevokeInput,
  AutonomousActivationRiskLevel,
  PermissionSurface,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { wildcardMatch } from "./mcp-server-policy.js";

const SETTING_KEY = "autonomous_activation_grants_v1";
const DEFAULT_WORKSPACE_ID = "default";
/** One child needs this conservative ceiling; lower project grants cannot ever admit even one fan-out child. */
const MIN_AUTOMATIC_FANOUT_BUDGET_USD = 0.25;
const RISK_RANK: Record<AutonomousActivationRiskLevel, number> = {
  safe: 1,
  caution: 2,
  danger: 3,
  nuclear: 4,
};

export class AutonomousActivationGrantService {
  public constructor(
    private readonly systemSettings: Storage["systemSettings"],
    private readonly publishRealtime: (
      eventType: string,
      source: string,
      payload: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {}

  public async listGrants(options: { includeExpired?: boolean } = {}): Promise<AutonomousActivationGrantRecord[]> {
    const nowMs = Date.now();
    const grants = (await this.readGrants()).map((grant) => hydrateGrantStatus(grant, nowMs));
    if (!options.includeExpired) {
      return grants.filter((grant) => grant.status !== "expired");
    }
    return grants;
  }

  public async createGrant(input: AutonomousActivationGrantCreateInput): Promise<AutonomousActivationGrantRecord> {
    const now = new Date().toISOString();
    const expiresAtMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error("Autonomous activation grants require a future expiresAt.");
    }
    if (!input.reason.trim()) {
      throw new Error("Autonomous activation grants require a reason.");
    }
    if (!input.grantor.trim()) {
      throw new Error("Autonomous activation grants require a grantor.");
    }
    const activationKinds: AutonomousActivationGrantRecord["activationKinds"] = input.activationKinds?.length
      ? [...new Set(input.activationKinds)]
      : ["capability", "tool", "mcp_tool", "code_mode"];
    const workspaceId = input.workspaceId?.trim() || DEFAULT_WORKSPACE_ID;
    const projectId = input.projectId?.trim() || undefined;
    if (activationKinds.includes("subagent_fanout")) {
      if (!projectId || projectId === "*") {
        throw new Error("Automatic subagent fan-out grants require one exact projectId.");
      }
      if (workspaceId === "*") {
        throw new Error("Automatic subagent fan-out grants cannot use a wildcard workspace.");
      }
      const surfaces = normalizeSurfaces(input.surfaces);
      if (activationKinds.length !== 1 || activationKinds[0] !== "subagent_fanout") {
        throw new Error("Automatic subagent fan-out grants cannot be combined with other activation kinds.");
      }
      if (surfaces.length !== 1 || surfaces[0] !== "chat") {
        throw new Error("Automatic subagent fan-out grants are scoped only to Chat.");
      }
      if (input.maxRiskLevel !== "caution") {
        throw new Error("Automatic subagent fan-out grants require the fixed caution risk level.");
      }
      const maxFanoutActivations = input.maxActivations;
      if (
        typeof maxFanoutActivations !== "number" ||
        !Number.isInteger(maxFanoutActivations) ||
        maxFanoutActivations < 1
      ) {
        throw new Error("Automatic subagent fan-out grants require a positive maximum child activation limit.");
      }
      const fanoutBudgetUsd = input.budgetUsd;
      if (
        typeof fanoutBudgetUsd !== "number" ||
        !Number.isFinite(fanoutBudgetUsd) ||
        fanoutBudgetUsd < MIN_AUTOMATIC_FANOUT_BUDGET_USD
      ) {
        throw new Error(
          `Automatic subagent fan-out grants require a budget ceiling of at least $${MIN_AUTOMATIC_FANOUT_BUDGET_USD.toFixed(2)}.`,
        );
      }
    }
    const grant: AutonomousActivationGrantRecord = {
      grantId: `auto-grant-${randomUUID()}`,
      status: "active",
      workspaceId,
      ...(projectId ? { projectId } : {}),
      surfaces: normalizeSurfaces(input.surfaces),
      maxRiskLevel: input.maxRiskLevel,
      capabilityPatterns: normalizePatterns(input.capabilityPatterns),
      toolPatterns: normalizePatterns(input.toolPatterns),
      activationKinds,
      maxActivations: input.maxActivations,
      usedActivations: 0,
      budgetUsd: input.budgetUsd,
      usedBudgetUsd: 0,
      grantor: input.grantor.trim(),
      reason: input.reason.trim(),
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    await this.systemSettings.mutate(SETTING_KEY, [], (stored) => [grant, ...normalizeStoredGrants(stored)]);
    await this.publishRealtime("system", "capabilities", {
      type: "autonomous_activation_grant_created",
      grantId: grant.grantId,
      workspaceId: grant.workspaceId,
      ...(grant.projectId ? { projectId: grant.projectId } : {}),
      maxRiskLevel: grant.maxRiskLevel,
      expiresAt: grant.expiresAt,
    });
    return grant;
  }

  public async revokeGrant(
    grantId: string,
    input: AutonomousActivationGrantRevokeInput,
  ): Promise<AutonomousActivationGrantRecord> {
    const now = new Date().toISOString();
    let updated: AutonomousActivationGrantRecord | undefined;
    await this.systemSettings.mutate(SETTING_KEY, [], (stored) => {
      const grants = normalizeStoredGrants(stored).map((grant) => {
        if (grant.grantId !== grantId) {
          return grant;
        }
        updated = {
          ...hydrateGrantStatus(grant),
          status: "revoked",
          revokedAt: now,
          revokedBy: input.revokedBy.trim() || "operator",
          revocationReason: input.reason?.trim() || undefined,
          updatedAt: now,
        };
        return updated;
      });
      return grants;
    });
    if (!updated) {
      throw new Error(`Unknown autonomous activation grant: ${grantId}`);
    }
    await this.publishRealtime("system", "capabilities", {
      type: "autonomous_activation_grant_revoked",
      grantId,
      revokedBy: updated.revokedBy,
    });
    return updated;
  }

  public async evaluateGrant(
    input: AutonomousActivationGrantEvaluationInput,
  ): Promise<AutonomousActivationGrantEvaluationResult> {
    const grants = (await this.listGrants()).filter((grant) => grant.status === "active");
    const blockers: string[] = [];
    for (const grant of grants) {
      const result = evaluateSingleGrant(grant, input);
      if (result.allowed) {
        return {
          allowed: true,
          matchedGrantId: grant.grantId,
          blockers: [],
          governance: buildGovernance(grant),
        };
      }
      blockers.push(...result.blockers);
    }
    return {
      allowed: false,
      blockers: dedupe(blockers.length ? blockers : ["No active autonomous activation grant matched this request."]),
      governance: [
        "Agentic activation is disabled unless an active expiring operator grant matches the request.",
        "Matched grants still do not bypass deny-wins policy, path jails, auth boundaries, provenance, or health checks.",
      ],
    };
  }

  /** Revalidates the exact frozen grant reference; it never substitutes another grant. */
  public async evaluateGrantById(
    grantId: string,
    input: AutonomousActivationGrantEvaluationInput,
  ): Promise<AutonomousActivationGrantEvaluationResult> {
    const grant = (await this.readGrants())
      .map((item) => hydrateGrantStatus(item))
      .find((item) => item.grantId === grantId);
    if (!grant) {
      return {
        allowed: false,
        blockers: [`Unknown autonomous activation grant: ${grantId}`],
        governance: [],
      };
    }
    if (grant.status !== "active") {
      return {
        allowed: false,
        blockers: [`Autonomous activation grant ${grantId} is ${grant.status}.`],
        governance: [],
      };
    }
    return evaluateSingleGrant(grant, input);
  }

  /**
   * Revalidates frozen authority after its aggregate quota/cost has already
   * been atomically reserved. It deliberately still checks status, expiry,
   * exact workspace/project scope, surface, kind, and capability/tool scope;
   * it only omits *new* capacity consumption so a fully reserved three-child
   * aggregate does not invalidate itself before child one can start.
   */
  public async evaluateGrantAuthorityById(
    grantId: string,
    input: AutonomousActivationGrantEvaluationInput,
  ): Promise<AutonomousActivationGrantEvaluationResult> {
    const grant = (await this.readGrants())
      .map((item) => hydrateGrantStatus(item))
      .find((item) => item.grantId === grantId);
    if (!grant) {
      return { allowed: false, blockers: [`Unknown autonomous activation grant: ${grantId}`], governance: [] };
    }
    if (grant.status !== "active") {
      return {
        allowed: false,
        blockers: [`Autonomous activation grant ${grantId} is ${grant.status}.`],
        governance: [],
      };
    }
    return evaluateSingleGrant(grant, input, { skipCapacityCheck: true });
  }

  public async recordGrantUse(grantId: string, estimatedCostUsd = 0): Promise<AutonomousActivationGrantRecord> {
    const updated = await this.reserveGrantMutation({
      grantId,
      requiredActivations: 1,
      estimatedCostUsd,
    });
    await this.publishRealtime("system", "capabilities", {
      type: "autonomous_activation_grant_used",
      grantId,
      usedActivations: updated.usedActivations,
      usedBudgetUsd: updated.usedBudgetUsd,
    });
    return updated;
  }

  /**
   * Conservatively consumes an aggregate's child slots and cost ceiling in one
   * row-locked settings mutation. Callers must reserve before the first child
   * starts; an insufficient reservation rejects the entire aggregate.
   */
  public async reserveGrantUse(
    input: AutonomousActivationGrantReservationInput,
  ): Promise<AutonomousActivationGrantRecord> {
    if (!Number.isInteger(input.requiredActivations) || input.requiredActivations < 1) {
      throw new Error("Autonomous activation grant reservations require at least one activation.");
    }
    if (!Number.isFinite(input.estimatedCostUsd ?? 0) || (input.estimatedCostUsd ?? 0) < 0) {
      throw new Error("Autonomous activation grant reservations require a non-negative finite cost ceiling.");
    }
    if (input.reservationId !== undefined && (!input.reservationId.trim() || input.reservationId.length > 256)) {
      throw new Error("Autonomous activation grant reservation IDs must be non-empty and at most 256 characters.");
    }
    const updated = await this.reserveGrantMutation(input);
    await this.publishRealtime("system", "capabilities", {
      type: "autonomous_activation_grant_reserved",
      grantId: updated.grantId,
      workspaceId: updated.workspaceId,
      ...(updated.projectId ? { projectId: updated.projectId } : {}),
      reservedActivations: input.requiredActivations,
      reservedBudgetUsd: input.estimatedCostUsd ?? 0,
      usedActivations: updated.usedActivations,
      usedBudgetUsd: updated.usedBudgetUsd,
    });
    return updated;
  }

  private async readGrants(): Promise<AutonomousActivationGrantRecord[]> {
    const stored = (await this.systemSettings.get<AutonomousActivationGrantRecord[]>(SETTING_KEY))?.value;
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored.filter((item): item is AutonomousActivationGrantRecord => Boolean(item?.grantId));
  }

  private async reserveGrantMutation(
    input: Pick<
      AutonomousActivationGrantReservationInput,
      "grantId" | "requiredActivations" | "estimatedCostUsd" | "reservationId"
    > &
      Partial<AutonomousActivationGrantEvaluationInput>,
  ): Promise<AutonomousActivationGrantRecord> {
    const now = new Date().toISOString();
    let updated: AutonomousActivationGrantRecord | undefined;
    await this.systemSettings.mutate(SETTING_KEY, [], (stored) => {
      const grants = normalizeStoredGrants(stored).map((grant) => {
        if (grant.grantId !== input.grantId) {
          return grant;
        }
        const hydrated = hydrateGrantStatus(grant);
        if (hydrated.status !== "active") {
          throw new Error(`Autonomous activation grant ${input.grantId} is ${hydrated.status}.`);
        }
        const reservationId = input.reservationId?.trim();
        if (reservationId && hydrated.reservationIds?.includes(reservationId)) {
          updated = hydrated;
          return updated;
        }
        if (input.activationKind) {
          const evaluation = evaluateSingleGrant(hydrated, {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            surface: input.surface!,
            riskLevel: input.riskLevel!,
            activationKind: input.activationKind,
            capabilityId: input.capabilityId,
            toolName: input.toolName,
            estimatedCostUsd: input.estimatedCostUsd,
            requiredActivations: input.requiredActivations,
          });
          if (!evaluation.allowed) {
            throw new Error(
              `Autonomous activation grant ${input.grantId} cannot reserve this request: ${evaluation.blockers.join(" ")}`,
            );
          }
        } else {
          assertReservationCapacity(hydrated, input.requiredActivations, input.estimatedCostUsd ?? 0);
        }
        updated = {
          ...hydrated,
          usedActivations: hydrated.usedActivations + input.requiredActivations,
          usedBudgetUsd: (hydrated.usedBudgetUsd ?? 0) + (input.estimatedCostUsd ?? 0),
          ...(reservationId ? { reservationIds: [...(hydrated.reservationIds ?? []), reservationId] } : {}),
          lastUsedAt: now,
          updatedAt: now,
        };
        return updated;
      });
      return grants;
    });
    if (!updated) {
      throw new Error(`Unknown autonomous activation grant: ${input.grantId}`);
    }
    return updated;
  }
}

function evaluateSingleGrant(
  grant: AutonomousActivationGrantRecord,
  input: AutonomousActivationGrantEvaluationInput & { requiredActivations?: number },
  options: { skipCapacityCheck?: boolean } = {},
): AutonomousActivationGrantEvaluationResult {
  const blockers: string[] = [];
  const workspaceId = input.workspaceId?.trim() || DEFAULT_WORKSPACE_ID;
  if (grant.workspaceId !== "*" && grant.workspaceId !== workspaceId) {
    blockers.push(`Grant ${grant.grantId} is scoped to workspace ${grant.workspaceId}.`);
  }
  if (!grant.surfaces.includes("all") && !grant.surfaces.includes(input.surface)) {
    blockers.push(`Grant ${grant.grantId} does not cover surface ${input.surface}.`);
  }
  if (RISK_RANK[input.riskLevel] > RISK_RANK[grant.maxRiskLevel]) {
    blockers.push(`Grant ${grant.grantId} allows up to ${grant.maxRiskLevel} risk, not ${input.riskLevel}.`);
  }
  if (!grant.activationKinds.includes(input.activationKind)) {
    blockers.push(`Grant ${grant.grantId} does not cover ${input.activationKind} activation.`);
  }
  const requestedProjectId = input.projectId?.trim();
  if (input.activationKind === "subagent_fanout") {
    blockers.push(...fanoutGrantShapeBlockers(grant));
    if (!requestedProjectId) {
      blockers.push("Automatic subagent fan-out requires an active project binding.");
    }
    if (!grant.projectId || grant.projectId === "*" || grant.projectId !== requestedProjectId) {
      blockers.push(`Grant ${grant.grantId} is not scoped to the active project.`);
    }
    if (grant.workspaceId === "*") {
      blockers.push(`Grant ${grant.grantId} uses a wildcard workspace and cannot authorize subagent fan-out.`);
    }
  } else if (grant.projectId && grant.projectId !== requestedProjectId) {
    blockers.push(`Grant ${grant.grantId} is scoped to project ${grant.projectId}.`);
  }
  if (!matchesAny(input.capabilityId, grant.capabilityPatterns) && !matchesAny(input.toolName, grant.toolPatterns)) {
    blockers.push(`Grant ${grant.grantId} does not match the requested capability or tool pattern.`);
  }
  if (!options.skipCapacityCheck) {
    const requiredActivations = input.requiredActivations ?? 1;
    if (grant.maxActivations !== undefined && grant.usedActivations + requiredActivations > grant.maxActivations) {
      blockers.push(`Grant ${grant.grantId} activation count is exhausted for this reservation.`);
    }
    if (grant.budgetUsd !== undefined && (grant.usedBudgetUsd ?? 0) + (input.estimatedCostUsd ?? 0) > grant.budgetUsd) {
      blockers.push(`Grant ${grant.grantId} budget is exhausted for this reservation.`);
    }
  }
  return {
    allowed: blockers.length === 0,
    matchedGrantId: blockers.length === 0 ? grant.grantId : undefined,
    blockers,
    governance: blockers.length === 0 ? buildGovernance(grant) : [],
  };
}

/**
 * Fan-out authority is deliberately narrower than the generic grant format.
 * This runtime-time check is also important for persisted data: a grant that
 * predates the dedicated kind, or was manually malformed, must not become
 * valid merely because its array happens to mention `subagent_fanout`.
 */
function fanoutGrantShapeBlockers(grant: AutonomousActivationGrantRecord): string[] {
  const blockers: string[] = [];
  if (grant.activationKinds.length !== 1 || grant.activationKinds[0] !== "subagent_fanout") {
    blockers.push(`Grant ${grant.grantId} is not a dedicated automatic fan-out grant.`);
  }
  if (grant.surfaces.length !== 1 || grant.surfaces[0] !== "chat") {
    blockers.push(`Grant ${grant.grantId} is not scoped exclusively to Chat.`);
  }
  if (grant.maxRiskLevel !== "caution") {
    blockers.push(`Grant ${grant.grantId} does not use the required caution risk boundary.`);
  }
  if (typeof grant.maxActivations !== "number" || !Number.isInteger(grant.maxActivations) || grant.maxActivations < 1) {
    blockers.push(`Grant ${grant.grantId} lacks a valid child-activation limit.`);
  }
  if (
    typeof grant.budgetUsd !== "number" ||
    !Number.isFinite(grant.budgetUsd) ||
    grant.budgetUsd < MIN_AUTOMATIC_FANOUT_BUDGET_USD
  ) {
    blockers.push(`Grant ${grant.grantId} lacks the minimum automatic fan-out budget ceiling.`);
  }
  return blockers;
}

function assertReservationCapacity(
  grant: AutonomousActivationGrantRecord,
  requiredActivations: number,
  estimatedCostUsd: number,
): void {
  if (!Number.isInteger(requiredActivations) || requiredActivations < 1) {
    throw new Error("Autonomous activation grant reservations require at least one activation.");
  }
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
    throw new Error("Autonomous activation grant reservations require a non-negative finite cost ceiling.");
  }
  if (grant.maxActivations !== undefined && grant.usedActivations + requiredActivations > grant.maxActivations) {
    throw new Error(`Autonomous activation grant ${grant.grantId} activation count is exhausted.`);
  }
  if (grant.budgetUsd !== undefined && (grant.usedBudgetUsd ?? 0) + estimatedCostUsd > grant.budgetUsd) {
    throw new Error(`Autonomous activation grant ${grant.grantId} budget is exhausted.`);
  }
}

function buildGovernance(grant: AutonomousActivationGrantRecord): string[] {
  return [
    `Matched expiring autonomous activation grant ${grant.grantId}.`,
    "Deny-wins policy, path jails, auth, provenance, health checks, and approval gates still apply.",
    "Every activation must record durable audit/evidence and remain revocable by operator emergency stop.",
  ];
}

function hydrateGrantStatus(
  grant: AutonomousActivationGrantRecord,
  nowMs = Date.now(),
): AutonomousActivationGrantRecord {
  if (grant.status === "revoked") {
    return grant;
  }
  if (Date.parse(grant.expiresAt) <= nowMs) {
    return { ...grant, status: "expired" };
  }
  return { ...grant, status: "active" };
}

function normalizeSurfaces(surfaces?: PermissionSurface[]): PermissionSurface[] {
  const defaults: PermissionSurface[] = ["all"];
  const normalized = [...new Set(surfaces?.length ? surfaces : defaults)];
  return normalized.includes("all") ? ["all"] : normalized;
}

function normalizePatterns(patterns?: string[]): string[] {
  const normalized = patterns?.map((item) => item.trim()).filter(Boolean) ?? [];
  return normalized.length > 0 ? [...new Set(normalized)] : ["*"];
}

function matchesAny(value: string | undefined, patterns: string[]): boolean {
  return Boolean(value?.trim()) && patterns.some((pattern) => wildcardMatch(value!, pattern));
}

function normalizeStoredGrants(value: unknown): AutonomousActivationGrantRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is AutonomousActivationGrantRecord => Boolean(item?.grantId));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
