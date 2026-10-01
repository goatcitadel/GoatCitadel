import { useProviderAdvice } from "../../../features/native-routes/settings/sections/use-provider-advice";
import { Button } from "../../ui/Button";

export function ProviderAdviceSettings() {
  const { state, load } = useProviderAdvice();
  return (
    <details className="mt-4 rounded-lg border border-line bg-raised p-4">
      <summary className="cursor-pointer font-display text-md font-semibold text-fg">Provider advice</summary>
      <p className="my-3 text-sm text-fg-secondary">
        Compare Gateway recommendations. Advice does not change saved routing or prove provider availability.
      </p>
      <Button disabled={state.loading} onClick={() => void load()}>
        {state.loading ? "Loading advice…" : "Load provider advice"}
      </Button>
      {state.error ? (
        <p role="alert" className="mt-3 text-sm text-status-failed">
          Advice unavailable: {state.error}
        </p>
      ) : null}
      {state.data ? (
        <div className="mt-3 space-y-3 text-sm text-fg-secondary">
          <p>
            Observed {state.data.generatedAt}.{" "}
            {state.data.advisoryOnly && !state.data.mutationPerformed
              ? "Advisory only; no settings mutation."
              : "The response did not confirm advisory-only execution."}
          </p>
          {state.data.warnings?.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          {Array.isArray(state.data.candidates) ? (
            <ul className="space-y-3">
              {state.data.candidates.slice(0, 5).map((candidate) => (
                <li
                  key={`${candidate.providerId}:${candidate.model}`}
                  className="rounded-md border border-line-subtle p-3"
                >
                  <strong className="text-fg">
                    {candidate.providerLabel} · {candidate.model}
                  </strong>
                  <p>
                    Fit score {candidate.fitScore} · Estimated cost{" "}
                    {candidate.estimatedCostUsd === undefined ? "Unknown" : `$${candidate.estimatedCostUsd.toFixed(4)}`}{" "}
                    · Runtime fit {candidate.localRuntimeFit?.fit ?? "Unknown"} (
                    {candidate.measurementSource ?? "Unavailable"})
                  </p>
                  <p>{candidate.riskNotes.join(" ")}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p>Candidate evidence unavailable.</p>
          )}
        </div>
      ) : null}
    </details>
  );
}
