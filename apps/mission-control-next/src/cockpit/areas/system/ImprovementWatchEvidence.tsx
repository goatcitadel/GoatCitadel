import type { ImprovementActivationRecord } from "@goatcitadel/contracts";

/** Read-only canonical monitoring evidence, never an activation or performance claim. */
export function ImprovementWatchEvidence({ activation }: { activation?: ImprovementActivationRecord }) {
  if (!activation) return null;
  const count = activation.positiveSignalCount;
  const target = activation.watchSignalTarget;
  const verifiedCount = Number.isSafeInteger(count) && count! >= 0 && Number.isSafeInteger(target) && target > 0;
  const legacy = activation.watchEvidenceStatus === "legacy_unverified" || count === undefined;
  const incomplete = activation.watchEvidenceStatus === "partial";
  const stable =
    activation.watchStatus === "stable" &&
    !legacy &&
    !incomplete &&
    verifiedCount &&
    count! >= target &&
    activation.regressionCount === 0;
  const label = legacy
    ? "Earlier monitoring record; evidence is unverified."
    : activation.status === "rolled_back"
      ? "Change rolled back."
      : activation.watchStatus === "paused" || activation.status === "paused"
        ? "Monitoring paused."
        : activation.watchStatus === "alerting"
          ? "Regression found; inspect this change."
          : activation.watchStatus === "insufficient_evidence" || (activation.watchStatus === "stable" && !stable)
            ? "Monitoring ended; more usage needed."
            : stable
              ? "The evidence target for this change was met."
              : activation.watchStatus === "watching"
                ? "Monitoring is in progress."
                : "Monitoring evidence is unavailable.";
  return (
    <section aria-label="Improvement monitoring evidence" className="space-y-1 text-sm wrap-anywhere">
      <p>{label}</p>
      <p className="text-xs text-fg-muted">
        Relevant positives: {legacy || !verifiedCount ? "Not verified" : count + " / " + target}
        {Number.isSafeInteger(activation.regressionCount) && activation.regressionCount >= 0
          ? " · Regressions: " + activation.regressionCount
          : " · Regression count unavailable"}
      </p>
      {incomplete ? (
        <p className="text-xs text-fg-muted">
          Some observations could not be verified; they do not establish stability.
        </p>
      ) : null}
      <p className="text-xs text-fg-muted">
        These observations cover this change; they do not establish general task improvement.
      </p>
    </section>
  );
}
