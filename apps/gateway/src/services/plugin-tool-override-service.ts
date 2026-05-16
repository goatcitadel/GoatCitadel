import type { IntegrationPluginToolOverride } from "@goatcitadel/contracts";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";

export interface PluginToolOverrideClaimInput {
  pluginId: string;
  toolName: string;
  override: boolean;
  claimedAt: string;
}

export interface PluginToolOverrideClaimRecord extends IntegrationPluginToolOverride {
  pluginId: string;
  claimedAt: string;
}

export interface PluginToolOverrideServiceDeps {
  getOwnerId(): string;
}

export class PluginToolOverrideService {
  private readonly claims = new Map<string, PluginToolOverrideClaimRecord>();

  public constructor(private readonly deps: PluginToolOverrideServiceDeps) {}

  public registerOverrideClaim(input: PluginToolOverrideClaimInput): PluginToolOverrideClaimRecord {
    if (!input.pluginId.trim() || !input.toolName.trim()) {
      throw new ValidationError({ message: "pluginId and toolName are required." });
    }
    const key = makeKey(input.pluginId, input.toolName);
    const existing = this.claims.get(key);
    if (existing && existing.status !== "revoked") {
      return { ...existing };
    }
    const record: PluginToolOverrideClaimRecord = {
      pluginId: input.pluginId,
      toolName: input.toolName,
      override: input.override,
      status: "pending_owner_approval",
      claimedAt: input.claimedAt,
    };
    this.claims.set(key, record);
    return { ...record };
  }

  public approveClaim(input: {
    pluginId: string;
    toolName: string;
    approvedBy: string;
  }): PluginToolOverrideClaimRecord {
    if (input.approvedBy !== this.deps.getOwnerId()) {
      throw new ConflictError({
        message: "Only the owner can approve plugin tool overrides.",
      });
    }
    const record = this.requireClaim(input.pluginId, input.toolName);
    const updated: PluginToolOverrideClaimRecord = {
      ...record,
      status: "approved",
      approvedBy: input.approvedBy,
      approvedAt: new Date().toISOString(),
    };
    this.claims.set(makeKey(record.pluginId, record.toolName), updated);
    return { ...updated };
  }

  public revokeClaim(input: { pluginId: string; toolName: string; revokedBy: string }): PluginToolOverrideClaimRecord {
    if (input.revokedBy !== this.deps.getOwnerId()) {
      throw new ConflictError({
        message: "Only the owner can revoke plugin tool overrides.",
      });
    }
    const record = this.requireClaim(input.pluginId, input.toolName);
    const updated: PluginToolOverrideClaimRecord = {
      ...record,
      status: "revoked",
      override: false,
      revokedAt: new Date().toISOString(),
    };
    this.claims.set(makeKey(record.pluginId, record.toolName), updated);
    return { ...updated };
  }

  public listClaims(): PluginToolOverrideClaimRecord[] {
    return Array.from(this.claims.values()).map((record) => ({ ...record }));
  }

  public resolveActiveOverride(toolName: string): PluginToolOverrideClaimRecord | undefined {
    for (const record of this.claims.values()) {
      if (record.toolName === toolName && record.status === "approved" && record.override) {
        return { ...record };
      }
    }
    return undefined;
  }

  private requireClaim(pluginId: string, toolName: string): PluginToolOverrideClaimRecord {
    const record = this.claims.get(makeKey(pluginId, toolName));
    if (!record) {
      throw new ValidationError({
        message: `No override claim for plugin ${pluginId} on tool ${toolName}.`,
      });
    }
    return record;
  }
}

function makeKey(pluginId: string, toolName: string): string {
  return `${pluginId}::${toolName}`;
}
