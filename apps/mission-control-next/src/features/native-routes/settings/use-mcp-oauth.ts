import { useLayoutEffect, useRef, useState } from "react";
import { canonicalJsonString, type McpServerRecord } from "@goatcitadel/contracts";
import { fetchMcpServer } from "@goatcitadel/mission-control-shared/api/client";
import { mcpConnectionReviewMatches } from "./mcp-connection-mutation";
import { mcpOAuthUnavailable } from "./mcp-oauth-binding";
import { useMcpOAuthFlow } from "./mcp-oauth-flow-state";
import { commitMcpOAuth, type McpOAuthAction } from "./mcp-oauth-mutation";
import { useMcpServerMutation } from "./mcp-server-attempts";

export function useMcpOAuth({
  server,
  scope,
  onSettled,
}: {
  server: McpServerRecord;
  scope: string;
  onSettled: () => Promise<unknown>;
}) {
  const identity = canonicalJsonString([scope, server]);
  const live = useRef({ identity, epoch: 0, operation: 0, mounted: true, busy: false });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.epoch++;
    live.current.operation++;
  }
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.operation++;
    };
  }, []);
  const epoch = live.current.epoch;
  const [input, setInput] = useState({ epoch, code: "", state: "" });
  const [view, setView] = useState<{
    epoch: number;
    message?: string;
    review?: { server: McpServerRecord; action: McpOAuthAction };
  }>({ epoch });
  const [checking, setChecking] = useState(false);
  const attempt = useMcpServerMutation(server.serverId),
    retained = useMcpOAuthFlow(server.serverId);
  const flow = retained && mcpConnectionReviewMatches(server, retained.review.server) ? retained : undefined;
  const fields = input.epoch === epoch ? input : { code: "", state: "" };
  const visible = view.epoch === epoch ? view : undefined;
  const current = (operation: number) =>
    live.current.mounted &&
    live.current.epoch === epoch &&
    live.current.identity === identity &&
    live.current.operation === operation;
  function edit(field: "code" | "state", value: string) {
    live.current.operation++;
    setInput({ ...fields, epoch, [field]: value });
    setView({ epoch });
  }
  async function requestReview(action: McpOAuthAction) {
    if (live.current.busy || attempt.locked || mcpOAuthUnavailable(server)) return;
    if (action === "complete" && (!flow || fields.state !== flow.state || !fields.code.trim())) {
      setView({
        epoch,
        message: "Enter the code and the exact returned state for this current authorization request.",
      });
      return;
    }
    const operation = ++live.current.operation;
    live.current.busy = true;
    setChecking(true);
    setView({ epoch });
    try {
      const fresh = await fetchMcpServer(server.serverId);
      if (!current(operation)) return;
      if (!mcpConnectionReviewMatches(server, fresh) || mcpOAuthUnavailable(fresh)) {
        setView({ epoch, message: "The server changed. Refresh this inspection before reviewing authorization." });
        return;
      }
      setView({ epoch, review: { action, server: structuredClone(fresh) } });
    } catch {
      if (current(operation)) setView({ epoch, message: "Current OAuth metadata could not be read." });
    } finally {
      live.current.busy = false;
      if (live.current.mounted) setChecking(false);
    }
  }
  function cancel() {
    if (attempt.phase === "saving") return;
    live.current.operation++;
    setView({ epoch });
    setInput({ epoch, code: "", state: "" });
  }
  async function confirm() {
    const review = visible?.review;
    if (!review || live.current.busy || attempt.locked) return;
    const operation = live.current.operation;
    live.current.busy = true;
    setChecking(true);
    try {
      const result = await commitMcpOAuth({
        reviewed: review.server,
        action: review.action,
        code: fields.code,
        state: fields.state,
        isCurrent: () => current(operation),
        onDispatch: () => {
          if (current(operation)) setInput({ epoch, code: "", state: "" });
        },
      });
      if (!current(operation)) return;
      setView({ epoch, message: result.status === "saved" ? undefined : result.message });
      if (result.status === "saved") {
        try {
          await onSettled();
        } catch {
          /* Receipt and independent readback remain recorded. */
        }
      }
    } finally {
      live.current.busy = false;
      if (live.current.mounted) setChecking(false);
    }
  }
  return {
    flow,
    fields,
    edit,
    review: visible?.review,
    message: visible?.message ?? attempt.message,
    attempt,
    checking,
    requestReview,
    cancel,
    confirm,
  };
}
