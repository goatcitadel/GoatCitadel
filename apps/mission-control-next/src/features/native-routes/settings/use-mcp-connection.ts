import { useLayoutEffect, useRef, useState } from "react";
import { canonicalJsonString, type McpServerRecord } from "@goatcitadel/contracts";
import { fetchMcpServer } from "@goatcitadel/mission-control-shared/api/client";
import { useMcpServerMutation } from "./mcp-server-attempts";
import {
  commitMcpConnection,
  mcpConnectionReviewMatches,
  mcpConnectionUnavailable,
  type McpConnectionAction,
} from "./mcp-connection-mutation";

export function useMcpConnection({
  server,
  scope,
  onSettled,
}: {
  server: McpServerRecord;
  scope: string;
  onSettled: () => Promise<unknown>;
}) {
  const identity = canonicalJsonString([scope, server]);
  const live = useRef({ identity, generation: 0, mounted: true, busy: false });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.generation += 1;
  }
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.generation += 1;
    };
  }, []);
  const [state, setState] = useState<{
    identity: string;
    review?: { action: McpConnectionAction; server: McpServerRecord };
    message?: string;
  }>({ identity });
  const [checking, setChecking] = useState(false);
  const attempt = useMcpServerMutation(server.serverId);
  const visible = state.identity === identity ? state : undefined;
  const current = (generation: number) =>
    live.current.mounted && live.current.generation === generation && live.current.identity === identity;
  async function requestReview(action: McpConnectionAction) {
    if (live.current.busy || attempt.locked || mcpConnectionUnavailable(server, action)) return;
    const generation = ++live.current.generation;
    live.current.busy = true;
    setChecking(true);
    setState({ identity });
    try {
      const fresh = await fetchMcpServer(server.serverId);
      if (!current(generation)) return;
      if (!mcpConnectionReviewMatches(server, fresh) || mcpConnectionUnavailable(fresh, action)) {
        setState({
          identity,
          message: "The server changed. Refresh this inspection before reviewing a connection action.",
        });
        return;
      }
      setState({ identity, review: { action, server: structuredClone(fresh) } });
    } catch {
      if (current(generation)) setState({ identity, message: "Current connection metadata could not be read." });
    } finally {
      live.current.busy = false;
      if (live.current.mounted) setChecking(false);
    }
  }
  function cancel() {
    if (attempt.phase === "saving") return;
    live.current.generation += 1;
    setState({ identity });
  }
  async function confirm() {
    const review = visible?.review;
    if (!review || live.current.busy || attempt.locked) return;
    const generation = live.current.generation;
    live.current.busy = true;
    setChecking(true);
    try {
      const result = await commitMcpConnection({
        reviewed: review.server,
        action: review.action,
        isCurrent: () => current(generation),
      });
      if (!current(generation)) return;
      setState({ identity, message: result.status === "saved" ? undefined : result.message });
      if (result.status === "saved") {
        try {
          await onSettled();
        } catch {
          /* Preserve the canonical receipt and independent readback. */
        }
      }
    } finally {
      live.current.busy = false;
      if (live.current.mounted) setChecking(false);
    }
  }
  return {
    review: visible?.review,
    message: visible?.message ?? attempt.message,
    checking,
    attempt,
    requestReview,
    cancel,
    confirm,
  };
}
