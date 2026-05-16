import { useMemo } from "react";
import type { ShellCommandExplanation } from "@goatcitadel/contracts";
import { explainShellCommand } from "@goatcitadel/mission-control-shared";

export interface ShellExplanationListProps {
  readonly commands: readonly string[];
  readonly explanations?: readonly ShellCommandExplanation[];
}

export function ShellExplanationList({ commands, explanations }: ShellExplanationListProps) {
  const resolved = useMemo<readonly ShellCommandExplanation[]>(() => {
    if (commands.length === 0) {
      return [];
    }
    if (explanations && explanations.length === commands.length) {
      return explanations;
    }
    return commands.map((cmd) => explainShellCommand(cmd));
  }, [commands, explanations]);

  if (resolved.length === 0) {
    return null;
  }

  return (
    <div className="mc-next-approvals-shell-list">
      {resolved.map((exp, idx) => (
        <ShellExplanationCard key={`${exp.command}-${idx}`} explanation={exp} />
      ))}
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
