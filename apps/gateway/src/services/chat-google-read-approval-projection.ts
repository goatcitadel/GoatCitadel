import {
  chatToolGrantDurationsFor,
  isGoogleWorkspaceReadTool,
  NotFoundError,
  type ChatMessageRecord,
  type ChatToolGrantDuration,
  type ChatToolRunRecord,
  type ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { isSettledToolRunContinuationEvidence } from "./chat-tool-result-projection.js";

const GRANT_DURATION_LABELS: Record<ChatToolGrantDuration, [string, string]> = {
  "15m": ["15 minutes", "15-minute"],
  "1h": ["1 hour", "1-hour"],
  "8h": ["8 hours", "8-hour"],
  "24h": ["24 hours", "24-hour"],
  "7d": ["7 days", "7-day"],
};

/** Only recognizes leading approval-status boilerplate, leaving any read results below it intact. */
function stripUnconfirmedGoogleReadApprovalLead(content: string): string {
  return content.replace(
    /^(?:(?:The (?:Google Calendar |calendar |Gmail )?read succeeded\.\s+)?No (?:approval(?: decision)?(?: or (?:new )?grant)?|(?:new )?grant) (?:was|has been) (?:confirmed|recorded|created|granted)|The (?:Google Calendar |calendar |Gmail )?read succeeded without (?:the requested )?(?:prior )?approval(?: in (?:this )?Chat)?)(?:\.(?:\s+|$)|$)/iu,
    "",
  );
}

export function reconcileGoogleReadApprovalReply(content: string, summaries: ReadonlySet<string>): string {
  const narrative = stripUnconfirmedGoogleReadApprovalLead(content.trim())
    .split("\n\n")
    .filter((paragraph) => paragraph && !summaries.has(paragraph))
    .join("\n\n");
  return [narrative, ...summaries].filter(Boolean).join("\n\n");
}

/** Read the exact approval behind a resumed Google read. Provider output does not establish operator consent. */
export async function readGoogleReadApprovalSummary(
  storage: Pick<Storage, "approvals" | "approvalEvents">,
  run: ChatToolRunRecord,
  workspaceId: string | undefined,
): Promise<string | undefined> {
  if (!run.approvalId || !isGoogleWorkspaceReadTool(run.toolName) || !isSettledToolRunContinuationEvidence(run)) {
    return undefined;
  }
  const approval = await storage.approvals.get(run.approvalId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  });
  if (
    approval?.status !== "approved" ||
    approval.kind !== run.toolName ||
    approval.linkage?.actionType !== "tool.invoke" ||
    approval.linkage.toolName !== run.toolName ||
    approval.linkage.sessionId !== run.sessionId ||
    approval.linkage.turnId !== run.turnId ||
    (workspaceId !== undefined && approval.linkage.workspaceId !== workspaceId)
  ) {
    return undefined;
  }
  const events = await storage.approvalEvents.listByApprovalId(run.approvalId);
  const resolution = [...events].reverse().find((event) => event.eventType === "resolved");
  if (resolution && resolution.payload.outcome !== "approved") return undefined;

  const service = run.toolName === "calendar.list" ? "Google Calendar" : "Gmail";
  const readSummary =
    run.status === "executed"
      ? `The ${service} read succeeded after your approval.`
      : `The ${service} read was approved and could not be completed.`;
  const allowance = resolution?.payload.chatReadAllowance;
  if (typeof allowance !== "object" || allowance === null || !("duration" in allowance)) return readSummary;
  const duration = chatToolGrantDurationsFor(run.toolName).find((value) => value === allowance.duration);
  if (!duration || !("status" in allowance)) return readSummary;
  const [length, adjective] = GRANT_DURATION_LABELS[duration];
  if (
    allowance.status === "granted" &&
    "expiresAt" in allowance &&
    typeof allowance.expiresAt === "string" &&
    Number.isFinite(Date.parse(allowance.expiresAt))
  ) {
    return `${readSummary} GoatCitadel granted ${length} of read-only access in this Chat.`;
  }
  return allowance.status === "failed"
    ? `${readSummary} GoatCitadel could not create the ${adjective} read-only grant.`
    : readSummary;
}

export async function projectHistoricalGoogleReadApproval(
  storage: Pick<Storage, "approvals" | "approvalEvents">,
  message: ChatMessageRecord | undefined,
  trace: ChatTurnTraceRecord,
): Promise<ChatMessageRecord | undefined> {
  if (
    !message ||
    message.sessionId !== trace.sessionId ||
    trace.status !== "completed" ||
    stripUnconfirmedGoogleReadApprovalLead(message.content) === message.content
  ) {
    return message;
  }
  const summaries = new Set<string>();
  for (const run of trace.toolRuns) {
    if (run.turnId !== trace.turnId || run.sessionId !== trace.sessionId) continue;
    const summary = await readGoogleReadApprovalSummary(storage, run, undefined);
    if (summary) summaries.add(summary);
  }
  if (summaries.size === 0) return message;
  return { ...message, content: reconcileGoogleReadApprovalReply(message.content, summaries) };
}
