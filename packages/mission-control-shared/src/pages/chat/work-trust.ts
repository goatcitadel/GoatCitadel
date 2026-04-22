export type WorkTrustTone = "default" | "live" | "warning" | "critical" | "success" | "muted";

export interface WorkTrustDescriptor {
  workspaceLabel: string;
  gatewayTone: WorkTrustTone;
  gatewayLabel: string;
  approvalsSummary: string;
  runStateSummary?: string;
  activeModeLabel: string;
  providerModelSummary: string;
  runtimeSummary: string;
  requestedProviderModelSummary?: string;
  effectiveProviderModelSummary?: string;
  selectionSourceSummary?: string;
  fallbackSummary?: string;
  fallbackTone?: WorkTrustTone;
  runtimeTone?: WorkTrustTone;
}

export interface WorkloadSummaryDescriptor {
  tone: WorkTrustTone;
  label: string;
}

export function formatWorkProviderModelSummary(providerLabel?: string | null, modelLabel?: string | null): string {
  if (providerLabel && modelLabel) {
    return `${providerLabel} / ${modelLabel}`;
  }
  if (providerLabel) {
    return providerLabel;
  }
  if (modelLabel) {
    return modelLabel;
  }
  return "Provider routing pending";
}

export function formatWorkloadSummaryDescriptor(input: {
  approvalsCount: number;
  activeAgentsCount: number;
  openTasksCount: number;
  dailyCostUsd: number;
}): WorkloadSummaryDescriptor {
  const { approvalsCount, activeAgentsCount, openTasksCount, dailyCostUsd } = input;
  if (approvalsCount > 0) {
    return {
      tone: "warning",
      label: `${approvalsCount} approval${approvalsCount === 1 ? "" : "s"} waiting`,
    };
  }
  if (activeAgentsCount > 0) {
    return {
      tone: "live",
      label: `${activeAgentsCount} agent${activeAgentsCount === 1 ? "" : "s"} live · ${openTasksCount} task${openTasksCount === 1 ? "" : "s"} · $${dailyCostUsd.toFixed(dailyCostUsd >= 10 ? 1 : 2)}`,
    };
  }
  if (openTasksCount > 0) {
    return {
      tone: "muted",
      label: `${openTasksCount} open task${openTasksCount === 1 ? "" : "s"} · $${dailyCostUsd.toFixed(dailyCostUsd >= 10 ? 1 : 2)}`,
    };
  }
  return {
    tone: "muted",
    label: dailyCostUsd > 0 ? `$${dailyCostUsd.toFixed(dailyCostUsd >= 10 ? 1 : 2)} today` : "Workload clear",
  };
}
