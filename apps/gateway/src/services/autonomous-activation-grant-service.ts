import { randomUUID } from "node:crypto";
import type {
  AutonomousActivationGrantCreateInput,
  AutonomousActivationGrantEvaluationInput,
  AutonomousActivationGrantEvaluationResult,
  AutonomousActivationGrantRecord,
  AutonomousActivationGrantRevokeInput,
  AutonomousActivationRiskLevel,
  PermissionSurface,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { wildcardMatch } from "./mcp-server-policy.js";

const SETTING_KEY = "autonomous_activation_grants_v1";
const DEFAULT_WORKSPACE_ID = "default";
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
    const grant: AutonomousActivationGrantRecord = {
      grantId: `auto-grant-${randomUUID()}`,
      status: "active",
      workspaceId: input.workspaceId?.trim() || DEFAULT_WORKSPACE_ID,
      surfaces: normalizeSurfaces(input.surfaces),
      maxRiskLevel: input.maxRiskLevel,
      capabilityPatterns: normalizePatterns(input.capabilityPatterns),
      toolPatterns: normalizePatterns(input.toolPatterns),
      activationKinds: input.activationKinds?.length
        ? [...new Set(input.activationKinds)]
        : ["capability", "tool", "mcp_tool", "code_mode"],
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
    await this.writeGrants([grant, ...(await this.readGrants())]);
    await this.publishRealtime("system", "capabilities", {
      type: "autonomous_activation_grant_created",
      grantId: grant.grantId,
      workspaceId: grant.workspaceId,
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
    const grants = (await this.readGrants()).map((grant) => {
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
    if (!updated) {
      throw new Error(`Unknown autonomous activation grant: ${grantId}`);
    }
    await this.writeGrants(grants);
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

  public async recordGrantUse(grantId: string, estimatedCostUsd = 0): Promise<AutonomousActivationGrantRecord> {
    const now = new Date().toISOString();
    let updated: AutonomousActivationGrantRecord | undefined;
    const grants = (await this.readGrants()).map((grant) => {
      if (grant.grantId !== grantId) {
        return grant;
      }
      const hydrated = hydrateGrantStatus(grant);
      if (hydrated.status !== "active") {
        throw new Error(`Autonomous activation grant ${grantId} is ${hydrated.status}.`);
      }
      if (hydrated.maxActivations !== undefined && hydrated.usedActivations >= hydrated.maxActivations) {
        throw new Error(`Autonomous activation grant ${grantId} activation count is exhausted.`);
      }
      if (hydrated.budgetUsd !== undefined && (hydrated.usedBudgetUsd ?? 0) + estimatedCostUsd > hydrated.budgetUsd) {
        throw new Error(`Autonomous activation grant ${grantId} budget is exhausted.`);
      }
      updated = {
        ...hydrated,
        usedActivations: hydrated.usedActivations + 1,
        usedBudgetUsd: (hydrated.usedBudgetUsd ?? 0) + estimatedCostUsd,
        lastUsedAt: now,
        updatedAt: now,
      };
      return updated;
    });
    if (!updated) {
      throw new Error(`Unknown autonomous activation grant: ${grantId}`);
    }
    await this.writeGrants(grants);
    await this.publishRealtime("system", "capabilities", {
      type: "autonomous_activation_grant_used",
      grantId,
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

  private async writeGrants(grants: AutonomousActivationGrantRecord[]): Promise<void> {
    await this.systemSettings.set(
      SETTING_KEY,
      grants.map((grant) => hydrateGrantStatus(grant)),
    );
  }
}

function evaluateSingleGrant(
  grant: AutonomousActivationGrantRecord,
  input: AutonomousActivationGrantEvaluationInput,
): AutonomousActivationGrantEvaluationResult {
  const blockers: string[] = [];
  const workspaceId = input.workspaceId?.trim() || DEFAULT_WORKSPACE_ID;
  if (grant.workspaceId !== workspaceId) {
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
  if (!matchesAny(input.capabilityId, grant.capabilityPatterns) && !matchesAny(input.toolName, grant.toolPatterns)) {
    blockers.push(`Grant ${grant.grantId} does not match the requested capability or tool pattern.`);
  }
  if (grant.maxActivations !== undefined && grant.usedActivations >= grant.maxActivations) {
    blockers.push(`Grant ${grant.grantId} activation count is exhausted.`);
  }
  if (grant.budgetUsd !== undefined && (grant.usedBudgetUsd ?? 0) + (input.estimatedCostUsd ?? 0) > grant.budgetUsd) {
    blockers.push(`Grant ${grant.grantId} budget is exhausted.`);
  }
  return {
    allowed: blockers.length === 0,
    matchedGrantId: blockers.length === 0 ? grant.grantId : undefined,
    blockers,
    governance: blockers.length === 0 ? buildGovernance(grant) : [],
  };
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

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
