import { useQualityEvidenceClipboard } from "../../../../features/native-routes/ops/use-quality-evidence-clipboard";
import { Button } from "../../../ui/Button";

export function QualityExports() {
  const { copy, pending, notice } = useQualityEvidenceClipboard();
  return (
    <details className="rounded-lg border border-line bg-raised p-4">
      <summary className="cursor-pointer text-sm font-semibold text-fg">Evidence exports</summary>
      <p className="mt-2 text-sm text-fg-secondary">
        Copy stored evidence from the Gateway. These read-only exports do not call providers, rerun checks, or approve
        quality.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={pending !== null} onClick={() => void copy("evaluations")}>
          {pending === "evaluations" ? "Copying evaluation evidence…" : "Copy evaluation evidence"}
        </Button>
        <Button size="sm" disabled={pending !== null} onClick={() => void copy("quality")}>
          {pending === "quality" ? "Copying quality evidence…" : "Copy quality transport evidence"}
        </Button>
      </div>
      {notice ? (
        <p role={notice.error ? "alert" : "status"} className="mt-2 text-sm text-fg-secondary">
          {notice.text}
        </p>
      ) : null}
    </details>
  );
}
