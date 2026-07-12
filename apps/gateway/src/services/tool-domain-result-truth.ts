export interface ToolDomainExecutionFailure {
  message: string;
  kind: "failed" | "manual_reconciliation";
  manualReconciliationRequired: boolean;
}

export function readToolDomainExecutionFailure(
  domainResult: Record<string, unknown>,
  policyReason: string,
): ToolDomainExecutionFailure | undefined {
  const status = typeof domainResult.status === "string" ? domainResult.status.toLowerCase() : undefined;
  const deliveryStatus =
    typeof domainResult.deliveryStatus === "string" ? domainResult.deliveryStatus.toLowerCase() : undefined;
  const statusCode =
    typeof domainResult.status === "number"
      ? domainResult.status
      : typeof domainResult.status === "string" && /^\d{3}$/u.test(domainResult.status)
        ? Number(domainResult.status)
        : undefined;
  const hasErrorDetail = typeof domainResult.error === "string" && Boolean(domainResult.error.trim());
  const hasFailureFallbackReason =
    domainResult.fallbackUsed !== true &&
    typeof domainResult.fallbackReason === "string" &&
    Boolean(domainResult.fallbackReason.trim());
  const manualReconciliationRequired =
    domainResult.manualReconciliationRequired === true ||
    domainResult.externalOutcome === "unknown_after_send" ||
    deliveryStatus === "manual_reconciliation_required";
  const failed =
    domainResult.ok === false ||
    domainResult.success === false ||
    hasErrorDetail ||
    hasFailureFallbackReason ||
    (statusCode !== undefined && statusCode >= 400) ||
    manualReconciliationRequired ||
    (status !== undefined && ["blocked", "degraded", "error", "failed", "not_available"].includes(status)) ||
    (deliveryStatus !== undefined && ["blocked", "degraded", "failed", "not_available"].includes(deliveryStatus));
  if (!failed) {
    return undefined;
  }
  let message: string | undefined;
  for (const key of ["error", "fallbackReason", "message"] as const) {
    const detail = domainResult[key];
    if (typeof detail === "string" && detail.trim()) {
      message = detail.trim();
      break;
    }
  }
  return {
    message: message ?? (policyReason === "allowed" ? "Tool reported a failed domain result." : policyReason),
    kind: manualReconciliationRequired ? "manual_reconciliation" : "failed",
    manualReconciliationRequired,
  };
}
