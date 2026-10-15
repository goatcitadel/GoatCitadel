import { ChatConversationStarters } from "./ChatConversationStarters";
import { lazy, Suspense, type RefObject } from "react";
import {
  getChatTurnRecoveryActionSummary,
  isChatTurnTerminalStatus,
  type ChatThreadTurnRecord,
} from "@goatcitadel/contracts";
import { NativeMessageRenderer as AssistantMessageRenderer } from "./NativeMessageRenderer";
import { getWorkflowSkillCaptureDisplay } from "@goatcitadel/mission-control-shared/components/chat/workflow-skill-capture-display";
import {
  ActorTimestamp,
  ChatThreadNotices,
  ChatNoticeTechnicalDetails,
} from "@goatcitadel/mission-control-shared/components/chat/ChatThreadReadingPrimitives";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useChatStreamingPreviewSnapshot } from "@goatcitadel/mission-control-shared/state/chat-streaming-preview-store";
import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { StatusBadge } from "../../ui/StatusBadge";
import { ChatBlockers } from "./ChatBlockers";
import { ChatRunCard } from "./ChatRunCard";
import { ChatStreamErrorNotice } from "./ChatStreamErrorNotice";
import { ChatTurnDetails } from "./ChatTurnDetails";
import { TurnReceipt } from "./ChatTurnReceipt";

const ChatChangePlanCard = lazy(async () => ({
  default: (await import("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard")).ChatChangePlanCard,
}));

const WorkflowSkillCaptureControl = lazy(() =>
  import("../../../features/native-routes/library/WorkflowSkillCaptureControl").then((module) => ({
    default: module.WorkflowSkillCaptureControl,
  })),
);

