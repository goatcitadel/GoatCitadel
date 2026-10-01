import { readOpenCodeRunSummary, type ChatToolRunRecord } from "@goatcitadel/contracts";
import { AssistantMessageRenderer } from "@goatcitadel/mission-control-shared/components/chat/AssistantMessageRenderer";

/** External agent output is a bounded report, not proof that a file changed. */
export function ChatOpenCodeEvidence({ toolRuns, onOpenRunDetails }: {
  toolRuns: readonly ChatToolRunRecord[];
  onOpenRunDetails: () => void;
}) {
  const reports = toolRuns.flatMap((run) => {
    const report = readOpenCodeRunSummary(run.result?.externalAgent);
    return report ? [{ id: run.toolRunId, report }] : [];
  });
  if (!reports.length) return null;
  const visible = reports.slice(-3);

  return <section aria-label="OpenCode results" className="space-y-3">
    {reports.length > visible.length ? <p className="text-fg-muted">Showing the latest {visible.length} of {reports.length} OpenCode reports. Open run details for earlier results.</p> : null}
    {visible.map(({ id, report }) => <article key={id} className="space-y-2 rounded-lg border border-line bg-sunken p-3 text-fg-secondary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-fg">OpenCode report</h3>
        <span>{report.files.length} reported {report.files.length === 1 ? "file" : "files"} · {report.steps.length} {report.steps.length === 1 ? "step" : "steps"}</span>
      </div>
      <p>These are external agent reports. Review the run and file evidence before treating them as applied changes.</p>
      {report.error ? <p role="alert" className="rounded border border-status-failed p-2 text-fg">OpenCode reported a problem: {report.error}</p> : null}
      {report.text ? <div className="max-h-60 overflow-y-auto rounded border border-line-subtle bg-raised p-2 text-sm text-fg"><AssistantMessageRenderer role="assistant" content={report.text} /></div> : null}
      {report.files.length ? <details><summary className="cursor-pointer font-medium text-accent">Reported files</summary>
        <ul className="mt-2 space-y-2">{report.files.map((file) => <li key={file.path} className="min-w-0 rounded border border-line-subtle bg-raised p-2">
          <p className="wrap-anywhere font-mono text-xs text-fg">{file.path}{file.additions !== undefined ? ` · +${file.additions}` : ""}{file.deletions !== undefined ? ` · −${file.deletions}` : ""}</p>
          {file.patch ? <details className="mt-1"><summary className="cursor-pointer text-accent">Preview diff</summary><pre className="mt-1 max-h-52 overflow-auto whitespace-pre text-xs text-fg-secondary">{file.patch}</pre></details> : <p>No diff was returned for this file.</p>}
          {file.truncated ? <p>Diff preview is partial.</p> : null}
        </li>)}</ul>
      </details> : null}
      {report.steps.length ? <details><summary className="cursor-pointer font-medium text-accent">Agent steps</summary>
        <ol className="mt-2 space-y-1">{report.steps.map((step) => <li key={step.id} className="flex flex-wrap justify-between gap-2 rounded border border-line-subtle bg-raised p-2">
          <span className="text-fg">{step.title}</span><span>{step.status === "error" ? "Failed" : "Reported done"}</span>{step.error ? <span className="w-full">{step.error}</span> : null}
        </li>)}</ol>
      </details> : null}
      {report.truncated ? <p>Some output was omitted. Open run details for captured evidence.</p> : null}
      <button type="button" onClick={onOpenRunDetails} className="font-medium text-accent hover:underline">Open run evidence</button>
    </article>)}
  </section>;
}
