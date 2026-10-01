import { useSyncExternalStore } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
export interface BoardMutationState {
  phase: "idle" | "pending" | "uncertain";
  message?: string;
}
const idle: BoardMutationState = { phase: "idle" },
  states = new Map<string, BoardMutationState>(),
  listeners = new Set<() => void>();
export function boardMutationKey(workspaceId: string, boardId?: string) {
  return JSON.stringify(["ops-board", getGatewayApiBaseUrl(), workspaceId, boardId ?? "create"]);
}
const read = (key: string) => states.get(key) ?? idle;
const publish = (key: string, state: BoardMutationState) => {
  states.set(key, state);
  for (const listener of listeners) listener();
};
export function useBoardMutationState(workspaceId: string, boardId?: string) {
  const key = boardMutationKey(workspaceId, boardId);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => read(key),
    () => idle,
  );
}
export function admitBoardMutation(key: string) {
  if (read(key).phase !== "idle") return undefined;
  const pending: BoardMutationState = { phase: "pending" };
  publish(key, pending);
  return {
    finish: () => {
      if (read(key) === pending) publish(key, idle);
    },
    unknown: () =>
      publish(key, {
        phase: "uncertain",
        message:
          "The save outcome is unconfirmed. Further writes for this board are withheld for this app session. Review current boards before continuing.",
      }),
  };
}
export function __resetBoardMutationsForTests() {
  states.clear();
  for (const listener of listeners) listener();
}
