import { useEffect, useRef, useState } from "react";
import { canonicalJsonString, type McpServerRecord, type McpServerUpdateRequest } from "@goatcitadel/contracts";
import { useSessionDraft } from "../library/session-drafts";
import type { Notice } from "../shared/native-helpers";
import { createMcpEditForm } from "./sections/mcp-editor-drafts";
import { useMcpServerReview } from "./sections/useMcpServerReview";
import { commitMcpServerUpdate, isGatewayMcpServer, useMcpServerMutation } from "./mcp-server-mutation";
import { mcpLines, reviewedMcpPolicy } from "./mcp-policy-fields";

/** Retained drafts, owner review and CAS save shared by both Settings presentations. */
export function useMcpEditor({
  workspaceId,
  serverId,
  server,
  active,
  available = true,
  runtimeReady,
  applyServer,
  onNotice,
  onSaveRequest,
}: {
  workspaceId: string;
  serverId: string;
  server: McpServerRecord | null;
  active: boolean;
  available?: boolean;
  runtimeReady: boolean;
  applyServer: (serverId: string, server: McpServerRecord | null) => void;
  onNotice?: (notice: Notice) => void;
  onSaveRequest?: (() => Promise<boolean>) | null;
}) {
  const identity = JSON.stringify([workspaceId, serverId]);
  const scope = useRef({ identity, epoch: 0 });
  if (scope.current.identity !== identity) scope.current = { identity, epoch: scope.current.epoch + 1 };
  const scopeToken = scope.current;
  const mounted = useRef(true);
  const lifetime = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifetime.current += 1;
    };
  }, []);
  const [noticeState, setNoticeState] = useState<{ token: typeof scopeToken; notice: Notice } | null>(null);
  const notify = (notice: Notice) => {
    setNoticeState({ token: scopeToken, notice });
    onNotice?.(notice);
  };
  const review = useMcpServerReview(workspaceId, serverId, applyServer);
  const draft = useSessionDraft(`mcp:${workspaceId}:${serverId}:edit`, createMcpEditForm(server), server?.revision, {
    label: server?.label ?? "MCP server",
    active,
    available: available && Boolean(server),
    // Native field review must happen in its editor; null intentionally withholds leave-dialog saving.
    onSave: onSaveRequest === null ? undefined : (onSaveRequest ?? (() => save())),
  });
  const mutation = useMcpServerMutation(serverId);
  const editorIdentity = JSON.stringify([identity, active, available, draft.value]);
  const editorGeneration = useRef({ identity: editorIdentity });
  if (editorGeneration.current.identity !== editorIdentity) editorGeneration.current = { identity: editorIdentity };
  const requiresReview = review.required || draft.hasRemoteChanges;
  const gatewayOwned = Boolean(server && isGatewayMcpServer(server));
  const canSave = active && available && Boolean(server) && !gatewayOwned && !mutation.locked && !requiresReview;
  const acceptReview = () => {
    if (review.isCurrent() && server?.revision && !review.loading && !review.error && !review.missing) {
      draft.rebaseToCurrent();
      review.accept();
      notify({ tone: "info", message: "Current server reviewed. Save your draft or choose Delete again when ready." });
    }
  };
  async function save(): Promise<boolean> {
    if (!server || gatewayOwned || !active || !available || mutation.locked) return false;
    if (requiresReview || !/^[a-f0-9]{64}$/.test(String(draft.baseRevision ?? ""))) {
      notify({
        tone: "warning",
        message: "The server configuration changed. Review it before applying your retained draft.",
      });
      if (!requiresReview) await review.refresh();
      return false;
    }
    const submitted = draft.value;
    let extra: Pick<McpServerUpdateRequest, "args" | "policy">;
    try {
      extra = {
        ...(canonicalJsonString(submitted.args) !== canonicalJsonString(server.args ?? [])
          ? { args: mcpLines(submitted.args) }
          : {}),
        ...(canonicalJsonString(submitted.policy) !== canonicalJsonString(server.policy)
          ? { policy: reviewedMcpPolicy(submitted.policy) }
          : {}),
      };
    } catch (error) {
      notify({ tone: "warning", message: error instanceof Error ? error.message : "Review the MCP policy fields." });
      return false;
    }
    const generation = editorGeneration.current;
    const life = lifetime.current;
    const isScopeCurrent = () => mounted.current && lifetime.current === life && scope.current === scopeToken;
    const result = await commitMcpServerUpdate({
      reviewed: server,
      input: {
        expectedRevision: String(draft.baseRevision),
        label: submitted.label.trim() || undefined,
        command: server.transport === "stdio" ? submitted.command.trim() : undefined,
        url: server.transport !== "stdio" ? submitted.url.trim() || undefined : undefined,
        enabled: runtimeReady ? submitted.enabled : false,
        category: submitted.category,
        ...extra,
      },
      isCurrent: () => isScopeCurrent() && editorGeneration.current === generation,
    });
    if (result.status !== "saved") {
      // A newer editor must not inherit an old preflight's status or start its review flow.
      if (!isScopeCurrent() || editorGeneration.current !== generation) return false;
      notify({ tone: result.status === "uncertain" ? "error" : "warning", message: result.message });
      if (["conflict", "unavailable", "uncertain"].includes(result.status)) await review.refresh();
      return false;
    }
    const clean = draft.acceptSaved(createMcpEditForm(result.server), result.server.revision, submitted);
    if (!isScopeCurrent()) return clean;
    applyServer(result.server.serverId, result.server);
    if (editorGeneration.current === generation) notify({ tone: "success", message: "MCP server updated." });
    return clean;
  }
  return {
    draft,
    review,
    mutation,
    requiresReview,
    gatewayOwned,
    canSave,
    save,
    acceptReview,
    notice: noticeState?.token === scopeToken ? noticeState.notice : null,
  };
}
