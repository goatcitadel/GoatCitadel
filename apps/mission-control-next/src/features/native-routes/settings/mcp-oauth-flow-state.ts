import { useSyncExternalStore } from "react";
import type { McpReviewedOAuthStartResponse } from "@goatcitadel/contracts";

// An app-session handshake acknowledgement is not authentication authority. Codes are never retained here.
const flows = new Map<string, McpReviewedOAuthStartResponse>();
const listeners = new Set<() => void>();
export const readMcpOAuthFlow = (id: string) => flows.get(id);
export function writeMcpOAuthFlow(id: string, flow?: McpReviewedOAuthStartResponse) {
  if (flow) flows.set(id, structuredClone(flow));
  else flows.delete(id);
  for (const listener of listeners) listener();
}
export function useMcpOAuthFlow(id: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => readMcpOAuthFlow(id),
    () => undefined,
  );
}
export function __resetMcpOAuthFlowsForTests() {
  flows.clear();
  for (const listener of listeners) listener();
}
