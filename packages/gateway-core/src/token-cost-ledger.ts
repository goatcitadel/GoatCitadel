import type { CostLedgerRepository } from "@goatcitadel/storage";

export interface UsageInput {
  sessionId: string;
  agentId?: string;
  taskId?: string;
  providerId?: string;
  modelId?: string;
  credentialType?: "api_key" | "oauth" | "unknown";
  usagePool?: "standard" | "subscription" | "unknown";
  tokenInput?: number;
  tokenOutput?: number;
  tokenCachedInput?: number;
  costUsd?: number;
  timestamp: string;
}

export class TokenCostLedger {
  public constructor(private readonly repo: CostLedgerRepository) {}

  public record(input: UsageInput): boolean {
    const knownMetrics = [
      input.tokenInput === undefined ? undefined : "input",
      input.tokenOutput === undefined ? undefined : "output",
      input.tokenCachedInput === undefined ? undefined : "cached",
      input.costUsd === undefined ? undefined : "cost",
    ].filter((metric): metric is string => metric !== undefined);
    const hasUsageEvidence =
      knownMetrics.length > 0 || Boolean(input.providerId || input.modelId || input.credentialType || input.usagePool);
    if (!hasUsageEvidence) {
      return false;
    }
    this.repo.insert({
      sessionId: input.sessionId,
      agentId: input.agentId,
      taskId: input.taskId,
      providerId: input.providerId,
      modelId: input.modelId,
      credentialType: input.credentialType,
      usagePool: input.usagePool,
      tokenInput: input.tokenInput ?? 0,
      tokenOutput: input.tokenOutput ?? 0,
      tokenCachedInput: input.tokenCachedInput ?? 0,
      costUsd: input.costUsd ?? 0,
      createdAt: input.timestamp,
      usageKnownMask: knownMetrics.join(","),
    });
    return true;
  }
}
