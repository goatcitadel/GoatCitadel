import type { ApprovalRequest } from "@goatcitadel/contracts";
import { nativeRuntimeReviewForApproval } from "../../../features/native-routes/ops/NativeRuntimeApprovalReview";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { handleEvidenceScrollKeyDown } from "../../ui/evidence-scroll";
import type { SpecialistEvidence } from "./specialist-approval-evidence";

export function SpecialistApprovalReview({
  approval,
  evidence,
}: {
  approval: ApprovalRequest;
  evidence: SpecialistEvidence;
}) {
  const review = nativeRuntimeReviewForApproval(approval, evidence.replay);
  const native = approval.payload.nativeRuntime as Record<string, unknown> | undefined;
  if (review)
    return (
      <section
        aria-label="Native launch details"
        className="grid min-w-0 max-w-full grid-cols-1 gap-2 wrap-anywhere text-sm"
      >
        <h4 className="font-semibold">Native launch details</h4>
        <p>
          Approval authorizes this exact native launch request once. It does not confirm execution or device
          availability.
        </p>
        {native ? (
          <dl className="grid min-w-0 grid-cols-1 gap-1">
            {Object.entries(native)
              .filter(([, value]) => typeof value === "string" || typeof value === "number")
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                  <dd className="break-all">{String(value)}</dd>
                </div>
              ))}
          </dl>
        ) : null}
        <p className="break-all">
          <strong>Executable:</strong> {review.imagePath}
        </p>
        <p className="break-all">
          <strong>Working directory:</strong> {review.workingDirectory}
        </p>
        <pre className="min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-sunken p-2">
          {review.commandLine}
        </pre>
        <h5>Environment</h5>
        {Object.entries(review.environment).map(([key, value]) => (
          <p key={key} className="break-all">
            {key}={value}
          </p>
        ))}
        {!Object.keys(review.environment).length ? <p>No environment variables.</p> : null}
        <h5>Execution limits</h5>
        <dl>
          {[
            ["Processes", review.limits.processLimit],
            ["Memory", `${review.limits.memoryBytes / 1024 / 1024} MiB`],
            ["CPU", `${review.limits.cpuMilli / 1000} cores`],
            ["Run time", `${review.limits.wallMs / 1000} seconds`],
            ["Output", `${review.limits.rawOutputBytes} bytes`],
            ["Diagnostics", `${review.limits.diagnosticBytes} bytes`],
            ["Input", `${review.limits.inputBytes} bytes`],
          ].map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {review.fileStaging ? (
          <>
            <h5>Files to collect</h5>
            <ul>
              {review.fileStaging.paths.map((path) => (
                <li className="break-all" key={path}>
                  {path}
                </li>
              ))}
            </ul>
            <p>
              Maximum per file: {review.fileStaging.maximumFileBytes} bytes. Maximum total:{" "}
              {review.fileStaging.maximumTotalBytes} bytes.
            </p>
            <p>
              {review.fileDisclosure
                ? `Transfer to GoatCitadel artifact storage in workspace ${review.fileDisclosure.workspaceId}. This does not authorize model, channel or external publication access.`
                : "Collection is local; sharing or publishing requires separate authorization."}
            </p>
          </>
        ) : null}
        <TechnicalDetails label="Native request binding">
          <p className="break-all">{review.requestSha256}</p>
        </TechnicalDetails>
      </section>
    );
  if (evidence.code && evidence.source)
    return (
      <section
        aria-label="Governed code review"
        className="grid min-w-0 max-w-full grid-cols-1 gap-2 wrap-anywhere text-sm"
      >
        <h4 className="font-semibold">Governed code review</h4>
        <p>
          Trusted code with immutable artifacts and execution-time hash checks. This is not hostile-code sandboxing.
          Approval is separate from execution and its outcome.
        </p>
        <p>
          Workspace {evidence.code.workspaceId} · {evidence.code.language} ·{" "}
          {evidence.code.permissionProfileLabel ?? "Gateway permission policy"}
        </p>
        <p className="break-all">
          <strong>Source artifact:</strong> {evidence.code.codeArtifact.relPath}
        </p>
        <p>{evidence.code.requestedOutputIntent || "No output intent supplied."}</p>
        <p>
          {evidence.code.saveCandidateOnSuccess
            ? "Successful work may save a candidate for separate governed review."
            : "No candidate save requested."}
        </p>
        <pre
          role="region"
          aria-label="Reviewed code source"
          tabIndex={0}
          onKeyDown={handleEvidenceScrollKeyDown}
          className="min-w-0 max-w-full max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-sunken p-2"
        >
          {evidence.source.content}
        </pre>
        {evidence.source.publicProjection?.contentRedacted ? (
          <p>Gateway redacted sensitive source content. The hash identifies the stored artifact.</p>
        ) : null}
        <TechnicalDetails label="Code artifact and policy identity">
          <dl>
            {[
              "runId",
              "codeHash",
              "wrapperManifestHash",
              "policySnapshotHash",
              "capabilitySnapshotId",
              "codeModeInputHash",
            ].map((key) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd className="break-all">{String(evidence.code![key as keyof typeof evidence.code])}</dd>
              </div>
            ))}
          </dl>
        </TechnicalDetails>
      </section>
    );
  return <p role="alert">Specialist evidence is unavailable. Refresh or deny this request.</p>;
}
