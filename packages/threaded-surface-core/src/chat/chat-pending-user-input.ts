import type { ChatThreadResponse, ChatUserInputPromptRecord } from "@goatcitadel/contracts";

export type PendingUserInputRecord = ChatUserInputPromptRecord;

export function deriveThreadPendingUserInput(thread: ChatThreadResponse | null): PendingUserInputRecord | null {
  if (!thread) {
    return null;
  }
  const selectedTurn =
    thread.turns.find((turn) => turn.turnId === (thread.selectedTurnId ?? thread.activeLeafTurnId)) ??
    thread.turns.at(-1) ??
    null;
  if (
    !selectedTurn ||
    (selectedTurn.trace.status !== "waiting_for_user_input" &&
      !(
        (selectedTurn.trace.status === "running" || selectedTurn.trace.status === "waiting_for_tool") &&
        selectedTurn.trace.pendingUserInput?.delivery === "background" &&
        selectedTurn.trace.pendingUserInput.required === false &&
        selectedTurn.trace.pendingUserInput.secureConfiguration === undefined &&
        Date.parse(selectedTurn.trace.pendingUserInput.expiresAt ?? "") > Date.now()
      ))
  ) {
    return null;
  }
  return selectedTurn.trace.pendingUserInput ?? null;
}

export function mergePendingUserInput(
  current: PendingUserInputRecord | null,
  next: PendingUserInputRecord | null,
): PendingUserInputRecord | null {
  if (!next) {
    return current;
  }
  if (!current || current.promptId !== next.promptId) {
    return next;
  }
  return {
    ...current,
    ...next,
    options: next.options ?? current.options,
  };
}
