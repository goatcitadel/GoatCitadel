import { useState } from "react";
import type { ChatThreadTurnRecord, ChatToolRunRecord } from "@goatcitadel/contracts";
import { canRetryTurn } from "@goatcitadel/mission-control-shared/components/chat/chat-display-helpers";
import { chatToolDisplayName } from "@goatcitadel/mission-control-shared/components/chat/ChatToolResultPreview";
import { getChatToolRunDiagnostics } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-diagnostics";
import { projectChatToolEffectTruth } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-effect-truth";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { ChatOpenCodeEvidence } from "./ChatOpenCodeEvidence";

type TurnActions = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  | "onRetryTurn"
  | "onStartNewThreadFromTurn"
  | "onSwitchBranch"
  | "onEditTurn"
  | "onOpenRunDetails"
  | "onCreateGeneratedArtifact"
  | "onOpenGeneratedArtifact"
>;

function activityLabel(tool: ChatToolRunRecord): string {
  switch (tool.status) {
    case "started":
      return "Running";
    case "executed":
      return getChatToolRunDiagnostics(tool).hasFailureSignal ? "Needs review" : "Done";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    case "approval_required":
      return "Approval needed";
    default:
      return "Unknown";
  }
}

function safeSourceHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function ChatTurnDetails({
  turn,
  answerContent = turn.assistantMessage?.content,
  streaming,
  readOnly,
  actions,
}: {
  turn: ChatThreadTurnRecord;
  answerContent?: string;
  streaming: boolean;
  readOnly: boolean;
  actions: TurnActions;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const copyAnswer = async () => {
    if (!answerContent || !navigator.clipboard?.writeText) {
      setCopyStatus("Copy is unavailable in this host.");
      return;
    }
    try {
      await navigator.clipboard.writeText(answerContent);
      setCopyStatus(streaming ? "Partial answer copied." : "Answer copied.");
    } catch {
      setCopyStatus("Copy failed. Select the answer text to copy it.");
    }
  };
  const siblings = turn.branch.siblingTurnIds ?? [];
  const counts = new Map<string, number>();
  for (const tool of turn.toolRuns) {
    const label = activityLabel(tool);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const activitySummary = [...counts].map(([label, count]) => `${count} ${label.toLowerCase()}`).join(" · ");
  return (
    <div className="mt-3 space-y-2 text-xs text-fg-muted">
      {turn.citations.length ? (
        <details>
          <summary className="cursor-pointer text-accent">
            {turn.citations.length} {turn.citations.length === 1 ? "source" : "sources"}
          </summary>
          <ul className="mt-1 grid gap-1">
            {turn.citations.map((source) => {
              const href = safeSourceHref(source.url);
              return (
                <li key={source.citationId} className="rounded-md border border-line-subtle p-2">
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-medium text-accent underline-offset-2 hover:underline"
                    >
                      {source.title || "Open source"}
                    </a>
                  ) : (
                    <span className="font-medium text-fg-secondary">{source.title || "Source"}</span>
                  )}
                  {source.snippet ? <p className="mt-1 line-clamp-3 text-fg-muted">{source.snippet}</p> : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
      {turn.toolRuns.length ? (
        <details aria-label="Tool activity for this turn">
          <summary className="cursor-pointer text-accent">
            {turn.toolRuns.length} tool {turn.toolRuns.length === 1 ? "call" : "calls"} · {activitySummary}
          </summary>
          <ul className="mt-1 grid gap-1">
            {turn.toolRuns.map((tool) => {
              const diagnostics = getChatToolRunDiagnostics(tool);
              const effect = projectChatToolEffectTruth(tool);
              return (
                <li
                  key={tool.toolRunId}
                  data-tool-run-id={tool.toolRunId}
                  className="flex flex-wrap justify-between gap-2 rounded-md border border-line-subtle p-2"
                >
                  <span className="text-fg-secondary">{chatToolDisplayName(tool)}</span>
                  <span>{activityLabel(tool)}</span>
                  {diagnostics.summary || tool.error || tool.failureGuidance ? (
                    <p className="w-full text-fg-secondary">
                      {tool.failureGuidance ?? diagnostics.summary ?? tool.error}
                    </p>
                  ) : null}
                  {effect ? <p className="w-full">{effect.plainSummary}</p> : null}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => actions.onOpenRunDetails(turn.turnId)}
            className="mt-2 text-accent hover:underline"
          >
            Inspect tool activity
          </button>
        </details>
      ) : null}
      <ChatOpenCodeEvidence toolRuns={turn.toolRuns} onOpenRunDetails={() => actions.onOpenRunDetails(turn.turnId)} />
      {turn.generatedArtifacts?.length ? (
        <section aria-label="Saved artifacts" className="rounded-md border border-line-subtle bg-raised p-2">
          <h3 className="font-medium text-fg">Saved artifacts</h3>
          <ul className="mt-1 space-y-1">
            {turn.generatedArtifacts.map((artifact) => (
              <li key={artifact.artifactId}>
                <button
                  type="button"
                  onClick={() => actions.onOpenGeneratedArtifact(turn.turnId, artifact.artifactId)}
                  className="text-left font-medium text-accent hover:underline"
                >
                  {artifact.title}
                </button>
                <span className="ml-2 text-fg-muted">Version {artifact.version}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {canRetryTurn(turn) && !streaming && !readOnly ? (
          <button
            type="button"
            onClick={() => actions.onRetryTurn(turn.turnId)}
            className="font-medium text-accent hover:underline"
          >
            Retry
          </button>
        ) : null}
        {answerContent ? (
          <button type="button" onClick={() => void copyAnswer()} className="text-accent hover:underline">
            {streaming ? "Copy answer so far" : "Copy answer"}
          </button>
        ) : null}
        {!streaming && !readOnly ? (
          <>
            <button
              type="button"
              onClick={() => actions.onStartNewThreadFromTurn(turn.turnId)}
              className="text-accent hover:underline"
            >
              Fork
            </button>
            <button
              type="button"
              onClick={() => actions.onEditTurn(turn.turnId)}
              className="text-accent hover:underline"
            >
              Edit and resend
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => actions.onOpenRunDetails(turn.turnId)}
          className="text-accent hover:underline"
        >
          Run details
        </button>
        {turn.assistantMessage && turn.trace.status !== "failed" && !readOnly ? (
          <button
            type="button"
            onClick={() => actions.onCreateGeneratedArtifact(turn.turnId)}
            className="text-accent hover:underline"
          >
            Save answer
          </button>
        ) : null}
        {siblings.length > 1 ? (
          <span className="flex items-center gap-1 text-fg-muted">
            Branch {turn.branch.activeSiblingIndex + 1} of {turn.branch.siblingCount}
            {siblings.map((siblingId, index) => (
              <button
                key={siblingId}
                type="button"
                disabled={siblingId === turn.turnId}
                onClick={() => actions.onSwitchBranch(siblingId)}
                aria-label={`Switch to branch ${index + 1}`}
                className="rounded border border-line px-1 text-accent disabled:text-fg-muted"
              >
                {index + 1}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {copyStatus ? <p role="status">{copyStatus}</p> : null}
    </div>
  );
}
