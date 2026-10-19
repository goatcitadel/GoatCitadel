import {
  isOutsideRootWriteGrantDuration,
  type OutsideRootWriteApprovalDetails,
  type OutsideRootWriteGrantChoice,
  type OutsideRootWriteGrantDuration,
  type ToolGrantRecord,
} from "@goatcitadel/contracts";

/** The folder an operator chose on an outside-root write approval; owned by contracts. */
export type ChatApprovalWriteGrantChoice = OutsideRootWriteGrantChoice;

/** The slice of the policy engine this owner needs. */
export interface ChatApprovalWriteGrantEngine {
  describeOutsideRootWriteApproval(approvalId: string): Promise<OutsideRootWriteApprovalDetails | undefined>;
  mintOutsideRootWriteGrant(input: {
    approvalId: string;
    rootId: string;
    duration: OutsideRootWriteGrantDuration;
    scope: "session" | "workspace";
    scopeRef: string;
    createdBy: string;
  }): Promise<ToolGrantRecord>;
}

/**
 * Validate an approve/deny request against an outside-root write approval
 * before anything is resolved. An outside-root write can be approved once, or
 * open exactly one server-offered folder; it never falls back to the
 * unconstrained session or workspace grant other approvals use.
 */
export async function resolveOutsideRootWriteApprovalChoice(
  engine: ChatApprovalWriteGrantEngine,
  input: {
    approvalId: string;
    decision: "approve" | "reject";
    allowScope: "once" | "session" | "workspace";
    writeGrant?: ChatApprovalWriteGrantChoice;
  },
): Promise<OutsideRootWriteApprovalDetails | undefined> {
  const details = await engine.describeOutsideRootWriteApproval(input.approvalId);
  if (input.writeGrant) {
    if (!details) throw new Error("This approval cannot open a folder.");
    if (input.decision !== "approve" || input.allowScope === "once") {
      throw new Error("Opening a folder needs an approval scoped to this chat or this workspace.");
    }
    if (!isOutsideRootWriteGrantDuration(input.writeGrant.duration)) {
      throw new Error("Unsupported folder-grant duration.");
    }
    if (!details.candidates.some((candidate) => candidate.rootId === input.writeGrant?.rootId)) {
      throw new Error("The chosen folder is not offered by this approval.");
    }
  } else if (details && input.decision === "approve" && input.allowScope !== "once") {
    throw new Error("Choose a folder to open, or approve this write once.");
  }
  return details;
}

/**
 * Mint the folder grant after the approval resolved. Failures are reported as
 * grantError: the approval still admits the exact approved write once.
 */
export async function mintChatApprovalFolderGrant(
  engine: ChatApprovalWriteGrantEngine,
  publishGrantCreated: (event: Record<string, unknown>) => Promise<unknown>,
  input: {
    approvalId: string;
    choice: ChatApprovalWriteGrantChoice;
    scope: "session" | "workspace";
    scopeRef: string;
    createdBy: string;
  },
): Promise<{ grant?: ToolGrantRecord; grantError?: string }> {
  let grant: ToolGrantRecord;
  try {
    grant = await engine.mintOutsideRootWriteGrant({
      approvalId: input.approvalId,
      rootId: input.choice.rootId,
      duration: input.choice.duration,
      scope: input.scope,
      scopeRef: input.scopeRef,
      createdBy: input.createdBy,
    });
  } catch (error) {
    return { grantError: error instanceof Error ? error.message : String(error) };
  }
  try {
    await publishGrantCreated({
      type: "tool_grant_created",
      grantId: grant.grantId,
      toolPattern: grant.toolPattern,
      decision: grant.decision,
      scope: grant.scope,
      scopeRef: grant.scopeRef,
      expiresAt: grant.expiresAt,
    });
  } catch (realtimeError) {
    void realtimeError;
    // The grant is canonical; realtime is an advisory projection.
  }
  return { grant };
}
