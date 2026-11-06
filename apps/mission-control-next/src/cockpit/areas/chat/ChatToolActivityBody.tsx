import type { ChatThreadTurnRecord, ChatToolRunRecord, DesignAdvisory } from "@goatcitadel/contracts";
import { chatToolDisplayName } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-display-name";
import {
  getChatToolRunDiagnostics,
  isFailedCodeModeRequest,
} from "@goatcitadel/mission-control-shared/components/chat/chat-tool-diagnostics";
import { projectChatToolEffectTruth } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-effect-truth";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { ChatToolRunSummary } from "./ChatToolRunSummary";
import { ChatToolApprovalLine } from "./ChatToolApprovalLine";
import { groupToolRunRetries } from "./chat-tool-run-groups";
import { toolRunTarget, type ToolRunTarget } from "./chat-tool-run-summary";
import { toolRunDuration, toolRunLineChanges } from "./chat-tool-run-change-stats";
import { presentToolRunStatus } from "./chat-vocabulary";
import { failureLine, failureReason } from "./code-mode-request-copy";
import { presentErrorText } from "../../lib/present-error";
import { RecordedErrorDetails } from "../../ui/RecordedErrorDetails";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
function activityLabel(tool: ChatToolRunRecord): string {
  return presentToolRunStatus(tool).label;
}
const WEB_PAGE_READ_TOOL_NAMES = new Set(["browser.navigate", "browser.extract", "http.get"]);
const isQuietWebLookupEffect = (tool: ChatToolRunRecord, tone: "none" | "uncertain" | "concrete"): boolean =>
  tone === "uncertain" && (tool.toolName === "browser.search" || WEB_PAGE_READ_TOOL_NAMES.has(tool.toolName));
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

export function ChatToolActivityBody({
  turn,
  showTechnicalDetails,
}: {
  turn: ChatThreadTurnRecord;
  showTechnicalDetails: boolean;
}) {
  return (
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
  );
}
