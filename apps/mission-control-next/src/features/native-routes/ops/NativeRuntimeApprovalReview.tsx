import type { ApprovalNativeRuntimeReview, ApprovalReplaySnapshot, ApprovalRequest } from "@goatcitadel/contracts";

export function nativeRuntimeReviewForApproval(approval: ApprovalRequest, replay?: ApprovalReplaySnapshot): ApprovalNativeRuntimeReview | undefined {
  const binding = approval.payload.nativeRuntime as { expectation?: { requestSha256?: unknown } } | undefined;
  const review = replay?.nativeRuntimeReview;
  const disclosure = approval.payload.nativeFileDisclosure as { destination?: unknown; executionWorkspaceId?: unknown } | undefined;
  if (Boolean(disclosure) !== Boolean(review?.fileDisclosure) || (disclosure &&
      (disclosure.destination !== "gateway_artifacts" || review?.fileDisclosure?.destination !== disclosure.destination ||
       review.fileDisclosure.workspaceId !== disclosure.executionWorkspaceId))) return undefined;
  return approval.kind === "remote_worker.native_runtime" && replay?.approval.approvalId === approval.approvalId &&
    typeof binding?.expectation?.requestSha256 === "string" && review?.requestSha256 === binding.expectation.requestSha256
    ? review : undefined;
}

export function NativeRuntimeApprovalReview({ review }: { review?: ApprovalNativeRuntimeReview }) {
  if (!review) return <p role="status">Launch details are unavailable. Refresh the approval; if they have expired or the gateway restarted, reject this request and create a new review.</p>;
  const limits = review.limits;
  return <section aria-label="Native launch details" className="mc-next-approval-evidence">
    <h3>Native launch details</h3>
    <p>Review the exact command, working directory, environment and limits. Approval alone does not mean the process has run.</p>
    <h4>Executable</h4><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{review.imagePath}</pre>
    <h4>Command</h4><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{review.commandLine}</pre>
    <h4>Working directory</h4><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{review.workingDirectory}</pre>
    <h4>Environment</h4>
    {Object.keys(review.environment).length ? <dl>{Object.entries(review.environment).map(([name, value]) =>
      <div key={name}><dt>{name}</dt><dd style={{ overflowWrap: "anywhere" }}>{value}</dd></div>)}</dl> : <p>No environment variables.</p>}
    <h4>Execution limits</h4>
    <dl>
      <dt>Processes</dt><dd>{limits.processLimit}</dd>
      <dt>Memory</dt><dd>{(limits.memoryBytes / 1024 / 1024).toLocaleString()} MiB</dd>
      <dt>CPU</dt><dd>{(limits.cpuMilli / 1000).toLocaleString()} cores</dd>
      <dt>Run time</dt><dd>{(limits.wallMs / 1000).toLocaleString()} seconds</dd>
      <dt>Output</dt><dd>{limits.rawOutputBytes.toLocaleString()} bytes</dd>
      <dt>Diagnostics</dt><dd>{limits.diagnosticBytes.toLocaleString()} bytes</dd>
      <dt>Input</dt><dd>{limits.inputBytes.toLocaleString()} bytes</dd>
    </dl>
    {review.fileStaging && <>
      <h4>Files to collect</h4>
      <p>These paths are relative to the working directory.</p>
      {review.fileDisclosure ? <p>Approval also authorizes transfer of these files to GoatCitadel artifact storage in workspace <strong>{review.fileDisclosure.workspaceId}</strong>.
        This does not authorize model, channel or external publication access.</p> :
        <p>Collection is local; sharing or publishing files requires separate authorization.</p>}
      <ul>{review.fileStaging.paths.map(path => <li key={path} style={{ overflowWrap: "anywhere" }}>{path}</li>)}</ul>
      <dl>
        <dt>Maximum per file</dt><dd>{review.fileStaging.maximumFileBytes.toLocaleString()} bytes</dd>
        <dt>Maximum total</dt><dd>{review.fileStaging.maximumTotalBytes.toLocaleString()} bytes</dd>
      </dl>
    </>}
    <details><summary>Request identity</summary><code style={{ overflowWrap: "anywhere" }}>{review.requestSha256}</code></details>
  </section>;
}
