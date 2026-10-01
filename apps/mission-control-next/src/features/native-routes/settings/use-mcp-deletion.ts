import { useEffect, useRef, useState } from "react";
import type { McpServerRecord } from "@goatcitadel/contracts";
import type { Notice } from "../shared/native-helpers";
import { discardSessionDraft } from "../library/session-drafts";
import {
  commitMcpServerDelete,
  hasMcpServerBinding,
  isGatewayMcpServer,
  useMcpServerMutation,
} from "./mcp-server-mutation";

/** Reviewed deletion and lifecycle cancellation shared by both Settings presentations. */
export function useMcpDeletion({
  workspaceId,
  server,
  available,
  onDeleted,
  onConflict,
  onNotice,
}: {
  workspaceId: string;
  server: McpServerRecord | null;
  available: boolean;
  onDeleted: (serverId: string) => void;
  onConflict?: () => Promise<unknown>;
  onNotice?: (notice: Notice) => void;
}) {
  const identity = JSON.stringify([workspaceId, server?.serverId ?? null]);
  const scope = useRef({ identity });
  if (scope.current.identity !== identity) scope.current = { identity };
  const token = scope.current;
  const lifetime = useRef(0),
    mounted = useRef(true),
    sequence = useRef(0);
  const latestAvailable = useRef(available);
  latestAvailable.current = available;
  const [reviewState, setReview] = useState<{ token: typeof token; server: McpServerRecord } | null>(null);
  const reviewRef = useRef(reviewState);
  reviewRef.current = reviewState;
  const [noticeState, setNotice] = useState<{ token: typeof token; notice: Notice } | null>(null);
  const mutation = useMcpServerMutation(server?.serverId ?? "");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifetime.current += 1;
    };
  }, []);
  const review = reviewState?.token === token ? reviewState.server : null;
  const notify = (notice: Notice) => {
    setNotice({ token, notice });
    onNotice?.(notice);
  };
  function requestReview() {
    if (!available || !hasMcpServerBinding(server) || isGatewayMcpServer(server) || mutation.locked) return;
    sequence.current += 1;
    const next = { token, server: structuredClone(server) };
    reviewRef.current = next;
    setReview(next);
    setNotice(null);
  }
  function cancel() {
    if (mutation.phase === "saving") return;
    sequence.current += 1;
    reviewRef.current = null;
    setReview(null);
  }
  async function confirm() {
    const selected = reviewRef.current;
    if (!selected || selected.token !== token || mutation.locked) return;
    const life = lifetime.current,
      captured = sequence.current;
    const current = () =>
      mounted.current &&
      lifetime.current === life &&
      scope.current === token &&
      sequence.current === captured &&
      reviewRef.current === selected;
    const result = await commitMcpServerDelete({
      reviewed: selected.server,
      isCurrent: () => current() && latestAvailable.current,
    });
    if (result.status === "deleted") discardSessionDraft(`mcp:${workspaceId}:${result.serverId}:edit`);
    if (!current()) return;
    reviewRef.current = null;
    setReview(null);
    if (result.status === "deleted") {
      onDeleted(result.serverId);
      notify({ tone: "success", message: `MCP server ${selected.server.label} deleted and absence confirmed.` });
      return;
    }
    notify({ tone: result.status === "uncertain" ? "error" : "warning", message: result.message });
    if (["conflict", "unavailable"].includes(result.status)) await onConflict?.();
  }
  return {
    review,
    mutation,
    requestReview,
    cancel,
    confirm,
    notice: noticeState?.token === token ? noticeState.notice : null,
  };
}
