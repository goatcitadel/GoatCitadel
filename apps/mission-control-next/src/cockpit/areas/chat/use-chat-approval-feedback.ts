import { useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApprovalRequest, ChatThreadTurnRecord, ChatToolRunRecord, ToolGrantRecord } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { nullWhenMissing } from "../inbox/inbox-record-read";

const inlineReadTitles = new Map([
  ["browser.storage.get", "Browser storage read"],
  ["memory.search", "Memory search"],
  ["browser.search", "Browser search"],
]);

function isMcpRequest(run: ChatToolRunRecord): boolean {
  return run.toolName.startsWith("mcp.");
}

function inlineReadTitle(run: ChatToolRunRecord, approval?: ApprovalRequest | null): string | undefined {
  if (!isMcpRequest(run)) return inlineReadTitles.get(run.toolName);
  if (
    approval?.approvalId === run.approvalId &&
    approval?.kind === run.toolName &&
    approval.linkage?.sessionId === run.sessionId &&
    approval.linkage.turnId === run.turnId &&
    approval.preview?.reviewKind === "mcp.operation" &&
    approval.preview.mcpReadOnlyHint === true
  ) {
    return "MCP request";
  }
}

function browserStorageCompletion(result: ChatToolRunRecord["result"]): string {
  if (result?.action !== "storage.get" || typeof result.origin !== "string") return "Read complete";
  const buckets = {
    local: [result.localStorage],
    session: [result.sessionStorage],
    both: [result.localStorage, result.sessionStorage],
  };
  const { storage } = result;
  if (storage !== "local" && storage !== "session" && storage !== "both") return "Read complete";
  const selectedBuckets = buckets[storage];
  if (selectedBuckets.some((bucket) => !bucket || typeof bucket !== "object" || Array.isArray(bucket))) {
    return "Read complete";
  }
  const count = selectedBuckets.reduce<number>((total, bucket) => total + Object.keys(bucket as object).length, 0);
  return `Read complete · ${plural(count, "key")}`;
}

function inlineReadStatus(
  run: ChatToolRunRecord,
  turnStatus: ChatThreadTurnRecord["trace"]["status"],
  approved: boolean,
): string | undefined {
  if (run.status === "executed") {
    if (turnStatus === "queued" || turnStatus === "running" || turnStatus === "waiting_for_tool") {
      return "Resuming this turn…";
    }
    if (run.toolName === "browser.storage.get") return browserStorageCompletion(run.result);
    if (isMcpRequest(run)) {
      if (run.result?.externalOutcome === "unknown_after_send") return "Request outcome unknown";
      if (run.result?.ok === false) return "Request did not complete";
      if (run.result?.ok !== true) return "Request outcome unknown";
      const items = run.result.contentItems;
      return Array.isArray(items) ? `Request complete · ${plural(items.length, "item")}` : "Request complete";
    }
    if (run.toolName === "browser.search" && run.result?.backend === "official" && run.result.backendUsed === false) {
      return "Search did not complete";
    }
    const results = run.toolName === "memory.search" ? run.result?.items : run.result?.results;
    return Array.isArray(results) ? `Search complete · ${plural(results.length, "result")}` : "Search complete";
  }
  if (!approved && run.status !== "started") return undefined;
  if (
    run.status === "blocked" ||
    run.status === "failed" ||
    turnStatus === "completed" ||
    turnStatus === "partial" ||
    turnStatus === "failed" ||
    turnStatus === "cancelled"
  ) {
    if (isMcpRequest(run)) return "Request did not complete";
    return run.toolName === "browser.storage.get" ? "Read did not complete" : "Search did not complete";
  }
  return "Resuming this turn…";
}

