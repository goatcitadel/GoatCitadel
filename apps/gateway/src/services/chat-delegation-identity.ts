import { createHash } from "node:crypto";

export interface DelegationTurnIdentity {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export function buildStableDelegationId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => `${part.length}:${part}`).join("|"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

export function buildStableDelegationTurnIdentity(runId: string, stepId: string): DelegationTurnIdentity {
  return {
    turnId: buildStableDelegationId("delegation-turn", runId, stepId),
    userMessageId: buildStableDelegationId("delegation-user", runId, stepId),
    assistantMessageId: buildStableDelegationId("delegation-assistant", runId, stepId),
  };
}
