import type { IntegrationPluginToolOverride, ToolInvokeResult } from "@goatcitadel/contracts";
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

export interface PluginToolOverrideConflictWarning {
  toolName: string;
  pluginIds: string[];
  status: "pending_owner_approval" | "approved";
  message: string;
}

export interface PluginToolOverrideServiceDeps {
  getOwnerId(): string;
}

export type PluginToolHandler = (args: Record<string, unknown>) => Promise<ToolInvokeResult>;

export interface PluginToolHandlerRegistration {
  pluginId: string;
  toolName: string;
  handler: PluginToolHandler;
}

export interface PluginToolHandlerUnregistration {
  pluginId: string;
  toolName: string;
}

export class PluginToolOverrideService {
  private readonly claims = new Map<string, PluginToolOverrideClaimRecord>();
  private readonly handlers = new Map<string, PluginToolHandler>();

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
    const existingApproved = this.findApprovedForTool(input.toolName);
    if (existingApproved && existingApproved.pluginId !== input.pluginId) {
      throw new ConflictError({
        message: `Cannot approve plugin ${input.pluginId} for tool ${input.toolName}: plugin ${existingApproved.pluginId} already has an approved override. Revoke the existing override first.`,
      });
    }
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

  public listConflictWarnings(): PluginToolOverrideConflictWarning[] {
    const byToolAndStatus = new Map<string, PluginToolOverrideClaimRecord[]>();
    for (const record of this.claims.values()) {
      if (!record.override || record.status === "revoked") {
        continue;
      }
      const key = `${record.toolName}::${record.status}`;
      byToolAndStatus.set(key, [...(byToolAndStatus.get(key) ?? []), record]);
    }
    return [...byToolAndStatus.values()]
      .filter((records) => records.length > 1)
      .map((records) => {
        const toolName = records[0]?.toolName ?? "unknown";
        const status = records[0]?.status === "approved" ? "approved" : "pending_owner_approval";
        const pluginIds = records.map((record) => record.pluginId).sort();
        return {
          toolName,
          pluginIds,
          status,
          message: `Multiple plugins request ${status} override for ${toolName}: ${pluginIds.join(", ")}.`,
        };
      });
  }

  public resolveActiveOverride(toolName: string): PluginToolOverrideClaimRecord | undefined {
    for (const record of this.claims.values()) {
      if (record.toolName === toolName && record.status === "approved" && record.override) {
        return { ...record };
      }
    }
    return undefined;
  }

  public registerHandler(input: PluginToolHandlerRegistration): void {
    if (!input.pluginId.trim() || !input.toolName.trim()) {
      throw new ValidationError({ message: "pluginId and toolName are required." });
    }
    if (typeof input.handler !== "function") {
      throw new ValidationError({ message: "handler must be a function." });
    }
    this.handlers.set(makeKey(input.pluginId, input.toolName), input.handler);
  }

  public unregisterHandler(input: PluginToolHandlerUnregistration): void {
    this.handlers.delete(makeKey(input.pluginId, input.toolName));
  }

  public resolveActiveHandler(toolName: string): PluginToolHandler | undefined {
    const activeOverride = this.resolveActiveOverride(toolName);
    if (!activeOverride) {
      return undefined;
    }
    return this.handlers.get(makeKey(activeOverride.pluginId, activeOverride.toolName));
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

  private findApprovedForTool(toolName: string): PluginToolOverrideClaimRecord | undefined {
    for (const record of this.claims.values()) {
      if (record.toolName === toolName && record.status === "approved") {
        return record;
      }
    }
    return undefined;
  }
}

function makeKey(pluginId: string, toolName: string): string {
  return `${pluginId}::${toolName}`;
}