export function useChatApprovalFeedback(
  workspaceId: string,
  sessionId: string | null | undefined,
  approvalId: string | undefined,
  latestTurn: ChatThreadTurnRecord | undefined,
) {
  const [approvedRead, setApprovedRead] = useState<{
    workspaceId: string;
    turnId: string;
    toolRunId: string;
  }>();
  const linkedRead =
    latestTurn && latestTurn.trace.sessionId === sessionId
      ? latestTurn.toolRuns
          .filter(
            (run) =>
              run.turnId === latestTurn.turnId &&
              run.sessionId === sessionId &&
              (inlineReadTitles.has(run.toolName) || isMcpRequest(run)) &&
              run.approvalId &&
              (!approvalId || run.approvalId === approvalId),
          )
          .at(-1)
      : undefined;
  const recordId = approvalId ?? (linkedRead && isMcpRequest(linkedRead) ? linkedRead.approvalId : undefined);
  const recordQuery = useQuery({
    // The same key as the Inbox approval detail, so moving between them is a cache hit (IN-11).
    queryKey: ["approvals", "record", workspaceId, recordId],
    queryFn: ({ signal }) => nullWhenMissing(fetchApproval(recordId!, { workspaceId, signal })),
    enabled: Boolean(recordId),
    staleTime: 0,
  });
  const readTitle = linkedRead && inlineReadTitle(linkedRead, recordQuery.data);
  const readStatus =
    latestTurn && linkedRead
      ? inlineReadStatus(
          linkedRead,
          latestTurn.trace.status,
          approvedRead?.workspaceId === workspaceId &&
            approvedRead.turnId === latestTurn.turnId &&
            approvedRead.toolRunId === linkedRead.toolRunId,
        )
      : undefined;
  const [receipt, setReceipt] = useState<{ scope: string; message: string }>();
  const noticeScope = JSON.stringify([workspaceId, sessionId, approvalId]);
  const notice = receipt?.scope === noticeScope ? receipt.message : "";
  const gateway = getGatewayApiBaseUrl();
  const accessRevision = getGatewayAccessRevision();
  const callerRevision = getGatewayCallerScopeRevision();
  const chatAccessScope = JSON.stringify([workspaceId, sessionId, gateway, accessRevision, callerRevision]);
  const committedChatScope = useRef<string | undefined>(chatAccessScope);
  useLayoutEffect(() => {
    committedChatScope.current = chatAccessScope;
    return () => {
      committedChatScope.current = undefined;
    };
  }, [chatAccessScope]);
  const [otherTabReceipt, setOtherTabReceipt] = useState<{
    scope: string;
    approvalId: string;
    turnId?: string;
    message: string;
  }>();
  const [temporaryGrantReceipt, setTemporaryGrantReceipt] = useState<{
    scope: string;
    approvalId: string;
    turnId?: string;
    message: string;
    grant?: ToolGrantRecord;
  }>();
  const temporaryGrantNotice =
    temporaryGrantReceipt?.scope === chatAccessScope &&
    (latestTurn ? temporaryGrantReceipt.turnId === latestTurn.turnId : temporaryGrantReceipt.approvalId === approvalId)
      ? temporaryGrantReceipt
      : undefined;
  function currentChatAccess() {
    return (
      committedChatScope.current === chatAccessScope &&
      gateway === getGatewayApiBaseUrl() &&
      accessRevision === getGatewayAccessRevision() &&
      callerRevision === getGatewayCallerScopeRevision()
    );
  }
  const otherTabNotice =
    otherTabReceipt?.scope === chatAccessScope &&
    (approvalId
      ? otherTabReceipt.approvalId === approvalId
      : latestTurn?.trace.sessionId === sessionId && otherTabReceipt.turnId === latestTurn?.turnId)
      ? otherTabReceipt.message
      : undefined;
  const reviewScope = JSON.stringify([noticeScope, gateway, accessRevision, callerRevision]);
  const reviewSequence = useRef(0);
  const [reviewRefresh, setReviewRefresh] = useState<{
    scope: string;
    sequence: number;
    phase: "checking" | "ready" | "failed";
  }>();
  const rereview = reviewRefresh?.scope === reviewScope ? reviewRefresh : undefined;
  const refreshMcpReview = async () => {
    const sequence = ++reviewSequence.current;
    setReviewRefresh({ scope: reviewScope, sequence, phase: "checking" });
    const result = await recordQuery.refetch();
    if (
      gateway !== getGatewayApiBaseUrl() ||
      accessRevision !== getGatewayAccessRevision() ||
      callerRevision !== getGatewayCallerScopeRevision()
    )
      return;
    const ready = result.isSuccess && result.data?.approvalId === approvalId;
    setReviewRefresh((current) =>
      current?.sequence === sequence ? { ...current, phase: ready ? "ready" : "failed" } : current,
    );
  };
  const announcement = [
    otherTabNotice,
    temporaryGrantNotice?.grant ? null : temporaryGrantNotice?.message,
    readTitle ? readStatus : null,
    notice,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    announcement,
    linkedRead,
    readTitle,
    readStatus,
    recordQuery,
    noticeScope,
    notice,
    setReceipt,
    currentChatAccess,
    chatAccessScope,
    otherTabNotice,
    setOtherTabReceipt,
    temporaryGrantNotice,
    setTemporaryGrantReceipt,
    rereview,
    refreshMcpReview,
    setApprovedRead,
  };
}

export function errandScreenshotAttachmentId(preview: Record<string, unknown> | undefined): string | undefined {
  const id = preview?.screenshotAttachmentId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}
