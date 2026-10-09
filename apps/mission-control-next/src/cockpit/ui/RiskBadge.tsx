import type { ApprovalRequest } from "@goatcitadel/contracts";
import { Shield, ShieldAlert } from "lucide-react";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { StatusBadge } from "./StatusBadge";

export function RiskBadge({ risk }: { risk: ApprovalRequest["riskLevel"] }) {
  const status = presentRiskLevel(risk);
  return <StatusBadge status={{ ...status, label: `${status.label} risk` }} icon={risk === "safe" ? Shield : ShieldAlert} />;
}
