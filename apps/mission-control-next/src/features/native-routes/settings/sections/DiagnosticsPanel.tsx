import type { ConnectorDiagnosticReport } from "@goatcitadel/contracts";
import { SettingsActionList, SettingsCodeBlock } from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { plainCheckName } from "../diagnostic-check-names";

export function DiagnosticsPanel({ report, ariaLabel }: { report: ConnectorDiagnosticReport; ariaLabel: string }) {
  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="Diagnostics"
      subtitle={`Status: ${report.status}`}
    >
      <SettingsActionList
        ariaLabel={ariaLabel}
        items={report.checks.map((check) => ({
          label: plainCheckName(check.key) ?? check.key,
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
