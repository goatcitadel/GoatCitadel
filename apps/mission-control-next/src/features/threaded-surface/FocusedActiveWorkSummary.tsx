import { useId, useState } from "react";
import type { ChatThreadTurnRecord, ChatTurnFailureClass } from "@goatcitadel/contracts";
import type { ChatStreamStatus } from "@goatcitadel/mission-control-shared/components/chat/ChatStreamStatusBar";
import { canRetryTurn } from "@goatcitadel/mission-control-shared/components/chat/chat-display-helpers";

export type FocusedActiveWorkKind = "running" | "approval" | "input" | "folder_failure" | "failure" | "stream_error";

export type FocusedActiveWorkState = {
  kind: FocusedActiveWorkKind;
  title: string;
  detail: string;
  turnId?: string;
  canRetry: boolean;
  canStop: boolean;
};

type PendingApprovalSummary = { reason?: string; toolName?: string } | null | undefined;
type PendingInputSummary = { question?: string; title?: string } | null | undefined;

export function deriveFocusedActiveWorkState({
  turn,
  streamStatus,
  streamError,
  pendingApproval,
  pendingUserInput,
}: {
  turn: ChatThreadTurnRecord | null;
  streamStatus: ChatStreamStatus;
  streamError?: string | null;
  pendingApproval?: PendingApprovalSummary;
  pendingUserInput?: PendingInputSummary;
}): FocusedActiveWorkState | null {
  if (pendingApproval) {
    return {
      kind: "approval",
      title: "Waiting for your approval",
      detail: pendingApproval.reason?.trim() || "Review the requested action to continue.",
      turnId: turn?.turnId,
      canRetry: false,
      canStop: false,
    };
  }

  if (pendingUserInput) {
    return {
      kind: "input",
      title: "I need one decision to continue",
      detail:
        pendingUserInput.question?.trim() ||
        pendingUserInput.title?.trim() ||
        "Answer the request in the composer to continue this chat.",
      turnId: turn?.turnId,
      canRetry: false,
      canStop: false,
    };
  }

  const hasStreamError = streamStatus === "error" || Boolean(streamError?.trim());

  if (!turn) {
    if (hasStreamError) {
      return streamErrorState(null);
    }
    if (["streaming", "connecting", "queued"].includes(streamStatus)) {
      return {
        kind: "running",
        title: streamStatus === "queued" ? "Your request is queued" : "Working on your request",
        detail: "I’ll keep the result here when it’s ready.",
        canRetry: false,
        canStop: streamStatus === "streaming",
      };
    }
    return null;
  }

  // Stream snapshots can arrive a render before the controller has assembled
  // its richer pending record. Keep the canonical trace's blocking posture
  // visible during that handoff instead of briefly labeling it as generic work.
  if (turn.trace.status === "waiting_for_approval") {
    return {
      kind: "approval",
      title: "Waiting for your approval",
      detail: "Review the requested action to continue.",
      turnId: turn.turnId,
      canRetry: false,
      canStop: false,
    };
  }

  if (turn.trace.status === "waiting_for_user_input") {
    return {
      kind: "input",
      title: "I need one decision to continue",
      detail:
        turn.trace.pendingUserInput?.question?.trim() ||
        turn.trace.pendingUserInput?.title?.trim() ||
        "Answer the request in the composer to continue this chat.",
      turnId: turn.turnId,
      canRetry: false,
      canStop: false,
    };
  }

  const failedTool = [...turn.toolRuns].reverse().find((tool) => tool.status === "failed" || tool.status === "blocked");
  const rawFailure = [turn.trace.failure?.message, failedTool?.error, failedTool?.failureGuidance]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ");
  const isFolderFailure = /ENOENT|no such file or directory|scandir|selected project folder/i.test(rawFailure);
  const failed = turn.trace.status === "failed" || Boolean(turn.trace.failure && !turn.assistantMessage);

  if (failed) {
    if (isFolderFailure) {
      return {
        kind: "folder_failure",
        title: "I couldn’t access the selected project folder",
        detail: "Tell me the correct relative project folder, then retry the step.",
        turnId: turn.turnId,
        canRetry: canRetryTurn(turn),
        canStop: false,
      };
    }
    return {
      kind: "failure",
      title: humanizeFailure(turn.trace.failure?.failureClass, failedTool?.status),
      detail: humanizeFailureDetail(turn.trace.failure?.failureClass, failedTool?.status),
      turnId: turn.turnId,
      canRetry: canRetryTurn(turn),
      canStop: false,
    };
  }

  // A cancellation is terminal even when a transport snapshot lags behind it.
  if (turn.trace.status === "cancelled") {
    return null;
  }

  // A transport error can arrive before the Gateway has persisted a terminal
  // failed trace. Keep that recovery state visible, but never surface the raw
  // transport diagnostic in the Chat-first lane.
  if (hasStreamError) {
    // The last persisted turn can be a successfully completed earlier request
    // while the new request fails before it receives a fresh turn projection.
    // Never turn that historical success into a retry target.
    return streamErrorState(turn.trace.status === "completed" ? null : turn);
  }

  // A new stream can be announced before a fresh turn projection exists. In
  // that narrow handoff the last completed turn is not the active work, so
  // retain the single visible working summary rather than leaving streaming
  // feedback only in an off-screen live region.
  if (["completed", "partial"].includes(turn.trace.status)) {
    if (["streaming", "connecting", "queued"].includes(streamStatus)) {
      return {
        kind: "running",
        title: streamStatus === "queued" ? "Your request is queued" : "Working on your request",
        detail: "I’ll keep the result here when it’s ready.",
        canRetry: false,
        canStop: streamStatus === "streaming",
      };
    }
    return null;
  }

  const active =
    streamStatus === "streaming" ||
    streamStatus === "connecting" ||
    streamStatus === "queued" ||
    ["queued", "running", "waiting_for_tool"].includes(turn.trace.status);
  if (!active) {
    return null;
  }

  return {
    kind: "running",
    title:
      streamStatus === "queued" || turn.trace.status === "queued"
        ? "Your request is queued"
        : "Working on your request",
    detail: "I’ll keep the result here when it’s ready.",
    turnId: turn.turnId,
    canRetry: false,
    canStop: streamStatus === "streaming" || turn.trace.status === "running",
  };
}

