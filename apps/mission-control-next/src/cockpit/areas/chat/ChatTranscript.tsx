import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { Turn, ChatTranscriptEmpty, ChatTranscriptFooter, type TranscriptFooterContext } from "./ChatTranscriptContent";
import { turnReadsDraft, useTurnActions } from "./use-turn-actions";
import type { ChannelConversationContext } from "./channel-conversation";
import { useChannelReading } from "./use-channel-conversation";
import {
  hasUnsettledChatContextMutation,
  CHAT_CONTEXT_RELOAD_NOTE,
} from "@goatcitadel/mission-control-shared/state/scoped-operation-attempts";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { useDeferredVirtuoso } from "../../ui/DeferredVirtuoso";
import { Button } from "../../ui/Button";
import { isBackgroundChatUserInputPrompt, type ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { useChatStreamingPreviewSnapshot } from "@goatcitadel/mission-control-shared/state/chat-streaming-preview-store";
import { HistoricalConversationView } from "../../../features/threaded-surface/ThreadHistoricalConversation";
import { useScrollToBottom } from "@goatcitadel/mission-control-shared/components/chat/useScrollToBottom";
import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { ChatTranscriptNavigation } from "./ChatTranscriptNavigation";
import "../../../features/threaded-surface/styles/code-highlight.css";
import "../../styles/chat-display.css";

const TRANSCRIPT_COMPONENTS = { EmptyPlaceholder: ChatTranscriptEmpty };

const IGNORE_BOTTOM_STATE = () => {};
const READING_GESTURE_TAIL_MS = 400;

export function ChatTranscript({
  props,
  channel,
  gatewayUnavailable,
  receipt,
  onInspectTurn,
  onInspectRun,
  onOpenArtifact,
  onReviewPlan,
  onNewConversation,
}: {
  props: MissionThreadedActiveSessionSurfaceProps;
  /** Set when the open conversation is held through a channel; callers keep the object stable. */
  channel?: ChannelConversationContext;
  gatewayUnavailable?: boolean;
  receipt?: MissionThreadedRenderSurfaceInput["changePlanReceipt"];
  onInspectTurn?: (turnId: string) => void;
  onInspectRun?: (turnId: string) => void;
  onOpenArtifact?: (turnId: string, artifactId?: string) => void;
  onReviewPlan?: MissionThreadedRenderSurfaceInput["onReviewChangePlan"];
  /** Opens a fresh conversation; a failed turn offers it when the conversation is too long for the model. */
  onNewConversation?: () => void;
}) {
  const preview = useChatStreamingPreviewSnapshot(props.selectedSessionId);
  const turns = props.thread?.turns;
  const scopeKey = useMemo(
    () => JSON.stringify([props.workspaceId, props.selectedSessionId]),
    [props.workspaceId, props.selectedSessionId],
  );
  const visibleTurns = useMemo(() => turns?.filter((turn) => turn.branch.isSelectedPath) ?? [], [turns]);
  const pendingTurnId = preview?.turnId ?? props.activeStreamingTurnId;
  const hasPreviewTurn = visibleTurns.some((turn) => turn.turnId === pendingTurnId);
  const latestTurn = visibleTurns.at(-1);
  const newChannelMessages = useChannelReading(channel, visibleTurns, props);
  const lifecycle = useRef<{ session: string | null; running: boolean }>({
    session: props.selectedSessionId,
    running: false,
  });
  const [announcement, setAnnouncement] = useState("");
  const decisionWaiting = Boolean(
    props.pendingApproval || (props.pendingUserInput && !isBackgroundChatUserInputPrompt(props.pendingUserInput)),
  );
  useEffect(() => {
    const previous = lifecycle.current;
    if (previous.session !== props.selectedSessionId) setAnnouncement("");
    else if (props.hasActiveStream && !previous.running) setAnnouncement("Response started.");
    else if (!props.hasActiveStream && previous.running)
      setAnnouncement(
        latestTurn?.trace.status === "cancelled"
          ? "Response stopped."
          : latestTurn?.trace.status === "failed"
            ? "Response failed. Review the conversation details."
            : decisionWaiting
              ? "Response ended. A decision is waiting for you."
              : "Response ended.",
      );
    lifecycle.current = { session: props.selectedSessionId, running: props.hasActiveStream };
  }, [props.selectedSessionId, props.hasActiveStream, latestTurn?.trace.status, decisionWaiting]);
  const previewHasText = Boolean(preview?.visibleText);
  const conversationMessageIds = useMemo(
    () =>
      visibleTurns.flatMap((turn) => [
        `${turn.turnId}:user`,
        ...(turn.assistantMessage || (preview?.turnId === turn.turnId && previewHasText)
          ? [`${turn.turnId}:assistant`]
          : []),
      ]),
    [visibleTurns, preview?.turnId, previewHasText],
  );
  // Reuse the shared Chat follow/read owner for growth within one virtualized
  // turn. Virtuoso's item-count follow alone misses later streamed batches.
  const {
    scrollRef,
    threadEndRef,
    handleThreadScroll,
    jumpToLatest,
    newMessageCount: unread,
  } = useScrollToBottom<HTMLElement>({
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
  const turnKeys = useMemo(() => visibleTurns.map((turn) => turn.turnId), [visibleTurns]);
  const {
    Virtuoso,
    virtualized,
    initialIndex,
    rangeChanged,
    failure: virtualizationFailure,
    retry: retryVirtualization,
  } = useDeferredVirtuoso({
    needed: visibleTurns.length > 100,
    host: scrollRef,
    attribute: "data-turn-id",
    keys: turnKeys,
    scopeKey,
  });
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const lastScroll = useRef<{ top: number; height: number } | null>(null);
  const readingGesture = useRef(false);
  // One drag, fling or animated wheel/key scroll emits several scroll events.
  // Reader intent lasts while a pointer or touch is held and briefly after.
  const gestureHeld = useRef(false);
  const gestureUntil = useRef(0);
  const observeReadingGesture = useCallback(
    (event: Event) => {
      if (
        event.type === "keydown" &&
        !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes((event as KeyboardEvent).key)
      )
        return;
      if (event.type === "pointerdown" && event.target !== scrollRef.current) return;
      if (event.type === "pointerdown" || event.type === "touchstart") gestureHeld.current = true;
      readingGesture.current = true;
      gestureUntil.current = performance.now() + READING_GESTURE_TAIL_MS;
    },
    [scrollRef],
  );
  useEffect(() => {
    const release = () => {
      if (!gestureHeld.current) return;
      gestureHeld.current = false;
      gestureUntil.current = performance.now() + READING_GESTURE_TAIL_MS;
    };
    const types = ["pointerup", "pointercancel", "touchend", "touchcancel"];
    for (const type of types) window.addEventListener(type, release, { passive: true });
    return () => {
      for (const type of types) window.removeEventListener(type, release);
    };
  }, []);
  const observeScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const previous = lastScroll.current;
    const readerMoved = readingGesture.current || gestureHeld.current || performance.now() < gestureUntil.current;
    readingGesture.current = false;
    lastScroll.current = { top: element.scrollTop, height: element.scrollHeight };
    // Virtuoso can reset position while measuring a replacement or growing row.
    // Keep a pinned reader at the end through that layout change. Real wheel,
    // touch, keyboard and scrollbar input still enters the shared reading owner.
    // A box that was hidden or re-laid out (a suspended subtree, a theme or font
    // swap) can also come back at the very top with an unchanged height; without
    // a reader gesture that reset is layout, not reading.
    const layoutReset = element.scrollTop <= 1 && previous !== null && previous.top > 1;
    if (props.followOutput && previous && (element.scrollHeight !== previous.height || layoutReset) && !readerMoved) {
      jumpToLatest();
      return;
    }
    handleThreadScroll();
  }, [scrollRef, handleThreadScroll, jumpToLatest, props.followOutput]);
  const onTranscriptBoundaryKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        event.target !== event.currentTarget ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "Home" && event.key !== "End")
      )
        return;
      // Browser keyboard scrolling animates against an estimated virtual height.
      // Use the shared reading/follow owner at the actual boundary instead.
      event.preventDefault();
      if (event.key === "End") {
        jumpToLatest();
        return;
      }
      readingGesture.current = true;
      event.currentTarget.scrollTop = 0;
      observeScroll();
    },
    [observeScroll, jumpToLatest],
  );
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
      setScrollElement(next);
      readingGesture.current = false;
      gestureHeld.current = false;
      gestureUntil.current = 0;
      lastScroll.current = scrollRef.current
        ? { top: scrollRef.current.scrollTop, height: scrollRef.current.scrollHeight }
        : null;
      scrollRef.current?.addEventListener("scroll", onNativeScroll, { passive: true });
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
        scrollRef.current?.addEventListener(type, onReadingGesture, { passive: true });
    },
    [scrollRef, onNativeScroll, onReadingGesture],
  );
  const virtuoso = useRef<VirtuosoHandle>(null);
  // A jump to a message is the reader moving, so the transcript stops following new output, as it does for Home.
  const markReaderJump = useCallback(() => {
    readingGesture.current = true;
    gestureUntil.current = performance.now() + READING_GESTURE_TAIL_MS;
  }, []);
  const newConversation = useRef(onNewConversation);
  useEffect(() => {
    newConversation.current = onNewConversation;
  }, [onNewConversation]);
  const startNewConversation = useCallback(() => newConversation.current?.(), []);
  const offerNewConversation = onNewConversation ? startNewConversation : undefined;
  const turnActions = useTurnActions(props, onReviewPlan);

  if (props.historicalWindow || props.historicalWindowLoading || props.historicalWindowError)
    return (
      <div
        role="region"
        aria-label="Historical messages"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <h2 className="sr-only">Historical messages</h2>
        <HistoricalConversationView props={props} />
      </div>
    );
  if (props.loading && !props.thread)
    return (
      <p role="status" className="flex-1 p-5 text-sm text-fg-muted">
        Loading conversation…
      </p>
    );
  if (!props.thread)
    return (
      <div className="flex-1 space-y-2 p-5 text-sm text-fg-secondary">
        <p role="alert">
          {gatewayUnavailable
            ? "This conversation can’t load while GoatCitadel is unreachable. Reload it once GoatCitadel is back."
            : "This conversation couldn’t load. Reload it, or choose it again from the list."}
        </p>
        <Button size="sm" onClick={props.onRefreshThread}>
          Reload conversation
        </Button>
      </div>
    );

  const fallbackTurns =
    visibleTurns.length > 100
      ? visibleTurns.slice(props.followOutput ? -100 : 0, props.followOutput ? undefined : 100)
      : visibleTurns;
  const fallbackOffset = props.followOutput ? visibleTurns.length - fallbackTurns.length : 0;
  // Only a stopped latest turn can offer Continue, which follows the live draft and send state.
  const continueTurnId = latestTurn?.trace.status === "cancelled" ? latestTurn.turnId : undefined;
  const renderTurn = (turn: ChatThreadTurnRecord, position: number) => (
    <Turn
      turn={turn}
      position={position}
      isLatest={turn.turnId === latestTurn?.turnId}
      previewText={preview?.turnId === turn.turnId ? preview.visibleText : null}
      streaming={pendingTurnId === turn.turnId && props.hasActiveStream}
      actions={turnActions}
      draftEmpty={turnReadsDraft(turn) ? !props.draft.trim() : true}
      continueActions={turn.turnId === continueTurnId ? props : undefined}
      channel={channel}
      newMessageCount={newChannelMessages?.turnId === turn.turnId ? newChannelMessages.count : undefined}
      onInspectTurn={onInspectTurn}
      onOpenArtifact={onOpenArtifact}
      onNewConversation={offerNewConversation}
    />
  );
  const footerContext: TranscriptFooterContext = {
    ...(virtualized ? {} : { renderedTurns: fallbackTurns }),
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
  };
  return (
    <div role="region" className="relative h-full min-h-0 flex-1" aria-label="Messages">
      <h2 className="sr-only">Messages</h2>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <ChatTranscriptNavigation
        scroller={scrollElement}
        turns={visibleTurns}
        turnKeys={turnKeys}
        virtuoso={virtuoso}
        onReaderJump={markReaderJump}
      />
      {!props.followOutput ? (
        <button
          type="button"
          onClick={() => {
            jumpToLatest();
            // CH-18: the button unmounts once the reader is at the end, so focus moves to the composer.
            const composer = props.composerRef.current;
            if (composer && !composer.disabled) composer.focus({ preventScroll: true });
            else scrollRef.current?.focus({ preventScroll: true });
          }}
          className="absolute bottom-3 right-3 z-10 rounded-md border border-accent bg-overlay px-3 py-2 text-sm text-accent shadow-overlay"
        >
          Jump to latest{unread ? ` · ${plural(unread, "new message")}` : ""}
        </button>
      ) : null}
      <div
        key={scopeKey}
        ref={bindScroller}
        data-transcript-scroller
        data-follow-output="false"
        tabIndex={0}
        onKeyDown={onTranscriptBoundaryKey}
        // #497: `relative` makes the scroller the containing block of the turns' absolute sr-only headings, so their
        // overflow stays inside it instead of escaping to <main> and shifting the header and composer.
        className="relative h-full w-full overflow-y-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <div className="w-full">
          {virtualized && Virtuoso && scrollElement ? (
            <Virtuoso<ChatThreadTurnRecord, TranscriptFooterContext>
              key={props.selectedSessionId}
              ref={virtuoso}
              customScrollParent={scrollElement}
              data={visibleTurns}
              initialTopMostItemIndex={props.followOutput ? visibleTurns.length - 1 : (initialIndex ?? 0)}
              rangeChanged={rangeChanged}
              // Render the first row immediately, then measure actual long and enlarged-text row heights.
              initialItemCount={Math.min(visibleTurns.length, 1)}
              className="w-full"
              followOutput={false}
              computeItemKey={(_index, turn) => turn.turnId}
              components={TRANSCRIPT_COMPONENTS}
              // Virtualized, the footer context carries no rendered-turn subset, so it is exactly Virtuoso's context.
              context={footerContext}
              itemContent={(index, turn) => renderTurn(turn, index + 1)}
            />
          ) : (
            <>
              {fallbackTurns.map((turn, index) => (
                <div key={turn.turnId}>{renderTurn(turn, fallbackOffset + index + 1)}</div>
              ))}
              {!visibleTurns.length ? <ChatTranscriptEmpty context={footerContext} /> : null}
            </>
          )}
        </div>
        {!virtualized && visibleTurns.length > 100 ? (
          virtualizationFailure ? (
            <p role="alert" className="p-3 text-sm text-fg-muted">
              More messages could not be shown. Visible messages and pending decisions are still available.{" "}
              <button type="button" onClick={retryVirtualization} className="text-accent underline">
                Try again
              </button>{" "}
              ·{" "}
              <button
                type="button"
                disabled={hasUnsettledChatContextMutation()}
                title={hasUnsettledChatContextMutation() ? CHAT_CONTEXT_RELOAD_NOTE : undefined}
                onClick={() => {
                  if (!hasUnsettledChatContextMutation()) window.location.reload();
                }}
                className="text-accent underline"
              >
                Reload app
              </button>
            </p>
          ) : (
            <p role="status" className="p-3 text-sm text-fg-muted">
              Loading {visibleTurns.length} conversation turns…
            </p>
          )
        ) : null}
        <ChatTranscriptFooter context={footerContext} />
      </div>
    </div>
  );
}
