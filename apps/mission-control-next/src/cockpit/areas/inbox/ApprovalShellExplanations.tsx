import type { ShellCommandExplanation } from "@goatcitadel/contracts";
import { explainShellCommand } from "@goatcitadel/mission-control-shared";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { RiskBadge } from "../../ui/RiskBadge";
import { shellRiskAsApprovalRisk } from "./inbox-vocabulary";

export function ApprovalShellExplanations({
  commands,
  explanations,
}: {
  commands: readonly string[];
  explanations?: readonly ShellCommandExplanation[];
}) {
  return (
    <section aria-label="Command explanations" className="grid min-w-0 gap-2">
      {commands.map((command, index) => {
        const explanation =
          explanations?.[index]?.command === command ? explanations[index]! : explainShellCommand(command);
        return (
          <details key={`${index}:${command}`} className="min-w-0 rounded border border-line p-2">
            <summary>
              {explanation.summary} · <RiskBadge risk={shellRiskAsApprovalRisk[explanation.highestRisk]} />
            </summary>
            <pre className="overflow-auto whitespace-pre-wrap break-all">{command}</pre>
            <dl>
              {explanation.details.map((detail, i) => (
                <div key={i}>
                  <dt>{detail.label}</dt>
                  <dd className="break-all">
                    {detail.value} {detail.note}
                  </dd>
                </div>
              ))}
            </dl>
            {explanation.risks.map((risk, i) => (
              <p key={i}>
                {presentRiskLevel(shellRiskAsApprovalRisk[risk.level]).label}: {risk.label}. {risk.explanation}
              </p>
            ))}
          </details>
        );
      })}
    </section>
  );
}
