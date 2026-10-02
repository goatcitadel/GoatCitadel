import { useLayoutEffect, useRef, useState } from "react";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { fetchMcpServer } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isRuntimeInvokableMcpServer } from "./helpers/mcp-helpers";
import {
  commitMcpServerUpdate,
  hasMcpServerBinding,
  isGatewayMcpServer,
  mcpServerReviewMatches,
  useMcpServerMutation,
} from "./mcp-server-mutation";

export function mcpToggleUnavailableReason(server: McpServerRecord) {
  if (isGatewayMcpServer(server)) return "This server is managed by the Gateway.";
  if (!hasMcpServerBinding(server)) return "Current server identity or revision is unavailable.";
  if (!server.enabled && !isRuntimeInvokableMcpServer(server))
    return "Transport, trust, or authentication setup is incomplete. Review server setup before enabling.";
  return undefined;
}
export function useMcpEnabled({
  workspaceId,
  available,
  reload,
}: {
  workspaceId: string;
  available: boolean;
  reload: () => Promise<unknown>;
}) {
  const [review, setReview] = useState<{ server: McpServerRecord; enabled: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useMcpServerMutation(review?.server.serverId ?? "");
  const live = useRef({ workspaceId, available, epoch: 0, mounted: true, busy: false });
  if (live.current.workspaceId !== workspaceId || live.current.available !== available) live.current.epoch += 1;
  live.current.workspaceId = workspaceId;
  live.current.available = available;
  useLayoutEffect(() => {
    const lifecycle = live.current;
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.epoch += 1;
    };
  }, []);
  useLayoutEffect(() => {
    setReview(null);
    setNotice(null);
  }, [workspaceId]);
  const current = (epoch: number) => live.current.mounted && live.current.epoch === epoch && live.current.available;
  async function requestReview(server: McpServerRecord) {
    if (!available || live.current.busy || mcpToggleUnavailableReason(server)) return;
    const epoch = ++live.current.epoch;
    live.current.busy = true;
    setChecking(true);
    setReview(null);
    setNotice(null);
    try {
      const saved = await fetchMcpServer(server.serverId);
      if (!current(epoch)) return;
      if (!mcpServerReviewMatches(server, saved) || mcpToggleUnavailableReason(saved)) {
        setNotice("The MCP server changed. Refresh and review the current saved configuration.");
        await reload();
        return;
      }
      setReview({ server: structuredClone(saved), enabled: !saved.enabled });
    } catch (error) {
      if (current(epoch)) setNotice(`MCP review unavailable: ${describeApiError(error).summary}`);
    } finally {
      live.current.busy = false;
      if (live.current.mounted) setChecking(false);
    }
  }
  function cancel() {
    if (attempt.phase === "saving") return;
    live.current.epoch += 1;
    setReview(null);
  }
  async function confirm() {
    if (!review || !available || live.current.busy || attempt.locked) return;
    const requested = review;
    const epoch = live.current.epoch;
    live.current.busy = true;
    setChecking(true);
    setNotice(null);
    try {
      const result = await commitMcpServerUpdate({
        reviewed: requested.server,
        input: { expectedRevision: requested.server.revision!, enabled: requested.enabled },
        isCurrent: () => current(epoch),
      });
      if (!current(epoch)) return;
      if (result.status === "saved") {
        setNotice(
          `MCP server ${result.server.label} ${result.server.enabled ? "enabled" : "disabled"}. Saved configuration confirmed; connectivity and tool permission are separate.`,
        );
        setReview(null);
      } else {
        setNotice(result.message);
        if (["conflict", "cancelled"].includes(result.status)) setReview(null);
      }
      try {
        await reload();
      } catch {
        /* Preserve canonical acknowledgement when the directory refresh fails. */
      }
    } finally {
      live.current.busy = false;
      if (live.current.mounted) setChecking(false);
    }
  }
  return { review, checking, notice, attempt, requestReview, cancel, confirm };
}