export function Turn({
  turn,
  previewText,
  streaming,
  actions,
  onInspectTurn,
  onOpenArtifact,
  onReviewPlan,
}: {
  turn: ChatThreadTurnRecord;
  previewText: string | null;
  streaming: boolean;
  actions: MissionThreadedActiveSessionSurfaceProps;
  onInspectTurn?: (turnId: string) => void;
  onOpenArtifact?: (turnId: string, artifactId?: string) => void;
  onReviewPlan?: MissionThreadedRenderSurfaceInput["onReviewChangePlan"];
}) {
  const assistantText = previewText ?? turn.assistantMessage?.content ?? "";
  const failed = turn.trace.status === "failed";
  const partial = turn.trace.status === "partial";
  const stopped = turn.trace.status === "cancelled";
  const capture = getWorkflowSkillCaptureDisplay(turn.userMessage.content);
  return (
    <article
      className="mx-auto w-full max-w-3xl space-y-4 px-3 py-5 sm:px-6"
      aria-label="Conversation messages"
      data-turn-id={turn.turnId}
    >
      <div className="cockpit-chat-user-bubble ml-auto rounded-lg border border-line-subtle bg-raised p-3">
        <p className="mb-1 text-xs font-medium text-fg-muted">
          You · <ActorTimestamp timestamp={turn.userMessage.timestamp ?? ""} />
        </p>
        <AssistantMessageRenderer role="user" content={capture?.summary ?? turn.userMessage.content} />
        {capture ? (
          <details>
            <summary>Captured task</summary>
            <p>{capture.request}</p>
            <p>{capture.result}</p>
          </details>
        ) : null}
        {turn.userMessage.attachments?.length ? (
          <ul aria-label="Sent attachments">
            {turn.userMessage.attachments.map((file) => (
              <li key={file.attachmentId}>
                {file.fileName} · {file.mimeType}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {assistantText || streaming ? (
        <div className="max-w-full">
          <div className="mb-2 flex items-center gap-2">
            <p className="text-xs font-medium text-fg-muted">
              Assistant{" "}
              {turn.assistantMessage?.timestamp ? <ActorTimestamp timestamp={turn.assistantMessage.timestamp} /> : null}
            </p>
            {streaming ? <StatusBadge status={{ label: "Responding", tone: "running" }} /> : null}
            {!streaming && stopped ? <StatusBadge status={{ label: "Stopped", tone: "neutral" }} /> : null}
            {!streaming && (failed || partial) ? (
              <StatusBadge status={{ label: failed ? "Failed" : "Partial", tone: failed ? "failed" : "waiting" }} />
            ) : null}
          </div>
          {assistantText ? (
            <AssistantMessageRenderer
              role="assistant"
              content={assistantText}
              running={streaming}
              streamTurnId={turn.turnId}
            />
          ) : (
            <p className="text-sm text-fg-muted">Preparing response…</p>
          )}
          {turn.assistantMessage && !streaming ? <TurnReceipt turn={turn} /> : null}
        </div>
      ) : !failed && !partial ? (
        <p className="text-xs text-fg-muted">{stopped ? "Stopped" : humanizeToken(turn.trace.status)}</p>
      ) : null}
      {failed || partial ? (
        <div
          role="note"
          className="rounded-md border border-status-waiting p-2 text-sm text-fg-secondary"
          aria-label="Response recovery"
        >
          {partial ? "This answer may be incomplete." : !assistantText ? "This response failed." : ""}
          {turn.trace.failure?.failureClass && turn.trace.failure.failureClass !== "unknown"
            ? ` Cause: ${humanizeToken(turn.trace.failure.failureClass)}.`
            : ""}{" "}
          {turn.trace.failure?.recommendedAction
            ? getChatTurnRecoveryActionSummary(turn.trace.failure.recommendedAction)
            : "Review run details or retry when available."}
        </div>
      ) : null}
      {turn.assistantMessage ||
      turn.toolRuns.length ||
      turn.citations.length ||
      turn.generatedArtifacts?.length ||
      turn.trace.failure ||
      isChatTurnTerminalStatus(turn.trace.status) ? (
        <ChatTurnDetails
          turn={turn}
          answerContent={assistantText}
          streaming={streaming}
          readOnly={actions.historicalReadOnly}
          actions={{
            ...actions,
            onOpenRunDetails: onInspectTurn ?? actions.onOpenRunDetails,
            onOpenGeneratedArtifact: onOpenArtifact ?? actions.onOpenGeneratedArtifact,
          }}
        />
      ) : null}
      {!actions.historicalReadOnly &&
      !streaming &&
      actions.selectedSessionId &&
      turn.trace.status === "completed" &&
      turn.trace.completion?.status === "complete" ? (
        <Suspense fallback={<p role="status">Loading skill capture…</p>}>
          <WorkflowSkillCaptureControl
            turn={turn}
            sessionId={actions.selectedSessionId}
            workspaceId={actions.workspaceId}
            draftEmpty={!actions.draft.trim()}
            onPrepare={(prompt) => {
              actions.onDraftChange(prompt);
              actions.composerRef.current?.focus();
            }}
            onReviewPlan={onReviewPlan}
          />
        </Suspense>
      ) : null}
    </article>
  );
}

export type TranscriptFooterContext = {
  renderedTurns?: readonly ChatThreadTurnRecord[];
  props: MissionThreadedActiveSessionSurfaceProps;
  receipt?: MissionThreadedRenderSurfaceInput["changePlanReceipt"];
  gatewayUnavailable?: boolean;
  preview: ReturnType<typeof useChatStreamingPreviewSnapshot>;
  pendingTurnId: string | null | undefined;
  hasPreviewTurn: boolean;
  visibleTurns: ChatThreadTurnRecord[];
  latestTurn?: ChatThreadTurnRecord;
  onInspectTurn?: (turnId: string) => void;
  onInspectRun?: (turnId: string) => void;
  threadEndRef: RefObject<HTMLDivElement | null>;
  jumpToLatest: () => void;
};

export function ChatTranscriptEmpty({ context }: { context?: TranscriptFooterContext }) {
  const props = context?.props;
  if (
    !props ||
    props.loading ||
    context?.gatewayUnavailable ||
    !props.selectedSessionId ||
    !props.thread ||
    props.hasActiveStream ||
    props.optimisticUserMessage ||
    context?.pendingTurnId
  )
    return (
      <p className="p-5 text-center text-sm text-fg-muted">
        {props?.loading ? "Loading messages…" : "No messages in this view."}
      </p>
    );
  return <ChatConversationStarters props={props} />;
}

export function ChatTranscriptFooter({ context }: { context?: TranscriptFooterContext }) {
  if (!context) return null;
  const {
    props,
    receipt,
    preview,
    pendingTurnId,
    hasPreviewTurn,
    visibleTurns,
    latestTurn,
    onInspectRun,
    onInspectTurn,
  } = context;
  const renderedTurns = context.renderedTurns ?? visibleTurns;
  const hasRenderedPreviewTurn = context.renderedTurns
    ? renderedTurns.some((turn) => turn.turnId === pendingTurnId)
    : hasPreviewTurn;
  const importantNotices =
    props.notices?.filter((notice) => notice.tone === "warning" || notice.tone === "critical") ?? [];
  const routineNotices =
    props.notices?.filter((notice) => notice.tone !== "warning" && notice.tone !== "critical") ?? [];
  // Notices remain owned by the conversation controller; only routine history folds away.
  const latestRoutine = routineNotices.reduce<(typeof routineNotices)[number] | undefined>(
    (latest, notice) => (!latest || notice.timestamp > latest.timestamp ? notice : latest),
    undefined,
  );
  return (
    <>
      <div className="mx-auto max-w-3xl px-3 pb-3 sm:px-6">
        {props.optimisticUserMessage &&
        !renderedTurns.some(
          (turn) => turn.userMessage.messageId === props.optimisticUserMessage?.canonicalMessageId,
        ) ? (
          <p className="rounded-lg border border-line bg-raised p-3 text-sm text-fg-secondary">
            {props.optimisticUserMessage.content} · Sending…
          </p>
        ) : null}
        {pendingTurnId && !hasRenderedPreviewTurn && preview?.visibleText ? (
          <div className="py-4">
            <AssistantMessageRenderer
              role="assistant"
              content={preview.visibleText}
              running
              streamTurnId={pendingTurnId}
            />
          </div>
        ) : null}
        <ChatRunCard
          props={props}
          turnId={latestTurn?.turnId}
          durableRunId={latestTurn?.trace.durable?.runId}
          onInspect={
            latestTurn && (onInspectRun ?? onInspectTurn)
              ? () => (onInspectRun ?? onInspectTurn)?.(latestTurn.turnId)
              : undefined
          }
        />
        {importantNotices.map((notice) => (
          <div
            role="note"
            key={notice.id}
            className="rounded-md border border-status-waiting p-2 text-sm text-fg-secondary"
            aria-label="Conversation warning"
          >
            {notice.content}
            <ChatNoticeTechnicalDetails key={`${props.selectedSessionId}:${notice.id}`} notice={notice} />
          </div>
        ))}
        {latestRoutine ? (
          <div
            role="note"
            className="rounded-md border border-line-subtle bg-raised p-2 text-sm text-fg-secondary"
            aria-label="Latest conversation update"
          >
            {latestRoutine.content}
            <ChatNoticeTechnicalDetails key={`${props.selectedSessionId}:${latestRoutine.id}`} notice={latestRoutine} />
          </div>
        ) : null}
        <ChatThreadNotices
          notices={routineNotices.filter((notice) => notice !== latestRoutine)}
          scopeKey={props.selectedSessionId}
        />
        {receipt && !receipt.dismissed ? (
          <Suspense
            fallback={
              <p role="status" className="min-h-24">
                Loading change-plan receipt…
              </p>
            }
          >
            <ChatChangePlanCard {...receipt} />
          </Suspense>
        ) : null}
        <ChatBlockers key={props.selectedSessionId} props={props} />
        {props.streamError && latestTurn?.trace.status !== "failed" && latestTurn?.trace.status !== "partial" ? (
          <ChatStreamErrorNotice error={props.streamError} source={props.streamErrorSource} />
        ) : null}
      </div>
      <div ref={context.threadEndRef} aria-hidden="true" className="h-px" />
    </>
  );
}
