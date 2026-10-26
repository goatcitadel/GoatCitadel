import { lazy, Suspense, useEffect, useState } from "react";
import type { ChatThreadTurnRecord, ChatToolRunRecord, DesignAdvisory } from "@goatcitadel/contracts";
import { chatToolDisplayName } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-display-name";
import { getChatToolRunDiagnostics } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-diagnostics";
import { projectChatToolEffectTruth } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-effect-truth";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
const ChatOpenCodeEvidence = lazy(async () => ({
  default: (await import("./ChatOpenCodeEvidence")).ChatOpenCodeEvidence,
}));
import { ChatTurnActions } from "./ChatTurnActions";
import { ChatToolRunSummary } from "./ChatToolRunSummary";
import { ChatToolApprovalLine } from "./ChatToolApprovalLine";
import { useAutoOpenDisclosure } from "./use-auto-open-disclosure";
import { presentToolRunStatus } from "./chat-vocabulary";
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
  // CH-39: opens while streaming or when a tool needs attention, and stays open once the operator opened it.
  const toolDisclosure = useAutoOpenDisclosure(
    streaming ||
      turn.toolRuns.some((tool) => tool.status !== "executed" || getChatToolRunDiagnostics(tool).hasFailureSignal),
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
            {plural(turn.toolRuns.length, "tool call")} · {activitySummary}
          </summary>
          <ul className="mt-1 divide-y divide-line-subtle">
            {turn.toolRuns.map((tool) => {
              const diagnostics = getChatToolRunDiagnostics(tool);
              const effect = projectChatToolEffectTruth(tool);
              const advisories = readDesignAdvisories(tool);
              return (
                <li
                  key={tool.toolRunId}
                  data-tool-run-id={tool.toolRunId}
                  className="flex flex-wrap justify-between gap-2 py-2"
                >
                  <span className="text-fg-secondary">{chatToolDisplayName(tool)}</span>
                  <span>{activityLabel(tool)}</span>
                  {tool.approvalId ? <ChatToolApprovalLine tool={tool} /> : null}
                  {diagnostics.summary || tool.error || tool.failureGuidance ? (
                    <ChatToolRunSummary
                      text={
                        tool.failureGuidance ??
                        diagnostics.summary ??
                        (tool.error ? presentErrorText(tool.error).summary : "")
                      }
                    />
                  ) : null}
                  {/* The row shows the summary; the recorded failure stays reachable for technical review. */}
                  {tool.error ? (
                    <div className="w-full">
                      <RecordedErrorDetails error={tool.error} />
                    </div>
                  ) : null}
                  {effect ? <p className="w-full">{effect.plainSummary}</p> : null}
                  {/* The row names the tool; its registry name stays reachable for technical review. */}
                  {showTechnicalDetails ? (
                    <div className="w-full">
                      <TechnicalDetails>
                        <p className="break-all font-mono text-xs">Tool {tool.toolName}</p>
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
