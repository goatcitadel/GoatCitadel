import type { ChatUserInputPromptResponse } from "@goatcitadel/contracts";
import {
  answerChatUserInputPrompt,
  approveChatTool,
  denyChatTool,
  selectChatBranchTurn,
  submitChatSecureConfiguration,
} from "@goatcitadel/mission-control-shared/api/client";
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import { recordChatApprovalPhase } from "./chat-causality";
import type { PendingApprovalRecord } from "./chat-pending-approval";
import type { PendingUserInputRecord } from "./chat-pending-user-input";
import type { ChatThreadCommitter } from "./useChatOutboundExecution.types";

const APPROVAL_RESUMED_REFRESH_DELAYS_MS = [750, 2_000] as const;
const APPROVAL_FALLBACK_REFRESH_DELAYS_MS = [500, 1_500, 3_000] as const;
const CORE_REFRESH = { background: true, includeThread: true } as const;

export async function selectOperatorBranch(
  sessionId: string,
  turnId: string,
  current: () => boolean,
  commit: ChatThreadCommitter,
) {
  recordClientDiagnostic({
    level: "info",
    category: "chat",
    event: "branch.select",
    message: "Selecting chat branch turn",
    sessionId,
    turnId,
  });
  if (!current()) return;
  const thread = await selectChatBranchTurn(sessionId, turnId);
  if (!current()) return;
  commit((previous) => (current() ? thread : previous));
  return thread;
}

type PromptActionOwner = {
  sessionId: string;
  current: () => boolean;
  loadCore: (sessionId: string, options: typeof CORE_REFRESH) => Promise<void>;
  notice: (content: string, tone: "success" | "warning") => void;
};

export async function decideOperatorApproval(
  owner: PromptActionOwner & {
    refreshQueue: (sessionId: string, isCancelled: () => boolean) => Promise<void>;
    clearApproval: () => void;
    timers: Set<ReturnType<typeof setTimeout>>;
  },
  prompt: PendingApprovalRecord,
  allowScope?: "once" | "session" | "workspace",
) {
  const { sessionId, current, loadCore, notice, refreshQueue } = owner;
  const approvalSessionId = prompt.sessionId?.trim() || sessionId;
  const approval = {
    approvalId: prompt.approvalId,
    toolName: prompt.toolName,
    kind: prompt.kind,
    reason: prompt.reason,
    riskLevel: prompt.riskLevel,
    remainingCount: prompt.remainingCount,
    affectedResourceCount: prompt.affectedResources?.length,
    requestedOutputIntent: prompt.requestedOutputIntent,
    expiresAt: prompt.expiresAt,
  };
  const diagnostic = { sessionId: approvalSessionId, approval, source: "operator" } as const;
  const stale = () => !current();
  recordChatApprovalPhase({
    ...diagnostic,
    phase: "resolve_started",
    context: { allowScope, selectedSessionId: sessionId },
  });
  if (!current()) return;

  if (allowScope === undefined) {
    await denyChatTool(approvalSessionId, prompt.approvalId);
    if (!current()) return;
    await refreshQueue(approvalSessionId, stale);
    if (approvalSessionId !== sessionId && current()) {
      await refreshQueue(sessionId, stale).catch(() => undefined);
      if (current()) await loadCore(sessionId, CORE_REFRESH).catch(() => undefined);
    }
    if (!current()) return;
    notice(`Denied request ${prompt.approvalId}. No action was taken.`, "warning");
    recordChatApprovalPhase({ ...diagnostic, phase: "dismissed", context: { selectedSessionId: sessionId } });
    return;
  }

  const result = await approveChatTool(approvalSessionId, prompt.approvalId, { allowScope });
  if (!current()) return;
  owner.clearApproval();
  await refreshQueue(approvalSessionId, stale);
  if (!current()) return;
  await loadCore(sessionId, CORE_REFRESH).catch(() => undefined);
  if (approvalSessionId !== sessionId && current()) await refreshQueue(sessionId, stale).catch(() => undefined);
  if (!current()) return;
  const delays = result.resumed ? APPROVAL_RESUMED_REFRESH_DELAYS_MS : APPROVAL_FALLBACK_REFRESH_DELAYS_MS;
  for (const delay of delays) {
    const timer = globalThis.setTimeout(() => {
      owner.timers.delete(timer);
      if (!current()) return;
      void refreshQueue(approvalSessionId, stale).catch(() => undefined);
      void loadCore(sessionId, CORE_REFRESH).catch(() => undefined);
      if (approvalSessionId !== sessionId) void refreshQueue(sessionId, stale).catch(() => undefined);
    }, delay);
    owner.timers.add(timer);
  }
  const scopeLabel =
    allowScope === "session"
      ? "Session allow created."
      : allowScope === "workspace"
        ? "Workspace allow created."
        : "Approved once.";
  notice(
    `Approved request ${prompt.approvalId}. ${scopeLabel} ${
      result.resumed
        ? "The runtime resumed immediately."
        : "If the run is no longer live, use Approvals & Recovery to continue from the persisted checkpoint."
    }`,
    "success",
  );
  recordChatApprovalPhase({
    ...diagnostic,
    phase: "resolved",
    context: {
      allowScope,
      resumed: result.resumed,
      resumedRunId: result.resumedRunId,
      resumedTurnId: result.resumedTurnId,
      selectedSessionId: sessionId,
    },
  });
}

export async function submitOperatorPrompt(
  owner: PromptActionOwner & { clearInput: () => void },
  prompt: PendingUserInputRecord,
  response: ChatUserInputPromptResponse,
) {
  const { sessionId, current, loadCore, notice } = owner;
  const result =
    response.kind === "secure_configuration"
      ? await submitChatSecureConfiguration(sessionId, prompt.turnId, prompt.promptId, { secret: response.secret })
      : await answerChatUserInputPrompt(sessionId, prompt.turnId, prompt.promptId, { response });
  if (!current()) return;
  owner.clearInput();
  notice(
    result.resumed
      ? `Submitted response for ${prompt.promptId}. The turn resumed immediately.`
      : prompt.delivery === "background"
        ? "Answer saved. Work continues; the runtime can use it at the next model step."
        : `Submitted response for ${prompt.promptId}. Refresh the thread or resume the run when the runtime is ready.`,
    "success",
  );
  await loadCore(sessionId, CORE_REFRESH);
}
