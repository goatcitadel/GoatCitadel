export function ApprovalDecisionHelp() {
  return (
    <details className="text-xs text-fg-muted">
      <summary className="cursor-pointer font-medium text-fg-secondary">How this decision works</summary>
      <div className="mt-1 space-y-1">
        <p>
          The current pending record is checked again before either decision. Approval alone does not prove the action
          ran.
        </p>
        <p>
          To change this request, open its source and submit a new request. Editing an approval withdraws the original
          action; it does not authorize a replacement. Project-wide always-allow is unavailable here.
        </p>
      </div>
    </details>
  );
}
