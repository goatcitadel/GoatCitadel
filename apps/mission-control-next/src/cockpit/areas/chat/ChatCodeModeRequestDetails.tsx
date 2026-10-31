import { useQuery } from "@tanstack/react-query";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { fetchCodeModeRun } from "@goatcitadel/mission-control-shared/api/client";
import { codeModeRequestInput } from "@goatcitadel/mission-control-shared/content/code-mode-request-input";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { failureReason, readEntries, text, type CodeModeRequestArgs } from "./code-mode-request-copy";

/** The folded Details of a Code Mode request row: what it reads, its input and code, and why it failed. */
export function ChatCodeModeRequestDetails({
  run,
  args,
  workspaceId,
}: {
  run: ChatToolRunRecord;
  args: CodeModeRequestArgs;
  workspaceId: string;
}) {
  const reads = readEntries(args);
  // The input decides what the code reads (`input.path`), so it is shown with the code.
  const input = codeModeRequestInput(args.input);
  const source = text(args.source);
  const runId = text(run.result?.runId);
  const error = failureReason(run);
  const output = text(run.result?.stderrPreview);
  return (
    <details className="text-xs text-fg-secondary">
      <summary className="cursor-pointer font-medium">Details</summary>
      <div className="mt-2 space-y-2">
        {reads.length ? (
          <div>
            <p className="font-medium">Reads</p>
            <ul className="list-disc pl-5">
              {reads.map((entry) => (
                <li key={entry} className="wrap-anywhere">
                  {entry}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {input ? (
          <div>
            <p className="font-medium">Input</p>
            <p className="font-mono wrap-anywhere">{input}</p>
          </div>
        ) : null}
        {source ? <Block label="Code" content={source} /> : null}
        {/* The row says why in a line; the whole recorded error and the code's error output are here. */}
        {error ? (
          <div>
            <p className="font-medium">Error</p>
            <p className="font-mono wrap-anywhere">{error}</p>
          </div>
        ) : null}
        {error && output ? <Block label="Error output" content={output} /> : null}
        <TechnicalDetails>
          <div className="space-y-1 font-mono text-xs wrap-anywhere">
            {run.approvalId ? <p>Approval: {run.approvalId}</p> : null}
            {runId ? <p>Run: {runId}</p> : null}
            {runId ? (
              <CodeHash runId={runId} workspaceId={workspaceId} sessionId={run.sessionId} turnId={run.turnId} />
            ) : null}
          </div>
        </TechnicalDetails>
      </div>
    </details>
  );
}

/** A folded block of code or output. */
function Block({ label, content }: { label: string; content: string }) {
  return (
    <details>
      <summary className="cursor-pointer font-medium">{label}</summary>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-sunken p-2 font-mono text-xs text-fg">
        {content}
      </pre>
    </details>
  );
}

function CodeHash(props: { runId: string; workspaceId: string; sessionId: string; turnId: string }) {
  const query = useQuery({
    queryKey: ["code-mode", "run", props.workspaceId, props.runId],
    queryFn: () =>
      fetchCodeModeRun(props.runId, {
        workspaceId: props.workspaceId,
        sessionId: props.sessionId,
        turnId: props.turnId,
      }),
    staleTime: 60_000,
  });
  return query.data?.codeHash ? <p>Code hash: {query.data.codeHash}</p> : null;
}
