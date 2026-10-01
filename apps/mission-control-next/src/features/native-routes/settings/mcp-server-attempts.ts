import { useSyncExternalStore } from "react";

export type McpServerAttempt = {
  phase: "idle" | "checking" | "saving" | "saved" | "deleted" | "uncertain";
  message?: string;
};
export const IDLE_MCP_ATTEMPT: McpServerAttempt = { phase: "idle" };
const attempts = new Map<string, McpServerAttempt>();
const listeners = new Set<() => void>();
export const readMcpServerAttempt = (id: string) => attempts.get(id) ?? IDLE_MCP_ATTEMPT;
export function writeMcpServerAttempt(id: string, value: McpServerAttempt) {
  attempts.set(id, value);
  for (const listener of listeners) listener();
}
/** Installation-wide admission is shared by edits, deletion, and connection operations in both shells. */
export function useMcpServerMutation(id: string) {
  const attempt = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => readMcpServerAttempt(id),
    () => IDLE_MCP_ATTEMPT,
  );
  return {
    ...attempt,
    pending: ["checking", "saving"].includes(attempt.phase),
    locked: ["checking", "saving", "deleted", "uncertain"].includes(attempt.phase),
  };
}
export function __resetMcpServerMutationsForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}
