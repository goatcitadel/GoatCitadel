// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import type { ConnectorDiagnosticReport } from "@goatcitadel/contracts";
import { SettingsActionList, SettingsCodeBlock } from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";

export function DiagnosticsPanel({ report }: { report: ConnectorDiagnosticReport }) {
  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="Diagnostics"
      subtitle={`Status: ${report.status}`}
    >
      <SettingsActionList
        items={report.checks.map((check) => ({
          label: check.key,
          description: check.message,
          meta: check.status,
        }))}
      />
      {report.recommendedNextAction ? (
        <SettingsCodeBlock label="Recommended next action">{report.recommendedNextAction}</SettingsCodeBlock>
      ) : null}
    </NativeCard>
  );
}
