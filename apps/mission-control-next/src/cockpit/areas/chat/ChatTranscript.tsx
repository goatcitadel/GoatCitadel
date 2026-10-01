import { useMemo } from "react";
import { Virtuoso } from "react-virtuoso";
import { isChatTurnTerminalStatus, type ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { AssistantMessageRenderer } from "@goatcitadel/mission-control-shared/components/chat/AssistantMessageRenderer";
import { ChatChangePlanCard } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard";
import { ChatThreadNotices } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useChatStreamingPreviewSnapshot } from "@goatcitadel/mission-control-shared/state/chat-streaming-preview-store";
import type { MissionThreadedActiveSessionSurfaceProps, MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { useInspector } from "../../app/inspector";
import { StatusBadge } from "../../ui/StatusBadge";
import { ChatBlockers } from "./ChatBlockers";
import { ChatRunCard } from "./ChatRunCard";
import { ChatTurnDetails } from "./ChatTurnDetails";
import { recordedCostLabel } from "./recorded-cost";

function TurnReceipt({ turn }: { turn: ChatThreadTurnRecord }) {
  const { open } = useInspector();
  const usage = turn.trace.completion?.usage;
  const details = [
    turn.trace.model,
    turn.toolRuns.length ? `${turn.toolRuns.length} tool${turn.toolRuns.length === 1 ? "" : "s"}` : null,
    turn.citations.length ? `${turn.citations.length} source${turn.citations.length === 1 ? "" : "s"}` : null,
    turn.trace.completion?.latencyMs ? `${(turn.trace.completion.latencyMs / 1000).toFixed(1)}s` : null,
    usage?.costUsd !== undefined ? `Cost ${recordedCostLabel(usage.costUsd, usage.costSource)}` : null,
  ].filter(Boolean).join(" · ");
  return <button type="button" onClick={() => open({ title: "Turn details", body: <div className="space-y-3 text-sm text-fg-secondary">
    <p>Status: {humanizeToken(turn.trace.status)}</p>
    <p>Model: {turn.trace.model ?? "Not recorded"}</p>
    <p>Tools: {turn.toolRuns.length}</p>
    <p>Sources: {turn.citations.length}</p>
    <p>Cost: {recordedCostLabel(usage?.costUsd, usage?.costSource)}</p>
    {turn.citations.length ? <ul className="space-y-1">{turn.citations.map((source) => <li key={source.citationId}>{source.title ?? "Source"}</li>)}</ul> : null}
  </div> })} className="mt-2 text-left text-xs text-fg-muted hover:text-accent" aria-label="Inspect turn details">
    {details || humanizeToken(turn.trace.status)}
  </button>;
}

function Turn({ turn, previewText, streaming, actions, onInspectTurn, onOpenArtifact }: { turn: ChatThreadTurnRecord; previewText: string | null; streaming: boolean; actions: MissionThreadedActiveSessionSurfaceProps; onInspectTurn?: (turnId: string) => void; onOpenArtifact?: (turnId: string, artifactId?: string) => void }) {
  const assistantText = previewText ?? turn.assistantMessage?.content ?? "";
  const failed = turn.trace.status === "failed";
  const partial = turn.trace.status === "partial";
  return <article className="mx-auto w-full max-w-3xl space-y-4 px-3 py-5 sm:px-6" aria-label="Conversation turn">
    <div className="cockpit-chat-user-bubble ml-auto rounded-lg border border-line-subtle bg-raised p-3">
      <p className="mb-1 text-xs font-medium text-fg-muted">You</p>
      <AssistantMessageRenderer role="user" content={turn.userMessage.content} />
    </div>
    {assistantText || streaming ? <div className="max-w-full">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-xs font-medium text-fg-muted">Assistant</p>
        {streaming ? <StatusBadge status={{ label: "Responding", tone: "running" }} /> : null}
        {!streaming && (failed || partial) ? <StatusBadge status={{ label: failed ? "Failed" : "Partial", tone: failed ? "failed" : "waiting" }} /> : null}
      </div>
      {assistantText ? <AssistantMessageRenderer role="assistant" content={assistantText} running={streaming} streamTurnId={turn.turnId} />
        : <p role="status" className="text-sm text-fg-muted">Preparing response…</p>}
      {turn.assistantMessage && !streaming ? <TurnReceipt turn={turn} /> : null}
    </div> : failed || partial ? <p role="alert" className="rounded-md border border-status-waiting p-2 text-sm text-fg-secondary">
      {partial ? "This answer may be incomplete." : "This response failed."}{turn.trace.failure?.failureClass && turn.trace.failure.failureClass !== "unknown" ? ` Cause: ${humanizeToken(turn.trace.failure.failureClass)}.` : ""} Review run details or retry when available.
    </p> : <p role="status" className="text-xs text-fg-muted">{humanizeToken(turn.trace.status)}</p>}
    {turn.assistantMessage || turn.toolRuns.length || turn.citations.length || turn.generatedArtifacts?.length || turn.trace.failure || isChatTurnTerminalStatus(turn.trace.status) ? <ChatTurnDetails turn={turn} streaming={streaming} readOnly={actions.historicalReadOnly} actions={{ ...actions, onOpenRunDetails: onInspectTurn ?? actions.onOpenRunDetails, onOpenGeneratedArtifact: onOpenArtifact ?? actions.onOpenGeneratedArtifact }} /> : null}
  </article>;
}

type TranscriptFooterContext = {
  props: MissionThreadedActiveSessionSurfaceProps;
  receipt?: MissionThreadedRenderSurfaceInput["changePlanReceipt"];
  preview: ReturnType<typeof useChatStreamingPreviewSnapshot>;
  pendingTurnId: string | null | undefined;
  hasPreviewTurn: boolean;
  visibleTurns: ChatThreadTurnRecord[];
  latestTurn?: ChatThreadTurnRecord;
  onInspectTurn?: (turnId: string) => void;
  onInspectRun?: (turnId: string) => void;
};

function ChatTranscriptEmpty() {
  return <p className="p-5 text-center text-sm text-fg-muted">No messages yet. Write the first message below.</p>;
}

function ChatTranscriptFooter({ context }: { context?: TranscriptFooterContext }) {
  if (!context) return null;
  const { props, receipt, preview, pendingTurnId, hasPreviewTurn, visibleTurns, latestTurn, onInspectRun, onInspectTurn } = context;
  return <div className="mx-auto max-w-3xl px-3 pb-3 sm:px-6">
        {props.optimisticUserMessage && !visibleTurns.some((turn) => turn.userMessage.messageId === props.optimisticUserMessage?.canonicalMessageId) ? <p className="rounded-lg border border-line bg-raised p-3 text-sm text-fg-secondary">{props.optimisticUserMessage.content} · Sending…</p> : null}
        {pendingTurnId && !hasPreviewTurn && preview?.visibleText ? <div className="py-4"><AssistantMessageRenderer role="assistant" content={preview.visibleText} running streamTurnId={pendingTurnId} /></div> : null}
        <ChatRunCard props={props} turnId={latestTurn?.turnId} durableRunId={latestTurn?.trace.durable?.runId} onInspect={latestTurn && (onInspectRun ?? onInspectTurn) ? () => (onInspectRun ?? onInspectTurn)?.(latestTurn.turnId) : undefined} />
        <ChatThreadNotices notices={props.notices ?? []} scopeKey={props.selectedSessionId} />
        {receipt && !receipt.dismissed ? <ChatChangePlanCard {...receipt} /> : null}
        <ChatBlockers key={props.selectedSessionId} props={props} />
        {props.streamError && latestTurn?.trace.status !== "failed" && latestTurn?.trace.status !== "partial" ? <p role="alert" className="mt-2 rounded-md border border-status-failed p-2 text-sm text-fg-secondary">The response was interrupted. Check this conversation's status before trying again.</p> : null}
      </div>;
}

// Stable component identities preserve review and question input through owner refreshes.
const TRANSCRIPT_COMPONENTS = { EmptyPlaceholder: ChatTranscriptEmpty, Footer: ChatTranscriptFooter };

export function ChatTranscript({ props, receipt, onInspectTurn, onInspectRun, onOpenArtifact }: { props: MissionThreadedActiveSessionSurfaceProps; receipt?: MissionThreadedRenderSurfaceInput["changePlanReceipt"]; onInspectTurn?: (turnId: string) => void; onInspectRun?: (turnId: string) => void; onOpenArtifact?: (turnId: string, artifactId?: string) => void }) {
  const preview = useChatStreamingPreviewSnapshot(props.selectedSessionId);
  const turns = props.thread?.turns;
  const visibleTurns = useMemo(() => turns?.filter((turn) => turn.branch.isSelectedPath) ?? [], [turns]);
  const pendingTurnId = preview?.turnId ?? props.activeStreamingTurnId;
  const hasPreviewTurn = visibleTurns.some((turn) => turn.turnId === pendingTurnId);
  const latestTurn = visibleTurns.at(-1);

  if (props.loading && !props.thread) return <p role="status" className="flex-1 p-5 text-sm text-fg-muted">Loading conversation…</p>;
  if (!props.thread) return <p role="alert" className="flex-1 p-5 text-sm text-fg-secondary">Conversation unavailable. Open the current Chat to retry.</p>;

  return <div className="h-full min-h-0 flex-1" aria-label="Messages">
    <Virtuoso<ChatThreadTurnRecord, TranscriptFooterContext> data={visibleTurns} className="h-full w-full" followOutput={props.followOutput ? "smooth" : false}
      components={TRANSCRIPT_COMPONENTS}
      context={{ props, receipt, preview, pendingTurnId, hasPreviewTurn, visibleTurns, latestTurn, onInspectTurn, onInspectRun }}
      itemContent={(_index, turn) => <Turn turn={turn} previewText={preview?.turnId === turn.turnId ? preview.visibleText : null} streaming={pendingTurnId === turn.turnId && props.hasActiveStream} actions={props} onInspectTurn={onInspectTurn} onOpenArtifact={onOpenArtifact} />} />
  </div>;
}
