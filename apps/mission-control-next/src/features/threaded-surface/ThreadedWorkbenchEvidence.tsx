import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { StatusChip } from "../native-routes/primitives";
import { formatUtilitySnippet } from "./threaded-surface-model";

export type CodeWorkflowPanel = Extract<
  NonNullable<MissionThreadedRenderSurfaceInput["workflowPanel"]>,
  { kind: "code" }
>;

export function UtilityDiffPanel({
  workflowPanel,
}: {
  workflowPanel: MissionThreadedRenderSurfaceInput["workflowPanel"];
}) {
  const codePanel = getCodeWorkflowPanel(workflowPanel);
  const diff = codePanel?.props.diff;
  const selectedFileDiff = codePanel?.props.selectedFileDiff;
  const changedFiles = codePanel?.props.workbenchTree?.changedFiles ?? diff?.changedFiles ?? [];
  const diffText =
    diff?.diff ||
    [selectedFileDiff?.originalContent, selectedFileDiff?.modifiedContent].filter(Boolean).join("\n\n---\n\n");

  return (
    <section className="mc-next-utility-card">
      <h4>Repo diff</h4>
      <div className="mc-next-utility-chip-row">
        <StatusChip tone={changedFiles.length > 0 ? "warning" : "muted"}>{changedFiles.length} changed</StatusChip>
        {diff?.summary ? (
          <StatusChip tone="muted">
            +{diff.summary.additions} / -{diff.summary.deletions}
          </StatusChip>
        ) : null}
      </div>
      {changedFiles.length > 0 ? (
        <ul className="mc-next-utility-list">
          {changedFiles.slice(0, 12).map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      ) : (
        <p>No worktree diff is open for this session.</p>
      )}
      {diffText ? <pre className="mc-next-utility-pre">{formatUtilitySnippet(diffText, 2400)}</pre> : null}
    </section>
  );
}

export function UtilityTerminalPanel({
  workflowPanel,
}: {
  workflowPanel: MissionThreadedRenderSurfaceInput["workflowPanel"];
}) {
  const codePanel = getCodeWorkflowPanel(workflowPanel);
  const output = codePanel?.props.output;
  const helperRuns = output?.helperRuns ?? [];
  const terminalText = formatUtilitySnippet(output?.output, 2400);

  return (
    <section className="mc-next-utility-card">
      <h4>Run log</h4>
      <div className="mc-next-utility-chip-row">
        <StatusChip tone={helperRuns.length > 0 ? "success" : "muted"}>
          {helperRuns.length} command record{helperRuns.length === 1 ? "" : "s"}
        </StatusChip>
        <StatusChip tone="muted">{codePanel?.props.workbenchState?.validationStatus ?? "validation idle"}</StatusChip>
      </div>
      {output?.output ? <pre className="mc-next-utility-pre terminal">{terminalText}</pre> : <p>No run output yet.</p>}
      {helperRuns.length > 0 ? (
        <ul className="mc-next-utility-list">
          {helperRuns.slice(0, 5).map((run) => (
            <li key={run.runId}>
              {run.language ?? "command"} · {run.status ?? "recorded"}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function UtilityFilesPanel({
  workflowPanel,
}: {
  workflowPanel: MissionThreadedRenderSurfaceInput["workflowPanel"];
}) {
  const codePanel = getCodeWorkflowPanel(workflowPanel);
  const files = (codePanel?.props.workbenchTree?.items ?? []).filter((item) => item.kind === "file");
  const hasDirtyDraft = Boolean(codePanel?.props.hasDirtyDraft);
  const selectedPath = codePanel?.props.selectedFile?.path;

  return (
    <section className="mc-next-utility-card">
      <h4>Workbench files</h4>
      <div className="mc-next-utility-chip-row">
        <StatusChip tone={files.length > 0 ? "success" : "muted"}>{files.length} files</StatusChip>
        {hasDirtyDraft ? <StatusChip tone="warning">Unsaved draft</StatusChip> : null}
      </div>
      {files.length > 0 ? (
        <ul className="mc-next-utility-file-list">
          {files.slice(0, 28).map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className={`mc-next-panel-button${selectedPath === file.path ? " active" : ""}`}
                disabled={hasDirtyDraft && selectedPath !== file.path}
                onClick={() => codePanel?.props.onSelectFile(file.path)}
              >
                <span>{file.path}</span>
                {file.changed ? <span>changed</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No workbench files are loaded yet.</p>
      )}
    </section>
  );
}

export function getCodeWorkflowPanel(
  workflowPanel: MissionThreadedRenderSurfaceInput["workflowPanel"],
): CodeWorkflowPanel | null {
  return workflowPanel?.kind === "code" ? workflowPanel : null;
}
