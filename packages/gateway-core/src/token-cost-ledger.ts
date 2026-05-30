import type { CostLedgerRepository } from "@goatcitadel/storage";

export interface UsageInput {
  sessionId: string;
  agentId?: string;
  taskId?: string;
  providerId?: string;
  modelId?: string;
  tokenInput?: number;
  tokenOutput?: number;
  tokenCachedInput?: number;
  costUsd?: number;
  timestamp: string;
}

export class TokenCostLedger {
  public constructor(private readonly repo: CostLedgerRepository) {}

  public record(input: UsageInput): void {
    this.repo.insert({
      sessionId: input.sessionId,
      agentId: input.agentId,
      taskId: input.taskId,
      providerId: input.providerId,
      modelId: input.modelId,
      tokenInput: input.tokenInput ?? 0,
      tokenOutput: input.tokenOutput ?? 0,
      tokenCachedInput: input.tokenCachedInput ?? 0,
      costUsd: input.costUsd ?? 0,
      createdAt: input.timestamp,
    });
  }
}
