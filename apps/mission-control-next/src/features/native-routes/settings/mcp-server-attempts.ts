import { useSyncExternalStore } from "react";
import { dispatchTrackedMutation, settleTrackedAttempt, type TrackedAttempt } from "./mutation-attempt-tracking";

/** `transport` identifies a lost write (key, method, route; never its body) so its outcome can be read. */
export type McpServerAttempt = {
  phase: "idle" | "checking" | "saving" | "saved" | "deleted" | "uncertain";
  message?: string;
  transport?: TrackedAttempt;
  checking?: boolean;
};
export const IDLE_MCP_ATTEMPT: McpServerAttempt = { phase: "idle" };
/** The Gateway routes the MCP server owners write through; a lost write on any other route is not checkable. */
export const MCP_ROUTE_PATTERNS = [
  "/api/v1/mcp/servers",
  "/api/v1/mcp/servers/:serverId",
  "/api/v1/mcp/servers/:serverId/connect-reviewed",
  "/api/v1/mcp/servers/:serverId/disconnect-reviewed",
  "/api/v1/mcp/servers/:serverId/oauth/start-reviewed",
  "/api/v1/mcp/servers/:serverId/oauth/complete-reviewed",
] as const;
const CHECKABLE = " Check its outcome to settle it from the Gateway's record of this attempt.";
const attempts = new Map<string, McpServerAttempt>();
// The identity of the write dispatched by the current operation only; cleared whenever an operation starts or settles,
// so a later lost write can never inherit an earlier write's identity.
const tracked = new Map<string, TrackedAttempt | undefined>();
const listeners = new Set<() => void>();
export const readMcpServerAttempt = (id: string) => attempts.get(id) ?? IDLE_MCP_ATTEMPT;
export function writeMcpServerAttempt(id: string, value: McpServerAttempt) {
  let next = value;
  if (value.phase === "uncertain" && !value.transport) {
    const transport = tracked.get(id);
    if (transport) next = { ...value, transport, message: `${value.message ?? ""}${CHECKABLE}` };
  }
  if (value.phase !== "uncertain") tracked.delete(id);
  attempts.set(id, next);
  for (const listener of listeners) listener();
}
/** Every MCP server write goes through here so a lost response leaves the identity of the attempt behind. */
export function trackMcpWrite<T>(id: string, dispatch: () => Promise<T>): Promise<T> {
  return dispatchTrackedMutation(MCP_ROUTE_PATTERNS, dispatch, (attempt) => tracked.set(id, attempt));
}
/**
 * Settles an uncertain server write from the Gateway's record of that exact attempt and the canonical server (that server's own read)
 * `readback`. Only a committed or released attempt unlocks; anything else keeps the lock. Returns the settled notice.
 */
export async function checkMcpServerOutcome(id: string, readback: () => Promise<unknown>) {
  const current = readMcpServerAttempt(id);
  if (current.phase !== "uncertain" || !current.transport || current.checking) return undefined;
  const checking = { ...current, checking: true };
  attempts.set(id, checking);
  for (const listener of listeners) listener();
  const result = await settleTrackedAttempt(current.transport, readback, "MCP change");
  if (attempts.get(id) !== checking) return undefined;
  attempts.set(id, result.settled ? IDLE_MCP_ATTEMPT : { ...current, message: result.message });
  for (const listener of listeners) listener();
  return result.settled ? result.message : undefined;
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
  tracked.clear();
  for (const listener of listeners) listener();
}
