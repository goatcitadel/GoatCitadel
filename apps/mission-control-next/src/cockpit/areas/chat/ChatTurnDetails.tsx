import { lazy, Suspense, useEffect, useState } from "react";
import {
  isChatTurnTerminalStatus,
  type ChatThreadTurnRecord,
  type ChatToolRunRecord,
  type DesignAdvisory,
} from "@goatcitadel/contracts";
import { chatToolDisplayName } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-display-name";
import {
  getChatToolRunDiagnostics,
  isFailedCodeModeRequest,
} from "@goatcitadel/mission-control-shared/components/chat/chat-tool-diagnostics";
import { projectChatToolEffectTruth } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-effect-truth";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
const ChatOpenCodeEvidence = lazy(async () => ({
  default: (await import("./ChatOpenCodeEvidence")).ChatOpenCodeEvidence,
}));
import { ChatTurnActions } from "./ChatTurnActions";
import { ChatToolRunSummary } from "./ChatToolRunSummary";
import { ChatToolApprovalLine } from "./ChatToolApprovalLine";
import { useAutoOpenDisclosure } from "./use-auto-open-disclosure";
import { groupToolRunRetries } from "./chat-tool-run-groups";
import { summarizeTurnToolRuns, toolRunTarget, type ToolRunTarget } from "./chat-tool-run-summary";
import { toolRunDuration, toolRunLineChanges } from "./chat-tool-run-change-stats";
import { presentToolRunStatus } from "./chat-vocabulary";
import { failureLine, failureReason } from "./code-mode-request-copy";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { presentErrorText } from "../../lib/present-error";
import { RecordedErrorDetails } from "../../ui/RecordedErrorDetails";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useCoarsePointer } from "../../lib/use-coarse-pointer";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";

/** How long a copy confirmation stays before the button returns to its label. */
const COPIED_MS = 2000;

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

/** Informational design advisories the gateway attached to a governed UI file write; shape-checked, never trusted blindly. */
function readDesignAdvisories(tool: ChatToolRunRecord): DesignAdvisory[] {
  const raw = tool.result?.designAdvisories;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { ruleId, line, summary, scope } = entry as Record<string, unknown>;
    return typeof ruleId === "string" && typeof summary === "string" && typeof line === "number"
      ? [{ ruleId, line, summary, ...(scope === "patch" ? { scope: "patch" as const } : {}) }]
      : [];
  });
}

/** A Code Mode request whose code failed settles as a call, so its recorded error is in its result. */
const failedRequestError = (tool: ChatToolRunRecord): string =>
  isFailedCodeModeRequest(tool) ? failureReason(tool) : "";

function toolRunSummaryText(tool: ChatToolRunRecord): string {
  const requestError = failedRequestError(tool);
  return (
    // An approved call that settled records empty guidance, which is no guidance.
    tool.failureGuidance ||
    // A failed Code Mode request reads as its card says it; the recorded error stays under technical details.
    (requestError ? failureLine(requestError) : "") ||
    getChatToolRunDiagnostics(tool).summary ||
    (tool.error ? presentErrorText(tool.error).summary : "")
  );
}

const WEB_PAGE_READ_TOOL_NAMES = new Set(["browser.navigate", "browser.extract", "http.get"]);

/**
 * The Gateway records every browser call's effect as uncertain, because a signed-in browser could act on a site,
 * and that keeps automatic replay off. On a search or page read the line would repeat on every row, so it moves
 * under technical details there; any other tool's uncertain effect stays on its row.
 */
const isQuietWebLookupEffect = (tool: ChatToolRunRecord, tone: "none" | "uncertain" | "concrete"): boolean =>
  tone === "uncertain" && (tool.toolName === "browser.search" || WEB_PAGE_READ_TOOL_NAMES.has(tool.toolName));

/**
 * A web lookup that failed, or was skipped, in a turn that still read another page. A switched-off tool group
 * is a switch the operator can turn back on, so it still opens the list.
 */
const isRecoveredWebRead = (tool: ChatToolRunRecord, toolRuns: readonly ChatToolRunRecord[]): boolean =>
  (tool.toolName.startsWith("browser.") || tool.toolName.startsWith("http.")) &&
  (tool.status === "failed" || tool.status === "blocked") &&
  !/tool group switched off/i.test(tool.error ?? "") &&
  toolRuns.some((run) => run !== tool && run.status === "executed" && WEB_PAGE_READ_TOOL_NAMES.has(run.toolName));

/** The failed tries before a tool's latest one: folded under its row, never dropped. */
/** What a call touched, after its name. The leading space keeps name and target apart for screen readers too. */
function ToolTarget({ target }: { target: ToolRunTarget }) {
  return (
    <>
      {" "}
      <span
        title={target.full}
        className={`ml-1 text-fg-muted wrap-anywhere ${target.kind === "command" ? "font-mono" : ""}`}
      >
        {target.label}
      </span>
    </>
  );
}

