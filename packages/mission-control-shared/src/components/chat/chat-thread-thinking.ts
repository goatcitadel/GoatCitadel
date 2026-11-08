import type { ChatThreadResponse } from "@goatcitadel/contracts";

/**
 * Keep reasoning already seen by the operator when a fetched copy lags an active or resumed pass.
 * A saved value remains authoritative unless the current value extends it in the same conversation.
 */
export function carryOverStreamedThinking(
  previous: ChatThreadResponse | null,
  next: ChatThreadResponse | null,
): ChatThreadResponse | null {
  if (!previous || !next || previous === next || previous.sessionId !== next.sessionId) {
    return next;
  }
  const remembered = new Map<string, string>();
  for (const turn of previous.turns) {
    if (turn.thinking) remembered.set(turn.turnId, turn.thinking);
  }
  if (remembered.size === 0) {
    return next;
  }
  let changed = false;
  const turns = next.turns.map((turn) => {
    const thinking = remembered.get(turn.turnId);
    if (!thinking) return turn;
    if (turn.thinking && !(thinking.length > turn.thinking.length && thinking.startsWith(turn.thinking))) return turn;
    changed = true;
    return { ...turn, thinking };
  });
  return changed ? { ...next, turns } : next;
}
