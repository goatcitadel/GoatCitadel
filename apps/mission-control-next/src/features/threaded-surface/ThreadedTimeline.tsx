import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ChatCitationRecord,
  type ChatThreadTurnRecord,
  type MemoryCitationProvenance,
  type MemoryRetrievalMatchSignals,
} from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { ChatStreamStatusBar } from "@goatcitadel/mission-control-shared/components/chat/ChatStreamStatusBar";
import { SurfaceReconnectBanner } from "@goatcitadel/mission-control-shared/components/chat/SurfaceReconnectBanner";
import { normalizeCitationDisplayText } from "@goatcitadel/mission-control-shared/components/chat/assistant-display-text";
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
  useChannelActivitySnapshots,
  type ChannelActivitySnapshot,
} from "@goatcitadel/mission-control-shared/state/channel-activity-store";

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

function isSafeCitationHref(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const GROUPING_WINDOW_MS = 2 * 60 * 1000;

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

function isMemoryCitation(citation: ChatCitationRecord): boolean {
  return citation.sourceType === "memory" || citation.url.startsWith("memory://") || Boolean(citation.provenance);
}

function formatMemoryRetrievalStrategy(value: MemoryCitationProvenance["retrievalStrategy"]): string | null {
  switch (value) {
    case "semantic_vector":
      return "semantic vector";
    case "semantic_hints":
      return "semantic hints";
    case "lexical_recency":
      return "lexical/recency";
    default:
      return null;
  }
}

function formatMemoryScore(value: number | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : null;
}

function formatMemorySignals(signals: MemoryRetrievalMatchSignals | undefined): string | null {
  if (!signals) {
    return null;
  }
  return [
    ["total", signals.totalScore],
    ["lexical", signals.lexicalScore],
    ["vector", signals.semanticVectorScore],
    ["hint", signals.semanticHintScore],
    ["recency", signals.recencyScore],
  ]
    .map(([label, value]) => {
      const score = typeof value === "number" ? formatMemoryScore(value) : null;
      return score ? `${label} ${score}` : null;
    })
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

function formatMemoryCitationMeta(provenance: MemoryCitationProvenance | undefined): string | null {
  if (!provenance) {
    return null;
  }
  return [
    formatMemoryRetrievalStrategy(provenance.retrievalStrategy),
    provenance.relationScope,
    provenance.freshness,
    provenance.sourceTimestamp ? `source ${provenance.sourceTimestamp}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
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
          <button type="button" className="mc-next-thread-inline-button" onClick={props.onOpenApprovals}>
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
  const channelActivities = useChannelActivitySnapshots(props.thread?.sessionId ?? null);
  const channelActivityByMessageId = useMemo(
    () => new Map(channelActivities.map((activity) => [activity.messageId, activity])),
    [channelActivities],
  );
  const selectedContextTurnIdSet = useMemo(
    () => new Set(props.selectedContextTurnIds ?? []),
    [props.selectedContextTurnIds],
  );
  const renderUserMetaAddon = useCallback(
    (turn: ChatThreadTurnRecord) => (
      <ChannelActivityBadge activity={channelActivityByMessageId.get(turn.userMessage.messageId) ?? null} />
    ),
    [channelActivityByMessageId],
  );
  const renderCitationList = useCallback(
    (turn: ChatThreadTurnRecord) => <ThreadCitationList citations={turn.citations} />,
    [],
  );
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

  const { scrollRef, threadEndRef, handleThreadScroll, jumpToLatest } = useScrollToBottom({
    followOutput: props.followOutput,
    onBottomStateChange: props.onBottomStateChange,
    signals: {
      sessionId: props.thread?.sessionId ?? null,
      threadTurnCount,
      latestTurnId,
      latestTraceStatus,
      noticeCount: props.notices.length,
      queuedCount: props.queuedCount,
      streamStatus: props.streamStatus,
      selectedTurnId: props.selectedTurnId,
      streamError: props.streamError,
    },
  });

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
                onOpenRunDetails={props.onOpenRunDetails}
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
                    onToggleContextTurn={props.onToggleContextTurn}
                    onSelectTurn={props.onSelectTurn}
                    onStartNewThreadFromTurn={props.onStartNewThreadFromTurn}
                    onSwitchBranch={props.onSwitchBranch}
                    onRetryTurn={props.onRetryTurn}
                    onOpenRunDetails={props.onOpenRunDetails}
                    onOpenUniversalRunDetail={onOpenUniversalRunDetail}
                    onOpenGeneratedArtifact={props.onOpenGeneratedArtifact}
                    onCreateGeneratedArtifact={props.onCreateGeneratedArtifact}
                    onCreateGeneratedArtifactVersion={props.onCreateGeneratedArtifactVersion}
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
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
