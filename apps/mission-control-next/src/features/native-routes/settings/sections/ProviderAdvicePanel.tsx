import { Gauge } from "lucide-react";
import type { LlmProviderAdviceResponse } from "@goatcitadel/contracts";
import { NativeButton } from "../../primitives";
import { SettingsButtonRow, SettingsNotice, type LoadState } from "../SettingsShared";

/** Advisory evidence only; the caller owns the read request. */
export function ProviderAdvicePanel({
  providerAdvice,
  onLoad,
}: {
  providerAdvice: LoadState<LlmProviderAdviceResponse>;
  onLoad: () => void;
}) {
  return (
    <>
      <p className="mc-next-settings-field-note">
        {Array.isArray(providerAdvice.data?.candidates)
          ? `${providerAdvice.data.candidates.length} advisory candidates · no configuration mutation`
          : providerAdvice.data
            ? "Candidate evidence unavailable."
            : "Advice has not been loaded."}
      </p>
      {providerAdvice.error ? <SettingsNotice notice={{ tone: "error", message: providerAdvice.error }} /> : null}
      {providerAdvice.data ? (
        <>
          <SettingsNotice
            notice={{
              tone: "info",
              message: providerAdvice.data.warnings?.[0] ?? "Provider advice is advisory only.",
            }}
          />
          <ul className="mc-next-approvals-compact-list">
            {(providerAdvice.data.candidates ?? []).map((candidate) => (
              <li key={`${candidate.providerId}:${candidate.model}`}>
                <strong>
                  {candidate.providerLabel} · {candidate.model}
                </strong>
                <span>
                  Fit {candidate.fitScore} · Cost{" "}
                  {candidate.estimatedCostUsd === undefined ? "unknown" : `$${candidate.estimatedCostUsd.toFixed(4)}`} ·
                  Runtime {candidate.localRuntimeFit?.fit ?? "unknown"} ({candidate.measurementSource ?? "unavailable"})
                </span>
                <p>{candidate.riskNotes.join(" ")}</p>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <SettingsNotice
          notice={{
            tone: "info",
            message:
              "Load advisory provider recommendations to compare configured keys, estimated cost, and routing risk without changing settings.",
          }}
        />
      )}
      <SettingsButtonRow>
        <NativeButton variant="secondary" onClick={onLoad} disabled={providerAdvice.loading}>
          <Gauge size={16} />
          {providerAdvice.loading ? "Loading advice..." : "Load advice"}
        </NativeButton>
      </SettingsButtonRow>
    </>
  );
}
