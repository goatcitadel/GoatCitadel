import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ChatCitationRecord, type ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { ChatStreamStatusBar } from "@goatcitadel/mission-control-shared/components/chat/ChatStreamStatusBar";
import { SurfaceReconnectBanner } from "@goatcitadel/mission-control-shared/components/chat/SurfaceReconnectBanner";
import {
  formatMemoryCitationMeta,
  formatMemorySignals,
  isMemoryCitation,
  normalizeCitationDisplayText,
} from "@goatcitadel/mission-control-shared/components/chat/assistant-display-text";
import { toTitleCase } from "@goatcitadel/mission-control-shared/components/chat/chat-display-helpers";
import {
  ChatThreadDelegationSummary,
  ChatThreadNotices,
  ChatThreadTurnCard,
  ChatThreadWindowGap,
  THREAD_WINDOW_SIZE,
  buildThreadWindow,
} from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { useScrollToBottom } from "@goatcitadel/mission-control-shared/components/chat/useScrollToBottom";
import {
  useChannelActivitySnapshot,
  type ChannelActivitySnapshot,
} from "@goatcitadel/mission-control-shared/state/channel-activity-store";
import { useOptionalStableHandler, useStableHandler } from "./useStableHandler";

function ChannelActivityBadge({ activity }: { activity: ChannelActivitySnapshot | null }) {
  if (!activity) {
    return null;
  }
  return (
    <span
      className={`mc-next-thread-channel-activity phase-${activity.phase}`}
      title={`${activity.label} on ${activity.channelKey ?? "channel"}`}
      aria-label={`Channel activity: ${activity.label}`}
    >
      <span aria-hidden="true">{activity.emoji}</span>
      <span>{activity.label}</span>
    </span>
  );
}

/*
 * Each turn subscribes to channel activity on its own. Keeping the store
 * subscription out of ThreadedTimeline keeps `renderUserMetaAddon` stable, so
 * a realtime activity event (possibly for another session) no longer
 * invalidates the memo of every visible turn card.
 */
function TurnChannelActivityBadge({ sessionId, messageId }: { sessionId: string | null; messageId: string }) {
  const activity = useChannelActivitySnapshot(sessionId, messageId);
  return <ChannelActivityBadge activity={activity} />;
}

function isSafeCitationHref(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const GROUPING_WINDOW_MS = 2 * 60 * 1000;
const STREAM_SCROLL_CHARACTER_BUCKET = 128;

function isTurnGroupedWith(previous: ChatThreadTurnRecord, current: ChatThreadTurnRecord): boolean {
  const previousActor = previous.userMessage.actorId;
  const currentActor = current.userMessage.actorId;
  if (!previousActor || previousActor !== currentActor) {
    return false;
  }
  const previousTime = Date.parse(previous.userMessage.timestamp);
  const currentTime = Date.parse(current.userMessage.timestamp);
  if (Number.isNaN(previousTime) || Number.isNaN(currentTime)) {
    return false;
  }
  return Math.abs(currentTime - previousTime) <= GROUPING_WINDOW_MS;
}

function formatCitationSource(citation: ChatCitationRecord): string {
  if (isMemoryCitation(citation)) {
    if (citation.knowledge) {
      return citation.knowledge.retrievalMode === "full_text" ? "memory full text" : "memory retrieval";
    }
    return "memory";
  }
  if (citation.knowledge) {
    return citation.knowledge.retrievalMode === "full_text" ? "knowledge full text" : "knowledge retrieval";
  }
  return citation.sourceType ?? "source";
}

function ThreadCitationList({ citations }: { citations: ChatCitationRecord[] }) {
  const [expanded, setExpanded] = useState(false);
  if (citations.length === 0) {
    return null;
  }
  const collapsedLimit = 6;
  const visibleCitations = expanded ? citations : citations.slice(0, collapsedLimit);
  const hiddenCount = citations.length - visibleCitations.length;
  return (
    <div className="mc-next-thread-citations" aria-label="Citations for this answer">
      {visibleCitations.map((citation, index) => {
        const label = normalizeCitationDisplayText(citation.title) || citation.url;
        const snippet = normalizeCitationDisplayText(citation.snippet);
        const source = formatCitationSource(citation);
        const safeHref = isSafeCitationHref(citation.url);
        const memoryWhyUsed = isMemoryCitation(citation)
          ? (citation.provenance?.selectionReason ?? "Memory selection reason was not recorded.")
          : null;
        const memoryMeta = formatMemoryCitationMeta(citation.provenance);
        const memorySignals = formatMemorySignals(citation.provenance?.matchSignals);
        const memoryCitation = isMemoryCitation(citation);
        return (
          <article
            key={citation.citationId || `${citation.url}-${index}`}
            className={memoryCitation ? "is-memory" : undefined}
          >
            <div>
              <strong>{index + 1}</strong>
              {safeHref ? (
                <a href={citation.url} target="_blank" rel="noreferrer">
                  {label}
                </a>
              ) : (
                <span>{label}</span>
              )}
            </div>
            <p>
              {source}
              {snippet ? ` · ${snippet}` : ""}
            </p>
            {memoryWhyUsed ? <p className="citation-memory-reason">Why used: {memoryWhyUsed}</p> : null}
            {memoryMeta ? <p className="citation-memory-meta">{memoryMeta}</p> : null}
            {memorySignals ? <p className="citation-memory-meta">{memorySignals}</p> : null}
          </article>
        );
      })}
      {citations.length > collapsedLimit ? (
        <button
          type="button"
          className="mc-next-thread-inline-button mc-next-thread-citations-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show fewer citations" : `Show ${hiddenCount} more citations`}
        </button>
      ) : null}
    </div>
  );
}

