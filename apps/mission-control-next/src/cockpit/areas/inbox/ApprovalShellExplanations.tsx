import type { ApprovalRequest, ShellCommandExplanation } from "@goatcitadel/contracts";
import { explainShellCommand } from "@goatcitadel/mission-control-shared";
import type { ApprovalCommandPreview } from "@goatcitadel/mission-control-shared/content/approval-generic-evidence";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { RiskBadge } from "../../ui/RiskBadge";
import { higherApprovalRisk, shellRiskAsApprovalRisk } from "./inbox-vocabulary";

function summaryRisk(
  explanation: ShellCommandExplanation,
  approvalRisk: ApprovalRequest["riskLevel"] | undefined,
): ApprovalRequest["riskLevel"] {
  const own = shellRiskAsApprovalRisk[explanation.highestRisk];
  return approvalRisk ? higherApprovalRisk(approvalRisk, own) : own;
}

export function ApprovalShellExplanations({
  commands,
  explanations,
  approvalRisk,
}: {
  commands: readonly ApprovalCommandPreview[];
  explanations?: readonly ShellCommandExplanation[];
  /** The approval's own risk. When given, the summary shows the stricter of it and the command's own rating. */
  approvalRisk?: ApprovalRequest["riskLevel"];
}) {
  return (
    <section aria-label="Command explanations" className="grid min-w-0 divide-y divide-line-subtle">
      {commands.map(({ text, truncated }, index) => {
        if (truncated) {
          return (
            <details key={`${index}:${text}`} className="min-w-0 py-2">
              <summary>Command preview is shortened</summary>
              <pre className="overflow-auto whitespace-pre-wrap break-all">{text}</pre>
            </details>
          );
        }
        const explanation = explanations?.find((entry) => entry.command === text) ?? explainShellCommand(text);
        return (
          <details key={`${index}:${text}`} className="min-w-0 py-2">
            <summary>
              {explanation.summary} · <RiskBadge risk={summaryRisk(explanation, approvalRisk)} />
            </summary>
            <pre className="overflow-auto whitespace-pre-wrap break-all">{text}</pre>
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
