import { createHash } from "node:crypto";
import type { ChatCompactionDimension } from "./chat-message-history-service.js";
import type { ChatTurnSessionState } from "./chat-turn-prep-service.js";

interface ExactFirstProviderUsage {
  turnId: string;
  inputTokens: number;
  observedTurnCount: number;
}

export function resolveExactFirstProviderUsage(
  state: ChatTurnSessionState | undefined,
  branchTurnIds: string[],
  dimension: ChatCompactionDimension,
  afterTurnId?: string,
): ExactFirstProviderUsage | undefined {
  if (!state || !dimension.providerId || !dimension.model) {
    return undefined;
  }
  const evidenceIndex = branchTurnIds.length - 1;
  const afterIndex = afterTurnId === undefined ? -1 : branchTurnIds.lastIndexOf(afterTurnId);
  if (evidenceIndex < 0 || (afterTurnId !== undefined && (afterIndex < 0 || evidenceIndex <= afterIndex))) {
    return undefined;
  }
  const turnId = branchTurnIds[evidenceIndex]!;
  const trace = state.tracesById.get(turnId);
  if (trace?.status !== "completed") {
    return undefined;
  }
  const usage = trace.completion?.firstProviderRequestUsage;
  if (
    usage?.source !== "provider_reported" ||
    usage.availability !== "reported" ||
    usage.compactionDimensionHash !== dimension.dimensionHash ||
    usage.providerId !== dimension.providerId ||
    usage.model !== dimension.model ||
    !Number.isSafeInteger(usage.reportedInputTokens) ||
    usage.reportedInputTokens! < 0 ||
    usage.effectiveInputTokens !== usage.reportedInputTokens
  ) {
    // The dimension hash seals the provider/model/profile fingerprint. A
    // deterministic estimate, mismatched route, failed turn, or malformed
    // provider receipt is never allowed to judge breaker effectiveness.
    return undefined;
  }
  return {
    turnId,
    inputTokens: usage.reportedInputTokens,
    observedTurnCount: branchTurnIds.length,
  };
}

export function buildLegacyCompactionDimension(
  providerId: string | undefined,
  model: string | undefined,
): ChatCompactionDimension {
  const dimensionSource = JSON.stringify({
    version: 1,
    providerId: providerId ?? null,
    model: model ?? null,
    profile: null,
  });
  return {
    dimensionHash: createHash("sha256").update(dimensionSource).digest("hex"),
    providerId,
    model,
  };
}