function EarlierTries({ tries }: { tries: ChatToolRunRecord[] }) {
  return (
    <details className="w-full">
      <summary className="cursor-pointer text-fg-muted">{plural(tries.length, "earlier try", "earlier tries")}</summary>
      <ol className="mt-1 space-y-2">
        {tries.map((tool, index) => {
          const summary = toolRunSummaryText(tool);
          const target = toolRunTarget(tool);
          // A failed try can still have had an outside effect; its effect note and approval stay visible here.
          const effect = projectChatToolEffectTruth(tool);
          return (
            <li key={tool.toolRunId} data-tool-run-id={tool.toolRunId}>
              <p className="text-fg-secondary">
                Try {index + 1} · {activityLabel(tool)}
                {target ? <ToolTarget target={target} /> : null}
              </p>
              {tool.approvalId ? <ChatToolApprovalLine tool={tool} /> : null}
              {summary ? <ChatToolRunSummary text={summary} /> : null}
              {tool.error ? <RecordedErrorDetails error={tool.error} /> : null}
              {effect ? <p>{effect.plainSummary}</p> : null}
            </li>
          );
        })}
      </ol>
    </details>
  );
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
          <ul className="mt-1 divide-y divide-line-subtle">
            {groupToolRunRetries(turn.toolRuns).map(({ key, run: tool, earlier }) => {
              const diagnostics = getChatToolRunDiagnostics(tool);
              const effect = projectChatToolEffectTruth(tool);
              const advisories = readDesignAdvisories(tool);
              const target = toolRunTarget(tool);
              const changes = toolRunLineChanges(tool);
              const duration = toolRunDuration(tool);
              const requestError = failedRequestError(tool);
              return (
                <li key={key} data-tool-run-id={tool.toolRunId} className="flex flex-wrap justify-between gap-2 py-2">
                  <span className="min-w-0 text-fg-secondary">
                    {chatToolDisplayName(tool)}
                    {target ? <ToolTarget target={target} /> : null}
                    {earlier.length ? <span className="ml-1 text-fg-muted"> {earlier.length + 1} tries</span> : null}
                  </span>
                  <span className="inline-flex items-center gap-2">
                    {changes ? (
                      <span className="font-mono">
                        <span aria-hidden="true">
                          <span className="text-status-done">+{changes.added}</span>{" "}
                          <span className="text-status-failed">−{changes.removed}</span>
                        </span>
                        <span className="sr-only">
                          {plural(changes.added, "line")} added, {plural(changes.removed, "line")} removed
                        </span>
                      </span>
                    ) : null}
                    {duration ? <span>{duration}</span> : null}
                    <span>{activityLabel(tool)}</span>
                  </span>
                  {tool.approvalId ? <ChatToolApprovalLine tool={tool} /> : null}
                  {diagnostics.summary || tool.error || tool.failureGuidance ? (
                    <ChatToolRunSummary text={toolRunSummaryText(tool)} />
                  ) : null}
                  {earlier.length ? <EarlierTries tries={earlier} /> : null}
                  {/* The row shows the summary; the recorded failure stays reachable for technical review. */}
                  {tool.error ? (
                    <div className="w-full">
                      <RecordedErrorDetails error={tool.error} />
                    </div>
                  ) : null}
                  {requestError && requestError !== tool.error && requestError !== failureLine(requestError) ? (
                    <div className="w-full">
                      <TechnicalDetails label="Recorded error">
                        <p className="break-all font-mono text-xs">{requestError}</p>
                      </TechnicalDetails>
                    </div>
                  ) : null}
                  {effect && !isQuietWebLookupEffect(tool, effect.tone) ? (
                    <p className="w-full">{effect.plainSummary}</p>
                  ) : null}
                  {/* The row names the tool; its registry name stays reachable for technical review. */}
                  {showTechnicalDetails ? (
                    <div className="w-full">
                      <TechnicalDetails>
                        <p className="break-all font-mono text-xs">Tool {tool.toolName}</p>
                        {effect && isQuietWebLookupEffect(tool, effect.tone) ? (
                          <p className="text-xs">{effect.plainSummary}</p>
                        ) : null}
                      </TechnicalDetails>
                    </div>
                  ) : null}
                  {advisories.length ? (
                    <div className="w-full">
                      <p className="text-fg-secondary">Design advisories ({advisories.length}) · informational</p>
                      <ul aria-label="Design advisories" className="mt-1 grid gap-1">
                        {advisories.map((advisory) => (
                          <li key={advisory.ruleId}>
                            {advisory.summary}{" "}
                            <span className="text-fg-muted">
                              {advisory.scope === "patch"
                                ? `(line ${advisory.line} of the patch text)`
                                : `(line ${advisory.line})`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
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
