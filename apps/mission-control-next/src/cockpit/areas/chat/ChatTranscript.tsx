import { ChatConversationStarters } from "./ChatConversationStarters";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Virtuoso } from "react-virtuoso";
import { getChatTurnRecoveryActionSummary, isChatTurnTerminalStatus, type ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { AssistantMessageRenderer } from "@goatcitadel/mission-control-shared/components/chat/AssistantMessageRenderer";
import { ChatChangePlanCard } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard";
import { getWorkflowSkillCaptureDisplay } from "@goatcitadel/mission-control-shared/components/chat/workflow-skill-capture-display";
import { ActorTimestamp, ChatThreadNotices } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useChatStreamingPreviewSnapshot } from "@goatcitadel/mission-control-shared/state/chat-streaming-preview-store";
import { HistoricalConversationView } from "../../../features/threaded-surface/ThreadHistoricalConversation";
import { useScrollToBottom } from "@goatcitadel/mission-control-shared/components/chat/useScrollToBottom";
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
import "../../../features/threaded-surface/styles/code-highlight.css";
import "../../styles/chat-display.css";

const WorkflowSkillCaptureControl = lazy(() => import("../../../features/native-routes/library/WorkflowSkillCaptureControl").then((module) => ({ default: module.WorkflowSkillCaptureControl })));

function Turn({
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
        <p className="mb-1 text-xs font-medium text-fg-muted">You · <ActorTimestamp timestamp={turn.userMessage.timestamp ?? ""} /></p>
        <AssistantMessageRenderer role="user" content={capture?.summary ?? turn.userMessage.content} />
        {capture ? <details><summary>Captured task</summary><p>{capture.request}</p><p>{capture.result}</p></details> : null}
        {turn.userMessage.attachments?.length ? <ul aria-label="Sent attachments">{turn.userMessage.attachments.map((file) => <li key={file.attachmentId}>{file.fileName} · {file.mimeType}</li>)}</ul> : null}
      </div>
      {assistantText || streaming ? (
        <div className="max-w-full">
          <div className="mb-2 flex items-center gap-2">
            <p className="text-xs font-medium text-fg-muted">Assistant {turn.assistantMessage?.timestamp ? <ActorTimestamp timestamp={turn.assistantMessage.timestamp} /> : null}</p>
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
            <p role="status" className="text-sm text-fg-muted">
              Preparing response…
            </p>
          )}
          {turn.assistantMessage && !streaming ? <TurnReceipt turn={turn} /> : null}
        </div>
      ) : !failed && !partial ? (
        <p role="status" className="text-xs text-fg-muted">
          {stopped ? "Stopped" : humanizeToken(turn.trace.status)}
        </p>
      ) : null}
      {failed || partial ? (
        <div role="note" className="rounded-md border border-status-waiting p-2 text-sm text-fg-secondary" aria-label="Response recovery">
          {partial ? "This answer may be incomplete." : !assistantText ? "This response failed." : ""}
          {turn.trace.failure?.failureClass && turn.trace.failure.failureClass !== "unknown"
            ? ` Cause: ${humanizeToken(turn.trace.failure.failureClass)}.` : ""}{" "}
          {turn.trace.failure?.recommendedAction ? getChatTurnRecoveryActionSummary(turn.trace.failure.recommendedAction) : "Review run details or retry when available."}
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
      {!actions.historicalReadOnly && !streaming && actions.selectedSessionId && turn.trace.status === "completed" && turn.trace.completion?.status === "complete" ? <Suspense fallback={<p role="status">Loading skill capture…</p>}><WorkflowSkillCaptureControl turn={turn} sessionId={actions.selectedSessionId} workspaceId={actions.workspaceId} draftEmpty={!actions.draft.trim()} onPrepare={(prompt) => { actions.onDraftChange(prompt); actions.composerRef.current?.focus(); }} onReviewPlan={onReviewPlan} /></Suspense> : null}
    </article>
  );
}

