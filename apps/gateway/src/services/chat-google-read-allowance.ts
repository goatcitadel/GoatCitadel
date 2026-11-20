import {
  CHAT_TOOL_GRANT_DURATION_MS,
  ValidationError,
  type ApprovalRequest,
  type ChatToolGrantDuration,
  type GoogleReadGrantScope,
  type ToolGrantRecord,
} from "@goatcitadel/contracts";
import type { ApprovalLifecycleHost } from "./approval-lifecycle-service.js";
import type { ApprovalResolutionContext } from "./approval-types.js";
import { publishToolGrantCreated } from "./chat-approval-write-grant.js";

export async function readGoogleReadGrantScope(
  host: Pick<ApprovalLifecycleHost, "storage">,
  approval: ApprovalRequest,
  approvalId: string,
  sessionId: string,
  workspaceId: string,
  turnId: string,
): Promise<GoogleReadGrantScope> {
  const action = await host.storage.pendingApprovalActions.find(approvalId);
  const request = action?.request;
  const args = request?.args as Record<string, unknown> | undefined;
  const signInId = request?.googleReadSignInId;
  const connectionId = args?.connectionId;
  if (
    action?.actionType !== "tool.invoke" ||
    request?.toolName !== approval.kind ||
    request?.sessionId !== sessionId ||
    request?.workspaceId !== workspaceId ||
    request?.turnId !== turnId ||
    typeof signInId !== "string" ||
    !signInId ||
    typeof connectionId !== "string" ||
    !connectionId ||
    connectionId !== approval.payload.connectionId
  ) {
    throw new ValidationError({
      message: "This Google request has no verified sign-in. Request a new read in Chat.",
    });
  }
  return {
    workspaceId,
    sessionId,
    connectionId,
    signInId,
    ...(approval.kind === "calendar.list"
      ? { calendarId: typeof args?.calendarId === "string" && args.calendarId ? args.calendarId : "primary" }
      : {}),
  };
}

export function createGoogleReadAllowanceCommit(
  host: Pick<ApprovalLifecycleHost, "storage" | "policyEngine" | "publishRealtime">,
  input: { duration: ChatToolGrantDuration; scope: GoogleReadGrantScope; toolPattern: string; resolvedBy: string },
) {
  const { duration, scope, toolPattern, resolvedBy } = input;
  let grant: ToolGrantRecord | undefined;
  let grantError: string | undefined;
  const context: ApprovalResolutionContext = {
    commitChatReadAllowance: async () => {
      try {
        // Roll back a failed mint without losing the approved one-time read.
        const receipt = await host.storage.runImmediateTransaction(async () => {
          const created = await host.policyEngine.createGrant(
            {
              toolPattern,
              decision: "allow",
              scope: "session",
              scopeRef: scope.sessionId,
              createdBy: resolvedBy,
              constraints: { googleRead: scope, mutationAllowed: false },
            },
            CHAT_TOOL_GRANT_DURATION_MS[duration],
          );
          if (!created.expiresAt) throw new Error("The temporary Google read allowance is missing its expiry.");
          return { created, expiresAt: created.expiresAt };
        });
        grant = receipt.created;
        return { duration, status: "granted", expiresAt: receipt.expiresAt };
      } catch {
        grantError = "The temporary allowance could not be created.";
        return { duration, status: "failed" };
      }
    },
  };
  return {
    context,
    async finish() {
      if (grant) await publishToolGrantCreated((event) => host.publishRealtime("system", "tools", event), grant);
      return { grant, grantError };
    },
  };
}
