import { ChatConversationStarters } from "./ChatConversationStarters";
import { lazy, memo, Suspense, type RefObject } from "react";
import { canRetryTurn } from "@goatcitadel/mission-control-shared/components/chat/chat-display-helpers";
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
import { presentChatTurnStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { formatBytes } from "@goatcitadel/mission-control-shared/content/format";
import { OctagonAlert, TriangleAlert } from "lucide-react";
import { presentAttachmentType } from "./chat-vocabulary";
import { describeChannelMessageSource, type ChannelConversationContext } from "./channel-conversation";
import { useInChannelConversation } from "./channel-conversation-scope";
import { ChannelNewMessagesDivider } from "./ChannelNewMessagesDivider";
import { useChatStreamingPreviewSnapshot } from "@goatcitadel/mission-control-shared/state/chat-streaming-preview-store";
import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { StatusBadge } from "../../ui/StatusBadge";
import { ChatBlockers } from "./ChatBlockers";
import { ChatCapabilitySuggestionLine, selectTurnCapabilitySuggestions } from "./ChatCapabilitySuggestionLine";
import { ChatCodeModeRequestCard } from "./ChatCodeModeRequestCard";
import { ChatClampedUserMessage } from "./ChatClampedUserMessage";
import { ChatContinueAction } from "./ChatContinueAction";
import { ChatRunCard } from "./ChatRunCard";
import { ChatStreamErrorNotice } from "./ChatStreamErrorNotice";
import { ChatNoticeText } from "./ChatNoticeText";
import { ChatTurnDetails } from "./ChatTurnDetails";
import { ChatTurnFailureCard } from "./ChatTurnFailureCard";
import { ChatTurnThinking } from "./ChatTurnThinking";
import { TurnReceipt } from "./ChatTurnReceipt";
import { turnReadsDraft, type TurnActions } from "./use-turn-actions";

const ChatChangePlanCard = lazy(async () => ({
  default: (await import("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard")).ChatChangePlanCard,
}));

const WorkflowSkillCaptureControl = lazy(() =>
  import("../../../features/native-routes/library/WorkflowSkillCaptureControl").then((module) => ({
    default: module.WorkflowSkillCaptureControl,
  })),
);

const TURN_NAME_WORDS = 8;

const RUN_DETAILS_HINT = "Use Run details under More, below this message.";

/**
 * Where a failed or partial answer's note points. A turn that cannot be resent (a channel message, or any turn of a
 * channel conversation) is not pointed at Retry or at a recovery that says to retry or resend.
 */
function recoveryHint(turn: ChatThreadTurnRecord, resendable: boolean): string {
  if (!resendable) return RUN_DETAILS_HINT;
  const recommended = turn.trace.failure?.recommendedAction;
  if (recommended) return getChatTurnRecoveryActionSummary(recommended);
  return canRetryTurn(turn) ? "Use Retry, or Run details under More, below this message." : RUN_DETAILS_HINT;
}

/** Names a turn by its position and the start of its prompt so the transcript's articles are distinguishable. */
function turnAccessibleName(prompt: string, position?: number): string {
  const words = prompt.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const start = words.slice(0, TURN_NAME_WORDS).join(" ") + (words.length > TURN_NAME_WORDS ? "…" : "");
  const label = position ? `Message ${position}` : "Message";
  return start ? `${label}: ${start}` : label;
}

/**
 * Memoized so a streaming preview flush, a composer keystroke or a reasoning chunk re-renders only the turn whose
 * props changed. Callers must pass stable `actions` and callbacks.
 */
export const Turn = memo(function Turn({
  turn,
  position,
  isLatest = false,
  previewText,
  streaming,
  actions,
  draftEmpty,
  continueActions,
  channel,
  newMessageCount,
  onInspectTurn,
  onOpenArtifact,
  onReviewPlan,
  onNewConversation,
}: {
  turn: ChatThreadTurnRecord;
  /** One-based position in the conversation, when known. */
  position?: number;
  /** The newest turn in the conversation; only it can offer Continue. */
  isLatest?: boolean;
  previewText: string | null;
  streaming: boolean;
  actions: TurnActions;
  /** Whether the composer is empty; it matters only to a turn that `turnReadsDraft`. */
  draftEmpty: boolean;
  /**
   * The live session surface, passed only to a stopped latest turn: Continue follows the composer's draft and send
   * state, so that one turn re-renders as the draft changes.
   */
  continueActions?: MissionThreadedActiveSessionSurfaceProps;
  /** Set in a channel conversation, so each message can say where it came from. Callers keep it stable. */
  channel?: ChannelConversationContext;
  /** When set, this turn's message is the first new one since the reader was last here. */
  newMessageCount?: number;
  onInspectTurn?: (turnId: string) => void;
  onOpenArtifact?: (turnId: string, artifactId?: string) => void;
  onReviewPlan?: MissionThreadedRenderSurfaceInput["onReviewChangePlan"];
  /** Opens a fresh conversation, offered when this one has grown too long for the model. Callers keep it stable. */
  onNewConversation?: () => void;
}) {
  const assistantText = previewText ?? turn.assistantMessage?.content ?? "";
  const failed = turn.trace.status === "failed";
  const partial = turn.trace.status === "partial";
  const stopped = turn.trace.status === "cancelled";
  const capture = getWorkflowSkillCaptureDisplay(turn.userMessage.content);
  // What someone else wrote through a channel is theirs: it is neither retried, edited nor captured as a workflow.
  const fromChannel = turn.userMessage.sourceAuthority === "external_channel";
  // In a channel conversation Retry, Edit and Continue would send words through the channel again, even the operator's
  // own desk question, so no turn offers them. The session says so before the Messaging overview has loaded.
  const inChannel = useInChannelConversation() || channel !== undefined;
  const resendable = !fromChannel && !inChannel;
  const source = channel ? describeChannelMessageSource(channel, turn.userMessage.sourceAuthority) : null;
  return (
    <article
      className="group/turn mx-auto w-full max-w-3xl space-y-4 px-3 py-5 sm:px-6"
      aria-label={turnAccessibleName(capture?.summary ?? turn.userMessage.content, position)}
      data-turn-id={turn.turnId}
    >
      {newMessageCount ? <ChannelNewMessagesDivider count={newMessageCount} /> : null}
      {/* Heading navigation moves message by message; the visible "You" and "Assistant" labels stay as they are. */}
      <h2 className="sr-only">{source?.heading ?? "You said"}</h2>
      <div
        data-turn-prompt
        className="cockpit-chat-user-bubble ml-auto rounded-lg border border-line-subtle bg-raised p-3"
      >
        <p className="mb-1 text-xs font-medium text-fg-muted">
          {source?.label ?? "You"} · <ActorTimestamp timestamp={turn.userMessage.timestamp ?? ""} />
        </p>
        <ChatClampedUserMessage text={capture?.summary ?? turn.userMessage.content}>
          <AssistantMessageRenderer role="user" content={capture?.summary ?? turn.userMessage.content} />
        </ChatClampedUserMessage>
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
                {file.fileName} · {presentAttachmentType(file)} · {formatBytes(file.sizeBytes)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {assistantText || streaming || turn.thinking?.trim() ? (
        <div className="max-w-full">
          <h2 className="sr-only">Assistant reply</h2>
          <div className="mb-2 flex items-center gap-2">
            <p className="text-xs font-medium text-fg-muted">
              Assistant{" "}
              {turn.assistantMessage?.timestamp ? <ActorTimestamp timestamp={turn.assistantMessage.timestamp} /> : null}
            </p>
            {streaming ? <StatusBadge status={{ label: "Responding", tone: "running" }} /> : null}
            {!streaming && (stopped || failed || partial) ? (
              <StatusBadge status={presentChatTurnStatus(turn.trace.status)} />
            ) : null}
          </div>
          <ChatTurnThinking
            thinking={turn.thinking}
            live={streaming || !isChatTurnTerminalStatus(turn.trace.status)}
            answerStarted={Boolean(assistantText)}
          />
          {assistantText ? (
            <AssistantMessageRenderer
              role="assistant"
              content={assistantText}
              running={streaming}
              streamTurnId={turn.turnId}
            />
          ) : streaming && !turn.thinking?.trim() ? (
            <p className="text-sm text-fg-muted">Preparing response…</p>
          ) : null}
          {stopped && assistantText && !streaming ? (
            <p className="mt-1 text-xs text-fg-muted" role="note">
              Stopped — partial answer
            </p>
          ) : null}
          {/* Continue sends a message, which a channel conversation would deliver or post to the channel. */}
          {continueActions && stopped && assistantText && !streaming && resendable ? (
            <ChatContinueAction turn={turn} isLatest={isLatest} actions={continueActions} />
          ) : null}
          {turn.assistantMessage && !streaming ? <TurnReceipt turn={turn} onInspectTurn={onInspectTurn} /> : null}
        </div>
      ) : !failed && !partial ? (
        <p className="text-xs text-fg-muted">{presentChatTurnStatus(turn.trace.status).label}</p>
      ) : null}
      {failed || partial ? (
        <ChatTurnFailureCard
          failed={failed}
          answered={Boolean(assistantText)}
          failureClass={turn.trace.failure?.failureClass}
          hint={recoveryHint(turn, resendable)}
          onNewConversation={actions.historicalReadOnly ? undefined : onNewConversation}
        />
      ) : null}
      {/* Its own row, not inside the reply: the request waits for the operator before any reply text exists. */}
      <ChatCodeModeRequestCard
        turn={turn}
        workspaceId={actions.workspaceId}
        onRefreshThread={actions.onRefreshThread}
      />
      {actions.onCapabilitySuggestionAction && actions.onDismissCapabilitySuggestion ? (
        <ChatCapabilitySuggestionLine
          suggestions={selectTurnCapabilitySuggestions(actions, turn.turnId, isLatest)}
          onAction={actions.onCapabilitySuggestionAction}
          onDismiss={actions.onDismissCapabilitySuggestion}
        />
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
          resendBlocked={!resendable}
          latest={isLatest}
          actions={{
            ...actions,
            onOpenRunDetails: onInspectTurn ?? actions.onOpenRunDetails,
            onOpenGeneratedArtifact: onOpenArtifact ?? actions.onOpenGeneratedArtifact,
          }}
        />
      ) : null}
      {!actions.historicalReadOnly &&
      !fromChannel &&
      !streaming &&
      actions.selectedSessionId &&
      turnReadsDraft(turn) ? (
        <Suspense fallback={<p role="status">Loading skill capture…</p>}>
          <WorkflowSkillCaptureControl
            turn={turn}
            sessionId={actions.selectedSessionId}
            workspaceId={actions.workspaceId}
            draftEmpty={draftEmpty}
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
});

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
  // CH-04: while the first message is sending, the footer shows the pending turn; nothing else belongs here.
  if (props && (props.hasActiveStream || props.optimisticUserMessage || context?.pendingTurnId)) return null;
  if (!props || props.loading || context?.gatewayUnavailable || !props.selectedSessionId || !props.thread)
    return (
      <p className="p-5 text-center text-sm text-fg-muted">
        {props?.loading
          ? "Loading messages…"
          : context?.gatewayUnavailable
            ? "Messages can’t load while GoatCitadel is unreachable."
            : "No messages in this view."}
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
          // The message being sent looks like the user bubble it becomes, with a Sending badge until it is saved.
          <div className="cockpit-chat-user-bubble ml-auto rounded-lg border border-line-subtle bg-raised p-3">
            <h2 className="sr-only">You said</h2>
            <div className="mb-1 flex items-center gap-2">
              <p className="text-xs font-medium text-fg-muted">You</p>
              <StatusBadge status={{ label: "Sending", tone: "running" }} />
            </div>
            <AssistantMessageRenderer role="user" content={props.optimisticUserMessage.content} />
          </div>
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
        {importantNotices.map((notice) => {
          // Critical differs from a warning by its label and icon, not only by colour.
          const critical = notice.tone === "critical";
          const Icon = critical ? OctagonAlert : TriangleAlert;
          return (
            <div
              role="note"
              key={notice.id}
              className={`flex gap-2 rounded-md border p-2 text-sm text-fg-secondary ${critical ? "border-status-failed" : "border-status-waiting"}`}
              aria-label={critical ? "Critical conversation notice" : "Conversation warning"}
            >
              <Icon
                aria-hidden="true"
                className={`mt-0.5 size-4 shrink-0 ${critical ? "text-status-failed" : "text-status-waiting"}`}
              />
              <div className="min-w-0">
                <strong className="font-medium text-fg">{critical ? "Critical: " : "Warning: "}</strong>
                <ChatNoticeText content={notice.content} />
                <ChatNoticeTechnicalDetails key={`${props.selectedSessionId}:${notice.id}`} notice={notice} />
              </div>
            </div>
          );
        })}
        {latestRoutine ? (
          <div
            role="note"
            className="rounded-md border border-line-subtle bg-raised p-2 text-sm text-fg-secondary"
            aria-label="Latest conversation update"
          >
            <ChatNoticeText content={latestRoutine.content} />
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
          <ChatStreamErrorNotice
            error={props.streamError}
            source={props.streamErrorSource}
            onReload={props.onRefreshThread}
          />
        ) : null}
      </div>
      <div ref={context.threadEndRef} aria-hidden="true" className="h-px" />
    </>
  );
}
