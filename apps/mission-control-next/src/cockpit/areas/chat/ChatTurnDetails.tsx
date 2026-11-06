import { lazy, Suspense, useEffect, useState } from "react";
import { isChatTurnTerminalStatus, type ChatThreadTurnRecord, type ChatToolRunRecord } from "@goatcitadel/contracts";
import { getChatToolRunDiagnostics } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-diagnostics";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
const ChatOpenCodeEvidence = lazy(async () => ({
  default: (await import("./ChatOpenCodeEvidence")).ChatOpenCodeEvidence,
}));
import { ChatTurnActions } from "./ChatTurnActions";
import { DeferredChatLeaf } from "./DeferredChatLeaves";
import { useAutoOpenDisclosure } from "./use-auto-open-disclosure";
import { summarizeTurnToolRuns } from "./chat-tool-run-summary";
import { presentToolRunStatus } from "./chat-vocabulary";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { useCoarsePointer } from "../../lib/use-coarse-pointer";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";

/** How long a copy confirmation stays before the button returns to its label. */
const COPIED_MS = 2000;
const ChatToolActivityBody = lazy(async () => ({
  default: (await import("./ChatToolActivityBody")).ChatToolActivityBody,
}));

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

const isCodeModeRequest = (tool: ChatToolRunRecord): boolean => tool.toolName === "code_mode.request";

function activityLabel(tool: ChatToolRunRecord): string {
  return presentToolRunStatus(tool).label;
}

const WEB_PAGE_READ_TOOL_NAMES = new Set(["browser.navigate", "browser.extract", "http.get"]);
// The Gateway's floor for useful page text.
const MIN_USABLE_PAGE_TEXT_CHARS = 40;

/**
 * True when operator policy stopped the tool: a switched-off group named in its error, or, when the runner's
 * policy re-check wrote its own error, a group switch-off or deny in the re-check's reason codes (the codes the
 * Gateway's switch-off and policy-block checks read).
 */
const isOperatorPolicyBlock = (tool: ChatToolRunRecord): boolean => {
  if (/tool group switched off/i.test(tool.error ?? "")) return true;
  const revalidation = tool.result?.policyRevalidation;
  const codes =
    revalidation && typeof revalidation === "object"
      ? (revalidation as { reasonCodes?: unknown }).reasonCodes
      : undefined;
  return Array.isArray(codes) && (codes.includes("tool_group_off") || codes.includes("policy_deny"));
};

/** The page text a read brought back; one that returned only a URL read nothing. */
const readPageTextLength = (run: ChatToolRunRecord): number =>
  Math.max(
    0,
    ...["textSnippet", "bodySnippet", "contentText", "text"].map((key) => {
      const value = run.result?.[key];
      return typeof value === "string" ? value.trim().length : 0;
    }),
  );

/**
 * A search or page read that failed, or was skipped, in a turn that still read another page's text. A failed
 * web action (a post or a click) is not recovered by reading a page, and an operator policy block is the
 * operator's to lift, so both still open the list.
 */
