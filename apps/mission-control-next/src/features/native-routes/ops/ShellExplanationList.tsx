import { useMemo } from "react";
import type { ShellCommandExplanation } from "@goatcitadel/contracts";
import type { ApprovalCommandPreview } from "@goatcitadel/mission-control-shared/content/approval-generic-evidence";
import { explainShellCommand } from "@goatcitadel/mission-control-shared";

export interface ShellExplanationListProps {
  readonly commands: readonly ApprovalCommandPreview[];
  readonly explanations?: readonly ShellCommandExplanation[];
}

export function ShellExplanationList({ commands, explanations }: ShellExplanationListProps) {
  const resolved = useMemo(
    () =>
      commands.map(({ text, truncated }) => ({
        text,
        explanation: truncated
          ? undefined
          : (explanations?.find((explanation) => explanation.command === text) ?? explainShellCommand(text)),
      })),
    [commands, explanations],
  );

  if (resolved.length === 0) {
    return null;
  }

  return (
    <div className="mc-next-approvals-shell-list">
      {resolved.map(({ text, explanation }, idx) =>
        explanation ? (
          <ShellExplanationCard key={idx} explanation={explanation} />
        ) : (
          <div key={idx} className="mc-next-approvals-shell-card">
            <p>Command preview is shortened.</p>
            <code className="mc-next-approvals-shell-raw">{text}</code>
          </div>
        ),
      )}
    </div>
  );
}

function ShellExplanationCard({ explanation }: { readonly explanation: ShellCommandExplanation }) {
  const riskClass = `mc-next-approvals-shell-card-risk-${explanation.highestRisk}`;
  return (
    <div className={`mc-next-approvals-shell-card ${riskClass}`}>
      <div className="mc-next-approvals-shell-head">
        <span className="mc-next-approvals-shell-summary">{explanation.summary}</span>
        {explanation.highestRisk !== "info" ? (
          <span className={`mc-next-approvals-shell-chip mc-next-approvals-shell-chip-${explanation.highestRisk}`}>
            {explanation.highestRisk}
          </span>
        ) : null}
      </div>
      {explanation.details.length > 0 ? (
        <dl className="mc-next-approvals-shell-details">
          {explanation.details.map((d) => (
            <div className="mc-next-approvals-shell-detail-row" key={`${d.label}-${d.value}`}>
              <dt>{d.label}</dt>
              <dd>
                {d.value}
                {d.note ? (
                  <span
                    className={`mc-next-approvals-shell-note mc-next-approvals-shell-note-${d.noteLevel ?? "info"}`}
                  >
                    {d.note}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <code className="mc-next-approvals-shell-raw">{explanation.command}</code>
    </div>
  );
}
