import type { ChatThreadResponse, ChatThreadTurnRecord } from "@goatcitadel/contracts";

export function resolveActiveWorkflowTurn(thread: ChatThreadResponse | null): ChatThreadTurnRecord | null {
  if (!thread?.turns.length) {
    return null;
  }
  const activeTurnId = thread.activeLeafTurnId ?? thread.turns.at(-1)?.turnId;
  return thread.turns.find((turn) => turn.turnId === activeTurnId) ?? thread.turns.at(-1) ?? null;
}
