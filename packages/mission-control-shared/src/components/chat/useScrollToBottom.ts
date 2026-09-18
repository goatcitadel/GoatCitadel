import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isThreadScrollNearBottom } from "./ChatThreadPrimitives";

/**
 * Content-change signals that should re-evaluate auto-follow / near-bottom state.
 *
 * These mirror the dependency inputs that both {@link ChatThreadView} and
 * `ThreadedTimeline` previously tracked inline. Splitting them out keeps the
 * shared follow/read effects identical in timing to the original components.
 */
export interface ScrollToBottomContentSignals {
  /** Session identity. A new session re-arms the bottom-sentinel observer. */
  sessionId: string | null;
  /** Number of rendered turns. Grows as new content streams in. */
  threadTurnCount: number;
  /** Active leaf / latest turn id. Changes when a new turn becomes the tail. */
  latestTurnId: string | null;
  /** Trace status of the latest turn. Changes as the tail turn progresses. */
  latestTraceStatus: string | null;
  /**
   * Number of tool runs on the latest turn. Grows live as the gateway streams
   * tool_start/tool_result into `turn.toolRuns` while the turn is running, so
   * the live activity rail's rows are covered by the same follow-output pin
   * as the rest of the turn's content (without this, the pinned-to-bottom
   * view would lag one row height behind each tool start).
   */
  latestTurnToolRunCount: number;
  /** Number of inline notices. */
  noticeCount: number;
  /** Number of queued turns. */
  queuedCount: number;
  /** Current stream status. */
  streamStatus: string;
  /** Streaming preview identity/length signal. Grows while text is revealed. */
  streamingPreviewSignal: string | null;
  /** Current stream error, if any (only re-triggers the follow write). */
  streamError: string | null;
  /** Selected-path message identities; exclude tool events and token updates. */
  conversationMessageIds?: readonly string[];
}

export interface UseScrollToBottomOptions {
  /** Whether the timeline should pin to the latest content as it arrives. */
  followOutput: boolean;
  /**
   * Notified when the operator's bottom proximity changes. The callback is
   * de-duplicated so it only fires on an actual transition, never on every
   * render. Callers wire this to follow-output state.
   */
  onBottomStateChange: (atBottom: boolean) => void;
  /** Content-change signals that should re-evaluate follow / near-bottom state. */
  signals: ScrollToBottomContentSignals;
}

export interface UseScrollToBottomResult<
  ScrollElement extends HTMLElement = HTMLDivElement,
  SentinelElement extends HTMLElement = HTMLDivElement,
> {
  /** Attach to the scrollable transcript container. */
  scrollRef: RefObject<ScrollElement | null>;
  /** Attach to the bottom sentinel element (rendered after the last turn). */
  threadEndRef: RefObject<SentinelElement | null>;
  /** Wire to the scroll container's `onScroll`. */
  handleThreadScroll: () => void;
  /** Stable action that scrolls to the latest content and pins to bottom. */
  jumpToLatest: () => void;
  newMessageCount: number;
}

/**
 * Shared scroll auto-follow machinery for chat-style transcripts.
 *
 * Encapsulates the scroll container ref + bottom sentinel, near-bottom
 * tracking, auto-follow-on-new-content (rAF-batched scroll write), a stable
 * `jumpToLatest`, and a de-duplicated bottom-state callback. The follow WRITE
 * and the near-bottom READ are kept as separate layout effects so they do not
 * thrash one another, preserving the exact behavior the consuming components
 * had when each maintained this logic independently.
 */
export function useScrollToBottom<
  ScrollElement extends HTMLElement = HTMLDivElement,
  SentinelElement extends HTMLElement = HTMLDivElement,
