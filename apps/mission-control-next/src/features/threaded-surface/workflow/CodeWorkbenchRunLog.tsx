import type { useCodeRunLedger } from "./useCodeRunLedger";
import type { useCodeRunArtifacts } from "./useCodeRunArtifacts";
import type { CodePanelType } from "./code-workbench-model";

import { WorkbenchMonacoEditor } from "@goatcitadel/mission-control-shared/components/WorkbenchMonacoEditor";

import { shortId } from "./format";
import type { Dispatch, SetStateAction } from "react";
import type { CodeWorkbenchPaneProps } from "./code-workbench-model";
import { CodeRunDetail } from "./CodeRunDetail";

export function CodeWorkbenchRunLog({
  ledger,
  artifacts,
  output,
  onOpenApprovals,
  activePane,
  paneMounted,
  buildWorkbenchTabId,
  buildWorkbenchPanelId,
  runLogViewMode,
  setRunLogViewMode,
  runLogCleared,
  setRunLogCleared,
  runLogCopyNotice,
  copyRunLog,
}: CodeWorkbenchPaneProps & {
  ledger: ReturnType<typeof useCodeRunLedger>;
  artifacts: ReturnType<typeof useCodeRunArtifacts>;
  output: CodePanelType["props"]["output"];
  onOpenApprovals: CodePanelType["props"]["onOpenApprovals"];
  runLogViewMode: "rendered" | "raw";
  setRunLogViewMode: Dispatch<SetStateAction<"rendered" | "raw">>;
  runLogCleared: boolean;
  setRunLogCleared: Dispatch<SetStateAction<boolean>>;
  runLogCopyNotice: string | null;
  copyRunLog: () => void;
}) {
  const { setSelectedRunId, executionBackends, executionBackendsError, visibleRunItems, selectedRunSummary } = ledger;
  return (
    <>
      {paneMounted("output") ? (
        <div
          className="mc-next-workbench-pane"
          role="tabpanel"
          hidden={activePane !== "output"}
          id={buildWorkbenchPanelId("output")}
          aria-labelledby={buildWorkbenchTabId("output")}
        >
          <div className="mc-next-panel-list-head">
            <strong>Run log</strong>
            <div className="mc-next-workbench-view-toggle" role="group" aria-label="Run log controls">
              <span>{visibleRunItems.length} Code Mode runs</span>
              <button
                type="button"
                className={`mc-next-panel-button${runLogViewMode === "rendered" ? " active" : ""}`}
                onClick={() => setRunLogViewMode("rendered")}
              >
                Rendered
              </button>
              <button
                type="button"
                className={`mc-next-panel-button${runLogViewMode === "raw" ? " active" : ""}`}
                onClick={() => setRunLogViewMode("raw")}
              >
                Raw
              </button>
              <button type="button" className="mc-next-panel-button" onClick={copyRunLog}>
                Copy
              </button>
              <button type="button" className="mc-next-panel-button" onClick={() => setRunLogCleared(true)}>
                Clear
              </button>
            </div>
          </div>
          {runLogCopyNotice ? <p className="mc-next-workbench-empty">{runLogCopyNotice}</p> : null}
          {executionBackendsError ? <div className="mc-next-panel-banner warning">{executionBackendsError}</div> : null}
          {executionBackends ? (
            <section className="mc-next-workbench-run-detail">
              <div className="mc-next-panel-list-head">
                <strong>Execution backends</strong>
                <span>{executionBackends.items.length} visible</span>
              </div>
              <ul className="mc-next-context-list">
                {executionBackends.items.map((backend) => (
                  <li key={backend.backendId}>
                    <strong>{backend.label}</strong>
                    <p>
                      {backend.kind} · {backend.status} · {backend.runtimeSupport}
                      {backend.default ? " · default" : ""}
                      {backend.evaluationOnly ? " · evaluation only" : ""}
                    </p>
                    <p>
                      {backend.callable
                        ? "Callable for approved Code Mode runs."
                        : (backend.blockers[0] ?? "Reference only; not callable.")}
                    </p>
                    {backend.evaluation ? (
                      <p>
                        Matrix: path {backend.evaluation.pathIsolation}, network {backend.evaluation.networkControls},
                        artifacts {backend.evaluation.artifactCapture}, Windows {backend.evaluation.windowsSupport}.
                        Proof: {backend.evaluation.requiredProofLanes.join(", ")}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {output?.output && !runLogCleared ? (
            runLogViewMode === "raw" ? (
              <pre className="mc-next-workbench-raw-output">{output.output}</pre>
            ) : (
              <WorkbenchMonacoEditor value={output.output} language="markdown" readOnly height={240} />
            )
          ) : (
            <p>
              {runLogCleared
                ? "Run log hidden locally until the next command output arrives."
                : "No run log or helper output yet."}
            </p>
          )}
          {visibleRunItems.length ? (
            <ul className="mc-next-workbench-helper-list">
              {visibleRunItems.map((run) => (
                <li key={run.runId}>
                  <div className="mc-next-panel-list-head">
                    <strong>{run.language ?? "Code Mode"}</strong>
                    <span>{run.status ?? "recorded"}</span>
                  </div>
                  <p>
                    {shortId(run.runId)}
                    {run.requestedOutputIntent ? ` · ${run.requestedOutputIntent}` : ""}
                  </p>
                  {run.stdoutPreview ? <p>{run.stdoutPreview}</p> : null}
                  {run.stderrPreview ? <p>{run.stderrPreview}</p> : null}
                  <button
                    type="button"
                    className={`mc-next-panel-button${selectedRunSummary?.runId === run.runId ? " active" : ""}`}
                    onClick={() => setSelectedRunId(run.runId)}
                  >
                    Inspect run
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <CodeRunDetail ledger={ledger} artifacts={artifacts} onOpenApprovals={onOpenApprovals} />
        </div>
      ) : null}
    </>
  );
}
