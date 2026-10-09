import { useChannelProofFreshness } from "./use-channel-proof-freshness";
import { useState } from "react";
import type { ChannelSetupWizardFeedback } from "./channel-wizard-model";
import { Dialog } from "../../../../cockpit/ui/Dialog";
import { Button } from "../../../../cockpit/ui/Button";

export function ChannelCheckFeedback({ feedback, error, disabled = false, onAcknowledge }: {
  feedback?: ChannelSetupWizardFeedback | null; error?: string | null; disabled?: boolean;
  onAcknowledge?: (kind: "cleanup" | "receipt") => Promise<void>;
}) {
  const expired = useChannelProofFreshness(feedback);
  const [review, setReview] = useState<string | null>(null);
  const signature = JSON.stringify([feedback?.evidenceId, feedback?.finalizationEligibility, feedback?.probe?.checkedAt, feedback?.proofExpiresAt]);
  const eligibility = feedback?.finalizationEligibility;
  const cleanup = feedback?.probe?.steps.some((step) => step.disposition === "advisory" && step.key.includes("cleanup"));
  return <>
    {error ? <p role="alert" className="text-sm text-status-failed">{error}</p> : null}
    {feedback ? <section aria-label="Channel check result" aria-live="polite"
      className="min-w-0 space-y-3 rounded-md border border-line p-3 text-sm">
      <h4 className="font-semibold">{feedback.kind === "test" ? "Connection test" : "Configuration validation"} · {feedback.status === "ok" ? "Passed" : feedback.status === "warn" ? "Warning" : feedback.status === "error" ? "Needs attention" : "Not checked"}</h4>
      {feedback.restored ? <p className="text-xs text-fg-secondary">Restored current proof for this saved draft revision. Review its warnings and receipts before preparing a plan.</p> : null}
      {feedback.proofExpiresAt ? <p className="text-xs text-fg-muted">Proof expires {new Date(feedback.proofExpiresAt).toLocaleString()}</p> : null}
      {feedback.checkedAt || feedback.probe?.checkedAt ? <p className="text-xs text-fg-muted">Checked {new Date(feedback.checkedAt ?? feedback.probe!.checkedAt).toLocaleString()}</p> : null}
      <ChannelCheckDetails issues={feedback.issues} probe={feedback.probe} />
      {eligibility ? <div className="space-y-1">
        <p>{expired ? "This test proof expired. Review the saved evidence and run a new reviewed test before preparing a plan." : eligibility.allowed ? "The Gateway permits preparing the activation plan for this reviewed evidence." : "The Gateway requires more evidence before activation."}</p>
        {eligibility.blockingReasons.map((reason) => <p key={reason}>{reason}</p>)}
        {!expired && eligibility.requiresAcknowledgement && onAcknowledge ?
          <Button disabled={disabled || !feedback.evidenceId} onClick={() => setReview(signature)}>
            {cleanup ? "Review test message cleanup" : "Review delivery confirmation"}
          </Button> : null}
      </div> : null}
      {feedback.recommendedNextAction ? <p>Next: {feedback.recommendedNextAction}</p> : null}
    </section> : null}
    <Dialog open={review !== null} title={cleanup ? "Acknowledge the remaining test message" : "Confirm the test destination"}
      description={cleanup ? "The provider accepted the sandbox message, but cleanup was not confirmed. Review its receipt and remove it manually if needed." : "Confirm only after observing the sandbox message at the intended destination. Provider acceptance alone does not prove receipt."}
      onOpenChange={(open) => { if (!open) setReview(null); }}>
      {review !== signature ? <p role="alert">The test evidence changed. Close this dialog and review the current result.</p> : null}
      <p className="break-all text-sm">Evidence {feedback?.evidenceId ?? "unavailable"}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button className="h-auto min-h-10 max-w-full whitespace-normal py-2" variant="primary" disabled={disabled || expired || review !== signature || !onAcknowledge || !feedback?.evidenceId}
          onClick={() => { setReview(null); void onAcknowledge?.(cleanup ? "cleanup" : "receipt"); }}>
          {cleanup ? "Acknowledge reviewed cleanup warning" : "Confirm observed sandbox message"}
        </Button>
        <Button onClick={() => setReview(null)}>Cancel confirmation</Button>
      </div>
    </Dialog>
  </>;
}

export function ChannelCheckDetails({ issues, probe, probeLabel = "Live connection probe" }: Pick<ChannelSetupWizardFeedback, "issues" | "probe"> & { probeLabel?: string }) {
  return <>
      {issues.length ? <ul className="space-y-2">{issues.map((issue, index) =>
        <li key={issue.key + ":" + index} className={issue.level === "error" ? "text-status-failed" : issue.level === "warn" ? "text-status-waiting" : "text-fg-secondary"}>
          <strong>{issue.level === "error" ? "Required repair" : issue.level === "warn" ? "Warning" : "Information"}:</strong>{issue.disposition ? " · " + issue.disposition : ""} {issue.message}
          {issue.detail ? <p>{issue.detail}</p> : null}
          {issue.nextSteps?.length ? <ul className="ml-5 list-disc">{issue.nextSteps.map((next) => <li key={next}>{next}</li>)}</ul> : null}
        </li>)}</ul> : <p>No issues returned.</p>}
      {probe ? <section aria-label={probeLabel}>
        <h5 className="font-medium">What was checked</h5>
        <ul className="mt-2 space-y-2">{probe.steps.map((step) => <li key={step.key} className="min-w-0">
          <strong>{step.label}</strong> · {step.status === "pass" ? "Passed" : step.status === "fail" ? "Failed" : step.status === "warn" ? "Warning" : "Not tested"}
          {step.disposition ? " · " + step.disposition : ""}
          <p>{step.message}</p>
          {step.providerMessageId ? <p className="break-all text-xs">Provider receipt: {step.providerMessageId}</p> : null}
          {step.cleanupStatus ? <p className="text-xs">Test message cleanup: {step.cleanupStatus.replaceAll("_", " ")}</p> : null}
        </li>)}</ul>
      </section> : null}
  </>;
}