type TranscriptFooterContext = {
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

function ChatTranscriptEmpty({ context }: { context?: TranscriptFooterContext }) {
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

function ChatTranscriptFooter({ context }: { context?: TranscriptFooterContext }) {
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
  const importantNotices = props.notices?.filter((notice) => notice.tone === "warning" || notice.tone === "critical") ?? [];
  const routineNotices = props.notices?.filter((notice) => notice.tone !== "warning" && notice.tone !== "critical") ?? [];
  // Notices remain owned by the conversation controller; only routine history folds away.
  const latestRoutine = routineNotices.reduce<(typeof routineNotices)[number] | undefined>((latest, notice) =>
    !latest || notice.timestamp > latest.timestamp ? notice : latest, undefined);
  return (
    <>
      <div className="mx-auto max-w-3xl px-3 pb-3 sm:px-6">
        {props.optimisticUserMessage &&
        !visibleTurns.some((turn) => turn.userMessage.messageId === props.optimisticUserMessage?.canonicalMessageId) ? (
          <p className="rounded-lg border border-line bg-raised p-3 text-sm text-fg-secondary">
            {props.optimisticUserMessage.content} · Sending…
          </p>
        ) : null}
        {pendingTurnId && !hasPreviewTurn && preview?.visibleText ? (
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
        {importantNotices.map((notice) => <div role="note" key={notice.id} className="rounded-md border border-status-waiting p-2 text-sm text-fg-secondary" aria-label="Conversation warning">{notice.content}</div>)}
        {latestRoutine ? <div role="note" className="rounded-md border border-line-subtle bg-raised p-2 text-sm text-fg-secondary" aria-label="Latest conversation update">{latestRoutine.content}</div> : null}
        <ChatThreadNotices notices={routineNotices.filter((notice) => notice !== latestRoutine)} scopeKey={props.selectedSessionId} />
        {receipt && !receipt.dismissed ? <ChatChangePlanCard {...receipt} /> : null}
        <ChatBlockers key={props.selectedSessionId} props={props} />
        {props.streamError && latestTurn?.trace.status !== "failed" && latestTurn?.trace.status !== "partial" ? (
          <ChatStreamErrorNotice error={props.streamError} source={props.streamErrorSource} />
        ) : null}
      </div>
      <div ref={context.threadEndRef} aria-hidden="true" className="h-px" />
    </>
  );
}

// Stable component identities preserve review and question input through owner refreshes.
const TRANSCRIPT_COMPONENTS = { EmptyPlaceholder: ChatTranscriptEmpty, Footer: ChatTranscriptFooter };
const IGNORE_BOTTOM_STATE = () => {};

export function ChatTranscript({
  props,
  gatewayUnavailable,
  receipt,
  onInspectTurn,
  onInspectRun,
  onOpenArtifact,
  onReviewPlan,
}: {
  props: MissionThreadedActiveSessionSurfaceProps;
  gatewayUnavailable?: boolean;
  receipt?: MissionThreadedRenderSurfaceInput["changePlanReceipt"];
  onInspectTurn?: (turnId: string) => void;
  onInspectRun?: (turnId: string) => void;
  onOpenArtifact?: (turnId: string, artifactId?: string) => void;
  onReviewPlan?: MissionThreadedRenderSurfaceInput["onReviewChangePlan"];
}) {

  const preview = useChatStreamingPreviewSnapshot(props.selectedSessionId);
  const turns = props.thread?.turns;
  const visibleTurns = useMemo(() => turns?.filter((turn) => turn.branch.isSelectedPath) ?? [], [turns]);
  const pendingTurnId = preview?.turnId ?? props.activeStreamingTurnId;
  const hasPreviewTurn = visibleTurns.some((turn) => turn.turnId === pendingTurnId);
  const latestTurn = visibleTurns.at(-1);
  const lifecycle = useRef<{ session: string | null; running: boolean }>({ session: props.selectedSessionId, running: false });
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const previous = lifecycle.current;
    if (previous.session !== props.selectedSessionId) setAnnouncement("");
    else if (props.hasActiveStream && !previous.running) setAnnouncement("Response started.");
    else if (!props.hasActiveStream && previous.running) setAnnouncement(latestTurn?.trace.status === "cancelled" ? "Response stopped." : latestTurn?.trace.status === "failed" ? "Response failed. Review the conversation details." : "Response ended. Review the answer and any pending decisions.");
    lifecycle.current = { session: props.selectedSessionId, running: props.hasActiveStream };
  }, [props.selectedSessionId, props.hasActiveStream, latestTurn?.trace.status]);
  const previewHasText = Boolean(preview?.visibleText);
  const conversationMessageIds = useMemo(() => visibleTurns.flatMap((turn) => [
    `${turn.turnId}:user`,
    ...(turn.assistantMessage || (preview?.turnId === turn.turnId && previewHasText) ? [`${turn.turnId}:assistant`] : []),
  ]), [visibleTurns, preview?.turnId, previewHasText]);
  // Reuse the shared Chat follow/read owner for growth within one virtualized
  // turn. Virtuoso's item-count follow alone misses later streamed batches.
  const { scrollRef, threadEndRef, handleThreadScroll, jumpToLatest, newMessageCount: unread } = useScrollToBottom<HTMLElement>({
    followOutput: props.followOutput,
    onBottomStateChange: props.onBottomStateChange ?? IGNORE_BOTTOM_STATE,
    signals: {
      sessionId: props.selectedSessionId,
      conversationMessageIds,
      threadTurnCount: visibleTurns.length + (props.optimisticUserMessage ? 1 : 0),
      latestTurnId: pendingTurnId ?? latestTurn?.turnId ?? null,
      latestTraceStatus: latestTurn?.trace.status ?? null,
      latestTurnToolRunCount: latestTurn?.toolRuns.length ?? 0,
      noticeCount: props.notices?.length ?? 0,
      queuedCount: props.queuedCount ?? 0,
      streamStatus: props.streamStatus,
      streamingPreviewSignal: preview ? `${preview.turnId}:${preview.visibleText.length}` : null,
      streamError: props.streamError ?? null,
    },
  });
  const lastScroll = useRef<{ top: number; height: number } | null>(null);
  const readingGesture = useRef(false);
  const observeReadingGesture = useCallback(
    (event: Event) => {
      if (
        event.type === "keydown" &&
        !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes((event as KeyboardEvent).key)
      )
        return;
      if (event.type === "pointerdown" && event.target !== scrollRef.current) return;
      readingGesture.current = true;
    },
    [scrollRef],
  );
  const observeScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const previous = lastScroll.current;
    const readerMoved = readingGesture.current;
    readingGesture.current = false;
    lastScroll.current = { top: element.scrollTop, height: element.scrollHeight };
    // Virtuoso can reset position while measuring a replacement or growing row.
    // Keep a pinned reader at the end through that layout change. Real wheel,
    // touch, keyboard and scrollbar input still enters the shared reading owner.
    if (props.followOutput && previous && element.scrollHeight !== previous.height && !readerMoved) {
      jumpToLatest();
      return;
    }
    handleThreadScroll();
  }, [scrollRef, handleThreadScroll, jumpToLatest, props.followOutput]);
  const scrollObservers = useRef({ observeScroll, observeReadingGesture });
  scrollObservers.current = { observeScroll, observeReadingGesture };
  const onNativeScroll = useCallback(() => scrollObservers.current.observeScroll(), []);
  const onReadingGesture = useCallback((event: Event) => scrollObservers.current.observeReadingGesture(event), []);
  const bindScroller = useCallback(
    (element: HTMLElement | Window | null) => {
      const next = element instanceof HTMLElement ? element : null;
      if (next === scrollRef.current) return;
      scrollRef.current?.removeEventListener("scroll", onNativeScroll);
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
        scrollRef.current?.removeEventListener(type, onReadingGesture);
      scrollRef.current = next;
      readingGesture.current = false;
      lastScroll.current = scrollRef.current
        ? { top: scrollRef.current.scrollTop, height: scrollRef.current.scrollHeight }
        : null;
      scrollRef.current?.addEventListener("scroll", onNativeScroll, { passive: true });
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
        scrollRef.current?.addEventListener(type, onReadingGesture, { passive: true });
    },
    [scrollRef, onNativeScroll, onReadingGesture],
  );

  if (props.historicalWindow || props.historicalWindowLoading || props.historicalWindowError)
    return <div role="region" aria-label="Historical messages" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><HistoricalConversationView props={props} /></div>;
  if (props.loading && !props.thread)
    return (
      <p role="status" className="flex-1 p-5 text-sm text-fg-muted">
        Loading conversation…
      </p>
    );
  if (!props.thread)
    return (
      <p role="alert" className="flex-1 p-5 text-sm text-fg-secondary">
        Conversation unavailable. Choose it again from the list to retry, or open it in the classic view.
      </p>
    );

  return (
    <div role="region" className="relative h-full min-h-0 flex-1" aria-label="Messages">
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
      {!props.followOutput ? <button type="button" onClick={jumpToLatest}
        className="absolute bottom-3 right-3 z-10 rounded-md border border-accent bg-overlay px-3 py-2 text-sm text-accent shadow-overlay">
        Jump to latest{unread ? ` · ${unread} new message${unread === 1 ? "" : "s"}` : ""}{props.pendingApproval || props.pendingUserInput ? " · Decision waiting" : ""}
      </button> : null}
      <Virtuoso<ChatThreadTurnRecord, TranscriptFooterContext>
        key={props.selectedSessionId}
        scrollerRef={bindScroller}
        data={visibleTurns}
        className="h-full w-full"
        followOutput={false}
        computeItemKey={(_index, turn) => turn.turnId}
        components={TRANSCRIPT_COMPONENTS}
        context={{
          props,
          gatewayUnavailable,
          receipt,
          preview,
          pendingTurnId,
          hasPreviewTurn,
          visibleTurns,
          latestTurn,
          onInspectTurn,
          onInspectRun,
          threadEndRef,
          jumpToLatest,
        }}
        itemContent={(_index, turn) => (
          <Turn
            turn={turn}
            previewText={preview?.turnId === turn.turnId ? preview.visibleText : null}
            streaming={pendingTurnId === turn.turnId && props.hasActiveStream}
            actions={props}
            onInspectTurn={onInspectTurn}
            onOpenArtifact={onOpenArtifact}
            onReviewPlan={onReviewPlan}
          />
        )}
      />
    </div>
  );
}