const isRecoveredWebRead = (tool: ChatToolRunRecord, toolRuns: readonly ChatToolRunRecord[]): boolean =>
  (tool.toolName === "browser.search" || WEB_PAGE_READ_TOOL_NAMES.has(tool.toolName)) &&
  (tool.status === "failed" || tool.status === "blocked") &&
  !isOperatorPolicyBlock(tool) &&
  toolRuns.some(
    (run) =>
      run !== tool &&
      run.status === "executed" &&
      WEB_PAGE_READ_TOOL_NAMES.has(run.toolName) &&
      readPageTextLength(run) >= MIN_USABLE_PAGE_TEXT_CHARS,
  );

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
  resendBlocked = false,
  actions,
  latest = true,
}: {
  turn: ChatThreadTurnRecord;
  answerContent?: string;
  streaming: boolean;
  readOnly: boolean;
  /** Not retried or edited from here: it arrived through a channel, or the turn is in a channel conversation. */
  resendBlocked?: boolean;
  actions: TurnActions;
  /** Older turns keep their actions in the page but show them on hover or keyboard focus only. */
  latest?: boolean;
}) {
  const coarsePointer = useCoarsePointer();
  const { showTechnicalDetails } = useUiPreferences();
  const [copy, setCopy] = useState<{ status: string; copied: boolean }>({ status: "", copied: false });
  // CH-31: success is temporary; the confirmation clears after a moment. Failures stay until the next try.
  useEffect(() => {
    if (!copy.copied) return;
    const timer = setTimeout(() => setCopy({ status: "", copied: false }), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copy]);
  const copyAnswer = async () => {
    if (!answerContent || !navigator.clipboard?.writeText) {
      setCopy({ status: "Copy is unavailable in this host.", copied: false });
      return;
    }
    try {
      await navigator.clipboard.writeText(answerContent);
      setCopy({ status: streaming ? "Partial answer copied." : "Answer copied.", copied: true });
    } catch {
      setCopy({ status: "Copy failed. Select the answer text to copy it.", copied: false });
    }
  };
  // A turn is live until its status is final. `streaming` alone is not enough: after an approval the Gateway resumes
  // the turn without a browser stream, and the turn is still working.
  const turnLive = streaming || !isChatTurnTerminalStatus(turn.trace.status);
  // CH-39: opens while the turn is live or when a tool needs attention, and stays open once the operator opened it.
  // A list that only opened for a live turn folds shut when the turn settles cleanly. A Code Mode request is the
  // Code Mode card's: the card asks for it and states its outcome, so neither the request nor a turn parked on it
  // opens the list. Nor does the turn that continues after Deny or Run it, when its one tool is that request: the
  // card reports only the latest request, so with more than one an earlier outcome would be hidden. The rows stay
  // here for an operator who opens it.
  const parkedOnCodeModeCard =
    !streaming &&
    turn.trace.status === "waiting_for_approval" &&
    turn.toolRuns.some(
      (tool) => isCodeModeRequest(tool) && (tool.status === "approval_required" || tool.status === "started"),
    );
  const onlyCodeModeCard = !streaming && turn.toolRuns.length === 1 && turn.toolRuns.every(isCodeModeRequest);
  // A completed turn that read other pages already worked around a page it could not open and says so in its
  // answer, so those rows stay folded below it instead of pushing the answer away from the composer.
  const turnCompleted = !turnLive && turn.trace.status === "completed";
  const toolDisclosure = useAutoOpenDisclosure(
    (turnLive && !parkedOnCodeModeCard && !onlyCodeModeCard) ||
      turn.toolRuns.some(
        (tool) =>
          !isCodeModeRequest(tool) &&
          (tool.status !== "executed" || getChatToolRunDiagnostics(tool).hasFailureSignal) &&
          !(turnCompleted && isRecoveredWebRead(tool, turn.toolRuns)),
      ),
    { closeWhenSettled: true },
  );
  const [toolBodyMounted, setToolBodyMounted] = useState(toolDisclosure.open);
  if (toolDisclosure.open && !toolBodyMounted) setToolBodyMounted(true);
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
          <summary className="cursor-pointer text-accent">{plural(turn.citations.length, "source")}</summary>
          <ul className="mt-1 divide-y divide-line-subtle">
            {turn.citations.map((source) => {
              const href = safeSourceHref(source.url);
              return (
                <li key={source.citationId} className="py-2">
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
        <details {...toolDisclosure} aria-label="Tool activity for this turn">
          <summary className="cursor-pointer text-accent">
            {summarizeTurnToolRuns(turn.toolRuns, turnLive)}
            <span className="text-fg-muted">
              {" · "}
              {plural(turn.toolRuns.length, "tool call")} · {activitySummary}
            </span>
          </summary>
          {toolBodyMounted || toolDisclosure.open ? (
            <DeferredChatLeaf label="Tool activity" identity={turn.turnId}>
              <ChatToolActivityBody turn={turn} showTechnicalDetails={showTechnicalDetails} />
            </DeferredChatLeaf>
          ) : null}
          <button
            type="button"
            onClick={() => actions.onOpenRunDetails(turn.turnId)}
            className="mt-2 text-accent hover:underline"
          >
            Inspect tool activity
          </button>
        </details>
      ) : null}
      {turn.toolRuns.some((run) => run.result?.externalAgent !== undefined) ? (
        <Suspense fallback={<p role="status">Loading tool report…</p>}>
          <ChatOpenCodeEvidence
            toolRuns={turn.toolRuns}
            onOpenRunDetails={() => actions.onOpenRunDetails(turn.turnId)}
          />
        </Suspense>
      ) : null}
      {turn.generatedArtifacts?.length ? (
        <section aria-label="Saved artifacts" className="border-t border-line-subtle pt-2">
          <h3 className="font-semibold text-fg">Saved artifacts</h3>
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
      <div
        className={
          latest || coarsePointer
            ? undefined
            : "opacity-0 transition-opacity group-hover/turn:opacity-100 group-focus-within/turn:opacity-100"
        }
      >
        <ChatTurnActions
          turn={turn}
          actions={actions}
          streaming={streaming}
          readOnly={readOnly}
          resendBlocked={resendBlocked}
          hasAnswer={Boolean(answerContent)}
          copied={copy.copied}
          onCopy={() => void copyAnswer()}
        />
      </div>
      {copy.status ? <p role="status">{copy.status}</p> : null}
    </div>
  );
}