>({
  followOutput,
  onBottomStateChange,
  signals,
}: UseScrollToBottomOptions): UseScrollToBottomResult<ScrollElement, SentinelElement> {
  const scrollRef = useRef<ScrollElement | null>(null);
  const threadEndRef = useRef<SentinelElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const lastBottomStateRef = useRef<boolean | null>(null);
  const followingRef = useRef(followOutput);
  followingRef.current = followOutput;
  const readingAnchorRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const captureReadingAnchor = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top;
    const blocks = scroller.querySelectorAll<HTMLElement>("[data-turn-id] p, [data-turn-id] li, [data-turn-id] pre, [data-turn-id] tr, [data-turn-id] summary");
    const element = Array.from(blocks.length ? blocks : scroller.querySelectorAll<HTMLElement>("[data-turn-id]"))
      .find((block) => block.getBoundingClientRect().bottom > top);
    readingAnchorRef.current = element ? { element, top: element.getBoundingClientRect().top - top } : null;
  }, []);
  const unreadRef = useRef({ sessionId: signals.sessionId, previous: [] as readonly string[], unread: new Set<string>() });
  const [newMessageCount, setNewMessageCount] = useState(0);
  useLayoutEffect(() => {
    const ids = signals.conversationMessageIds ?? [];
    const state = unreadRef.current;
    const previousTail = state.previous.at(-1);
    // A missing former tail denotes a branch change/replacement, not new output.
    if (state.sessionId !== signals.sessionId || followOutput || (previousTail && !ids.includes(previousTail))) {
      state.unread.clear();
    } else if (previousTail) {
      for (const id of ids.slice(ids.indexOf(previousTail) + 1)) state.unread.add(id);
    }
    state.sessionId = signals.sessionId;
    state.previous = ids;
    setNewMessageCount(state.unread.size);
  }, [followOutput, signals.sessionId, signals.conversationMessageIds]);

  const {
    sessionId,
    threadTurnCount,
    latestTurnId,
    latestTraceStatus,
    latestTurnToolRunCount,
    noticeCount,
    queuedCount,
    streamStatus,
    streamingPreviewSignal,
    streamError,
  } = signals;

  // De-duplicate the bottom-state callback so it only fires on an actual
  // transition. The consumer wires this to a `useState` setter, so identical
  // repeats were already no-ops; collapsing them here avoids redundant calls
  // without changing observable behavior.
  const emitBottomState = useCallback(
    (atBottom: boolean) => {
      if (lastBottomStateRef.current === atBottom) {
        return;
      }
      lastBottomStateRef.current = atBottom;
      onBottomStateChange(atBottom);
    },
    [onBottomStateChange],
  );

  const handleThreadScroll = useCallback(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      emitBottomState(true);
      return;
    }
    const atBottom = isThreadScrollNearBottom(scrollElement);
    followingRef.current = atBottom;
    if (!atBottom && scrollFrameRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    if (atBottom) {
      readingAnchorRef.current = null;
      unreadRef.current.unread.clear();
      setNewMessageCount(0);
    } else {
      captureReadingAnchor();
    }
    emitBottomState(atBottom);
  }, [emitBottomState, captureReadingAnchor]);

  // Preserve the reader's visible turn when disclosures/code highlighting or
  // prepended history change heights. Native anchoring may already compensate;
  // the measured delta is then zero, so it is never applied twice.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (followOutput) {
      readingAnchorRef.current = null;
      return;
    }
    const restore = () => {
      if (followingRef.current) return;
      const anchor = readingAnchorRef.current;
      if (anchor && scroller.contains(anchor.element)) {
        const delta = anchor.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top;
        if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
      }
      captureReadingAnchor();
    };
    restore();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(restore);
    for (const child of Array.from(scroller.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [followOutput, sessionId, threadTurnCount, captureReadingAnchor]);

  // READ: bottom-sentinel observer reports proximity as the operator scrolls
  // or as new content shifts the sentinel into / out of view. Re-armed when the
  // session changes or the turn count grows.
  useEffect(() => {
    const scrollElement = scrollRef.current;
    const endElement = threadEndRef.current;
    if (
      !scrollElement ||
      !endElement ||
      typeof window === "undefined" ||
      typeof window.IntersectionObserver !== "function"
    ) {
      return;
    }
    const observer = new window.IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const atBottom = Boolean(entry?.isIntersecting) || isThreadScrollNearBottom(scrollElement);
        if (atBottom || !followOutput) {
          emitBottomState(atBottom);
        }
      },
      {
        root: scrollElement,
        threshold: 0.98,
      },
    );
    observer.observe(endElement);
    return () => observer.disconnect();
  }, [emitBottomState, followOutput, sessionId, threadTurnCount]);

  const jumpToLatest = useCallback(() => {
    followingRef.current = true;
    unreadRef.current.unread.clear();
    setNewMessageCount(0);
    threadEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    emitBottomState(true);
  }, [emitBottomState]);

  // WRITE: while following, pin the transcript to its end whenever new content
  // arrives. Batched through requestAnimationFrame so layout-thrashing reads in
  // the sibling effect never interleave with this write.
  useLayoutEffect(() => {
    if (!followOutput) {
      return;
    }
    const pinToThreadEnd = () => {
      if (!followingRef.current) return;
      threadEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
      emitBottomState(true);
    };
    if (typeof requestAnimationFrame !== "function") {
      pinToThreadEnd();
      return;
    }
    if (scrollFrameRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      pinToThreadEnd();
    });
    return () => {
      if (scrollFrameRef.current !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [
    followOutput,
    latestTraceStatus,
    latestTurnId,
    latestTurnToolRunCount,
    noticeCount,
    emitBottomState,
    queuedCount,
    streamError,
    streamStatus,
    streamingPreviewSignal,
    threadTurnCount,
  ]);

  // READ: when not following, re-sync the near-bottom flag from the live scroll
  // position after content changes so the jump-to-latest affordance stays
  // accurate without writing scroll position.
  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }
    if (followOutput) {
      return;
    }
    emitBottomState(isThreadScrollNearBottom(scrollElement));
  }, [
    followOutput,
    latestTraceStatus,
    latestTurnId,
    latestTurnToolRunCount,
    noticeCount,
    emitBottomState,
    queuedCount,
    streamStatus,
    streamingPreviewSignal,
    threadTurnCount,
  ]);

  return {
    scrollRef,
    threadEndRef,
    handleThreadScroll,
    jumpToLatest,
    newMessageCount,
  };
}