function streamErrorState(turn: ChatThreadTurnRecord | null): FocusedActiveWorkState {
  return {
    kind: "stream_error",
    title: "I couldn’t complete that response",
    detail: "Try again from the composer, or inspect Activity if it keeps happening.",
    turnId: turn?.turnId,
    canRetry: turn ? canRetryTurn(turn) : false,
    canStop: false,
  };
}

function humanizeFailure(failureClass?: ChatTurnFailureClass, toolStatus?: string): string {
  switch (failureClass) {
    case "auth_required":
      return "I need you to reconnect the account before I can continue";
    case "network_interrupted":
      return "The connection was interrupted before that step finished";
    case "provider_timeout":
      return "That response took too long to finish";
    case "tool_blocked":
      return "That step needs a different approval or input";
    case "skill_security_blocked":
      return "That skill needs a security review before it can run";
    default:
      return toolStatus === "blocked" ? "That step is blocked" : "I couldn’t complete that step";
  }
}

function humanizeFailureDetail(failureClass?: ChatTurnFailureClass, toolStatus?: string): string {
  if (failureClass === "auth_required") return "Reconnect it, then retry when you are ready.";
  if (failureClass === "network_interrupted") return "Retrying is safe once the connection is back.";
  if (failureClass === "provider_timeout") return "You can retry, or make the next request smaller.";
  if (failureClass === "tool_blocked") return "Review the required input or approval, then continue.";
  if (failureClass === "skill_security_blocked") return "Open Activity to inspect the governed security record.";
  if (toolStatus === "blocked") return "Review the required approval or access setting in Activity, then continue.";
  return "You can retry, or inspect Activity for recovery details.";
}

type FocusedActiveWorkSummaryProps = {
  state: FocusedActiveWorkState | null;
  onFocusComposer: () => void;
  onOpenActivity: () => void;
  onOpenApprovals: () => void;
  onRetry: (turnId: string) => void;
  onStop: () => void;
};

export function FocusedActiveWorkSummary(props: FocusedActiveWorkSummaryProps) {
  const identity = props.state ? `${props.state.kind}:${props.state.turnId ?? "none"}` : "none";
  return <FocusedActiveWorkSummaryContents key={identity} {...props} />;
}

function FocusedActiveWorkSummaryContents({
  state,
  onFocusComposer,
  onOpenActivity,
  onOpenApprovals,
  onRetry,
  onStop,
}: FocusedActiveWorkSummaryProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreControlsId = useId();
  if (!state) {
    return null;
  }

  const primaryAction =
    state.kind === "approval" ? (
      <button
        type="button"
        className="mc-next-thread-inline-button mc-next-active-work-primary"
        onClick={onOpenApprovals}
      >
        Review approval
      </button>
    ) : state.kind === "input" ? (
      <button
        type="button"
        className="mc-next-thread-inline-button mc-next-active-work-primary"
        onClick={onFocusComposer}
      >
        Answer request
      </button>
    ) : state.kind === "folder_failure" ? (
      <button
        type="button"
        className="mc-next-thread-inline-button mc-next-active-work-primary"
        onClick={onFocusComposer}
      >
        Tell me the correct folder
      </button>
    ) : state.kind === "stream_error" ? (
      state.canRetry && state.turnId ? (
        <button
          type="button"
          className="mc-next-thread-inline-button mc-next-active-work-primary"
          onClick={() => onRetry(state.turnId!)}
        >
          Retry
        </button>
      ) : (
        <button
          type="button"
          className="mc-next-thread-inline-button mc-next-active-work-primary"
          onClick={onFocusComposer}
        >
          Try again
        </button>
      )
    ) : state.kind === "failure" && state.canRetry && state.turnId ? (
      <button
        type="button"
        className="mc-next-thread-inline-button mc-next-active-work-primary"
        onClick={() => onRetry(state.turnId!)}
      >
        Retry
      </button>
    ) : null;

  return (
    <section className={`mc-next-active-work-summary state-${state.kind}`} aria-label="Current work">
      <div className="mc-next-active-work-copy">
        <strong>{state.title}</strong>
        <span>{state.detail}</span>
      </div>
      <div className="mc-next-active-work-actions">
        {primaryAction}
        {state.canStop ? (
          <button type="button" className="mc-next-thread-inline-button" onClick={onStop}>
            Stop
          </button>
        ) : null}
        {state.kind === "folder_failure" && state.canRetry && state.turnId ? (
          <details
            className="mc-next-active-work-more"
            open={moreOpen}
            onToggle={(event) => setMoreOpen(event.currentTarget.open)}
          >
            <summary className="mc-next-thread-inline-button" aria-expanded={moreOpen} aria-controls={moreControlsId}>
              More
            </summary>
            <div id={moreControlsId}>
              <button type="button" className="mc-next-thread-inline-button" onClick={() => onRetry(state.turnId!)}>
                Retry
              </button>
            </div>
          </details>
        ) : null}
        <button type="button" className="mc-next-thread-inline-button" onClick={onOpenActivity}>
          View activity
        </button>
      </div>
    </section>
  );
}