const CHAT_STARTER_PROMPTS = [
  {
    label: "Orient me",
    prompt: "Summarize the current workspace state and suggest the safest next step.",
  },
  {
    label: "Plan a task",
    prompt: "Turn this goal into a short plan with risks, open questions, and a first action.",
  },
  {
    label: "Review context",
    prompt: "Review the available context and call out what is known, missing, and uncertain.",
  },
] as const;

function ChatFirstMessageCanvas({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const readinessCards = buildChatReadinessCards(props);
  const applyStarterPrompt = (prompt: string) => {
    props.onDraftChange(prompt);
    props.composerRef.current?.focus();
  };

  return (
    <div className="mc-next-chat-start-canvas">
      <div className="mc-next-chat-start-hero">
        <p className="mc-next-thread-meta">
          <strong>Chat ready</strong>
        </p>
        <h2>What should we tackle?</h2>
        <p>Runtime, policy, and context are visible before the first send.</p>
      </div>

      <div className="mc-next-chat-start-readiness" aria-label="Chat readiness">
        {readinessCards.map((card) => (
          <article key={card.label} className={`mc-next-chat-start-card tone-${card.tone}`}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </article>
        ))}
      </div>

      <div className="mc-next-chat-start-section">
        <h3>Starter prompts</h3>
        <div className="mc-next-chat-start-prompts">
          {CHAT_STARTER_PROMPTS.map((starter) => (
            <button
              key={starter.label}
              type="button"
              className="mc-next-chat-start-prompt"
              onClick={() => applyStarterPrompt(starter.prompt)}
            >
              <strong>{starter.label}</strong>
              <span>{starter.prompt}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mc-next-chat-start-actions" aria-label="Chat handoff actions">
        <button
          type="button"
          className="mc-next-thread-inline-button"
          onClick={() => props.onNavigateSurface("cowork")}
        >
          Continue in Cowork
        </button>
        <button type="button" className="mc-next-thread-inline-button" onClick={() => props.onNavigateSurface("code")}>
          Open in Code
        </button>
        <button type="button" className="mc-next-thread-inline-button" onClick={props.onAttachFiles}>
          Attach files
        </button>
        {props.approvalsCount > 0 ? (
          <button type="button" className="mc-next-thread-inline-button" onClick={() => props.onOpenApprovals()}>
            Approvals ({props.approvalsCount})
          </button>
        ) : null}
      </div>
    </div>
  );
}

function buildChatReadinessCards(props: MissionThreadedActiveSessionSurfaceProps) {
  const contextValue = props.contextSelection
    ? `${props.contextSelection.label} · ${props.contextSelection.turnCount} selected`
    : props.outboundContext
      ? props.outboundContext.sourceLabel
        ? `${props.outboundContext.label} · ${props.outboundContext.sourceLabel}`
        : props.outboundContext.label
      : props.pendingAttachments.length > 0
        ? `${props.pendingAttachments.length} attachment${props.pendingAttachments.length === 1 ? "" : "s"} pending`
        : "No extra context selected";

  return [
    { label: "Model", value: props.trust.providerModelSummary, tone: "default" },
    { label: "Runtime", value: props.trust.runtimeSummary, tone: props.trust.runtimeTone ?? "muted" },
    { label: "Policy", value: props.trust.approvalsSummary, tone: props.approvalsCount > 0 ? "warning" : "muted" },
    { label: "Context", value: contextValue, tone: props.contextSelection || props.outboundContext ? "live" : "muted" },
  ] as const;
}

export function resolveStreamingPreviewScrollSignal(
  preview: MissionThreadedActiveSessionSurfaceProps["streamingPreview"],
  activeStreamingTurnId: string | null | undefined,
): string | null {
  if (!preview) {
    return activeStreamingTurnId ?? null;
  }
  const visibleLineCount = preview.visibleText.length > 0 ? preview.visibleText.split("\n").length : 0;
  const visibleCharacterBucket = Math.floor(preview.visibleText.length / STREAM_SCROLL_CHARACTER_BUCKET);
  return [preview.turnId, visibleLineCount, visibleCharacterBucket, preview.isRunning ? "running" : "idle"].join(":");
}

export function ThreadedTimeline({
  props,
  onOpenUniversalRunDetail,
}: {
  props: MissionThreadedActiveSessionSurfaceProps;
  onOpenUniversalRunDetail?: (runId: string) => void;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [manualWindowStart, setManualWindowStart] = useState<number | null>(null);
  const lastTurn = props.thread?.turns.at(-1) ?? null;
  const threadTurnCount = props.thread?.turns.length ?? 0;
  const latestTurnId = props.thread?.activeLeafTurnId ?? lastTurn?.turnId ?? null;
  const latestTraceStatus = lastTurn?.trace.status ?? null;
  const sessionId = props.thread?.sessionId ?? null;
  const selectedContextTurnIdSet = useMemo(
    () => new Set(props.selectedContextTurnIds ?? []),
    [props.selectedContextTurnIds],
  );
  const renderUserMetaAddon = useCallback(
    (turn: ChatThreadTurnRecord) => (
      <TurnChannelActivityBadge sessionId={sessionId} messageId={turn.userMessage.messageId} />
    ),
    [sessionId],
  );
  const renderCitationList = useCallback(
    (turn: ChatThreadTurnRecord) => <ThreadCitationList citations={turn.citations} />,
    [],
  );

  /*
   * The controller host rebuilds every handler per render (and renders at
   * animation-frame cadence during streaming). Stable wrappers keep
   * ChatThreadTurnCard's memo effective so only the streaming card re-renders
   * per preview flush.
   */
  const onToggleContextTurn = useStableHandler(props.onToggleContextTurn);
  const onSelectTurn = useStableHandler(props.onSelectTurn);
  const onStartNewThreadFromTurn = useStableHandler(props.onStartNewThreadFromTurn);
  const onSwitchBranch = useStableHandler(props.onSwitchBranch);
  const onRetryTurn = useStableHandler(props.onRetryTurn);
  const onOpenRunDetails = useStableHandler(props.onOpenRunDetails);
  const onOpenGeneratedArtifact = useStableHandler(props.onOpenGeneratedArtifact);
  const onCreateGeneratedArtifact = useStableHandler(props.onCreateGeneratedArtifact);
  const onCreateGeneratedArtifactVersion = useStableHandler(props.onCreateGeneratedArtifactVersion);
  const onOpenUniversalRunDetailStable = useOptionalStableHandler(onOpenUniversalRunDetail);
  const defaultWindowStart = Math.max(0, threadTurnCount - THREAD_WINDOW_SIZE);
  const effectiveWindowStart = Math.min(manualWindowStart ?? defaultWindowStart, defaultWindowStart);
  const windowedThreadItems = useMemo(
    () =>
      buildThreadWindow({
        turns: props.thread?.turns ?? [],
        windowStart: effectiveWindowStart,
        selectedTurnId: props.selectedTurnId,
        contextTurnIds: props.selectedContextTurnIds ?? [],
        streamingTurnId: props.activeStreamingTurnId ?? props.streamingPreview?.turnId ?? null,
      }),
    [
      effectiveWindowStart,
      props.activeStreamingTurnId,
      props.selectedContextTurnIds,
      props.selectedTurnId,
      props.streamingPreview?.turnId,
      props.thread?.turns,
    ],
  );
  const liveStatus =
    props.streamError ||
    (props.streamStatus === "streaming"
      ? `${toTitleCase(props.mode)} response streaming${props.queuedCount > 0 ? ` with ${props.queuedCount} queued` : ""}.`
      : props.streamStatus === "queued"
        ? `${toTitleCase(props.mode)} turn queued.`
        : props.streamStatus === "connecting"
          ? `${toTitleCase(props.mode)} stream connecting.`
          : "");
  const streamingPreviewSignal = resolveStreamingPreviewScrollSignal(
    props.streamingPreview,
    props.activeStreamingTurnId,
  );

  const { scrollRef, threadEndRef, handleThreadScroll, jumpToLatest } = useScrollToBottom({
    followOutput: props.followOutput,
    onBottomStateChange: props.onBottomStateChange,
    signals: {
      sessionId: props.thread?.sessionId ?? null,
      threadTurnCount,
      latestTurnId,
      latestTraceStatus,
      latestTurnToolRunCount: lastTurn?.toolRuns.length ?? 0,
      noticeCount: props.notices.length,
      queuedCount: props.queuedCount,
      streamStatus: props.streamStatus,
      streamingPreviewSignal,
      streamError: props.streamError,
    },
  });
  const jumpToLatestLabel = props.pendingApproval
    ? "Jump to approval"
    : props.pendingUserInput
      ? "Jump to answer prompt"
      : "Jump to latest";

  const showHiddenTurns = useCallback(() => {
    setManualWindowStart(0);
  }, []);

  useEffect(() => {
    setManualWindowStart(null);
  }, [props.thread?.sessionId]);

  return (
    <div ref={shellRef} className={`mc-next-thread-shell mode-${props.mode}`}>
      <div
        className="mc-next-thread-live-region"
        role="status"
        aria-live={liveStatus ? "polite" : "off"}
        aria-atomic="true"
      >
        {liveStatus}
      </div>
      <div className="mc-next-thread-status-lane">
        <SurfaceReconnectBanner mode={props.mode} status={props.eventStreamStatus} onRefresh={props.onRefreshThread} />
      </div>
      <div ref={scrollRef} className="mc-next-thread-scroll" onScroll={handleThreadScroll}>
        {props.loading ? (
          <div className="mc-next-thread-empty">Loading thread...</div>
        ) : props.mode === "chat" && props.thread && props.thread.turns.length === 0 ? (
          <ChatFirstMessageCanvas props={props} />
        ) : !props.thread || props.thread.turns.length === 0 ? (
          <div className="mc-next-thread-empty">
            <p className="mc-next-thread-meta">
              <strong>GoatCitadel</strong>
            </p>
            <p>
              {props.mode === "cowork"
                ? "Describe the objective, constraints, and desired output. Cowork will create a visible run plan here."
                : props.mode === "code"
                  ? "Describe a focused implementation or review task. The workbench will show diffs, validation results, and Code Mode runs as evidence appears."
                  : "Start with a plain request, or type /help to see commands."}
            </p>
          </div>
        ) : (
          <div className="mc-next-thread-view">
            <ChatStreamStatusBar
              mode={props.mode}
              status={props.streamStatus}
              queuedCount={props.queuedCount}
              error={props.streamError}
              announce={false}
            />
            <div className="mc-next-thread-list">
              <ChatThreadDelegationSummary
                delegationRun={props.delegationRun ?? null}
                mode={props.mode}
                onOpenRunDetails={onOpenRunDetails}
              />
              {windowedThreadItems.map((item, itemIndex) => {
                if (item.kind === "gap") {
                  return (
                    <ChatThreadWindowGap key={item.key} hiddenCount={item.hiddenCount} onExpand={showHiddenTurns} />
                  );
                }
                const previousItem = itemIndex > 0 ? windowedThreadItems[itemIndex - 1] : null;
                const previousTurn = previousItem && previousItem.kind === "turn" ? previousItem.turn : null;
                const groupedWithPrevious = previousTurn ? isTurnGroupedWith(previousTurn, item.turn) : false;
                return (
                  <ChatThreadTurnCard
                    key={item.turn.turnId}
                    mode={props.mode}
                    turn={item.turn}
                    selected={props.selectedTurnId === item.turn.turnId}
                    contextSelected={selectedContextTurnIdSet.has(item.turn.turnId)}
                    groupedWithPrevious={groupedWithPrevious}
                    streamingPreview={
                      props.streamingPreview?.turnId === item.turn.turnId ? props.streamingPreview : null
                    }
                    visualStreamMode={props.visualStreamMode}
                    renderUserMetaAddon={renderUserMetaAddon}
                    renderCitationList={renderCitationList}
                    onToggleContextTurn={onToggleContextTurn}
                    onSelectTurn={onSelectTurn}
                    onStartNewThreadFromTurn={onStartNewThreadFromTurn}
                    onSwitchBranch={onSwitchBranch}
                    onRetryTurn={onRetryTurn}
                    onOpenRunDetails={onOpenRunDetails}
                    onOpenUniversalRunDetail={onOpenUniversalRunDetailStable}
                    onOpenGeneratedArtifact={onOpenGeneratedArtifact}
                    onCreateGeneratedArtifact={onCreateGeneratedArtifact}
                    onCreateGeneratedArtifactVersion={onCreateGeneratedArtifactVersion}
                  />
                );
              })}
              <ChatThreadNotices notices={props.notices} />
              <div ref={threadEndRef} aria-hidden="true" />
            </div>
          </div>
        )}
      </div>
      {!props.followOutput && props.thread && props.thread.turns.length > 0 ? (
        <button type="button" className="mc-next-thread-jump-latest" onClick={jumpToLatest}>
          {jumpToLatestLabel}
        </button>
      ) : null}
    </div>
  );
}
