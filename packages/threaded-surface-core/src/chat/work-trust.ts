export type WorkTrustTone = "default" | "live" | "warning" | "critical" | "success" | "muted";

export interface WorkTrustDescriptor {
  workspaceLabel: string;
  gatewayTone: WorkTrustTone;
  gatewayLabel: string;
  gatewayDetail?: string;
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

export interface ThreadedGatewayStatusSummary {
  ready: boolean;
  tone: WorkTrustTone;
  label: string;
  detail: string;
}

export interface ThreadedSessionStatusSummary {
  providerModelSummary: string;
  runtimeRunSummary: string;
  approvalsSummary: string;
  compactPolicySummary: string;
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

export function buildThreadedGatewayStatusSummary(input: {
  gatewayReady: boolean;
  gatewayMessage?: string | null;
  dashboardError?: string | null;
  healthError?: string | null;
  daemonRunning?: boolean | null;
}): ThreadedGatewayStatusSummary {
  const gatewayMessage = input.gatewayMessage?.trim();
  if (!input.gatewayReady) {
    return {
      ready: false,
      tone: "warning",
      label: "Gateway unavailable",
      detail: gatewayMessage || "Mission Control is waiting for gateway access before runtime status can be trusted.",
    };
  }

  const staleSources = [
    input.dashboardError ? `dashboard status refresh failed: ${input.dashboardError}` : null,
    input.healthError ? `daemon health refresh failed: ${input.healthError}` : null,
  ].filter((item): item is string => Boolean(item));
  if (staleSources.length > 0) {
    return {
      ready: true,
      tone: "warning",
      label: "Gateway ready, status stale",
      detail: `Gateway access is ready, but ${staleSources.join("; ")}.`,
    };
  }

  const daemonDetail =
    input.daemonRunning === false
      ? "Daemon health is reachable but needs operator intervention."
      : input.daemonRunning === true
        ? "Daemon health is serving."
        : "Daemon health is still checking.";
  return {
    ready: true,
    tone: input.daemonRunning === false ? "warning" : "success",
    label: "Gateway ready",
    detail: gatewayMessage ? `${gatewayMessage}. ${daemonDetail}` : `Gateway access is ready. ${daemonDetail}`,
  };
}

export function buildThreadedSessionStatusSummary(input: {
  trust: WorkTrustDescriptor;
  policySummary?: string | null;
  policyOverrideActive?: boolean;
}): ThreadedSessionStatusSummary {
  const runtimeRunSummary = [input.trust.runtimeSummary, input.trust.runStateSummary]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))
    .join(" · ");
  return {
    providerModelSummary: input.trust.providerModelSummary,
    runtimeRunSummary: runtimeRunSummary || "Runtime pending",
    approvalsSummary: input.trust.approvalsSummary,
    compactPolicySummary: formatCompactPolicySummary(input.policySummary, Boolean(input.policyOverrideActive)),
  };
}

function formatCompactPolicySummary(policySummary?: string | null, overrideActive = false): string {
  const summary = policySummary?.trim();
  if (!summary) {
    return "Policy pending";
  }
  if (summary === "Policy loading" || summary === "Policy unavailable") {
    return summary;
  }
  const profile = summary
    .replace(/^Policy:\s*/i, "")
    .split("·")[0]
    ?.trim();
  if (!profile) {
    return summary;
  }
  return overrideActive ? `Policy: ${profile} · override` : `Policy: ${profile}`;
}

function formatCostDisplay(cost: number): string {
  return `$${cost.toFixed(cost >= 10 ? 1 : 2)}`;
}

export function formatWorkloadSummaryDescriptor(input: {
  approvalsCount: number;
  activeAgentsCount: number;
  openTasksCount: number;
  dailyCostUsd: number;
}): WorkloadSummaryDescriptor {
  const { approvalsCount, activeAgentsCount, openTasksCount, dailyCostUsd } = input;
  const formattedDailyCost = formatCostDisplay(dailyCostUsd);
  if (approvalsCount > 0) {
    return {
      tone: "warning",
      label: `${approvalsCount} approval${approvalsCount === 1 ? "" : "s"} waiting`,
    };
  }
  if (activeAgentsCount > 0) {
    return {
      tone: "live",
      label: `${activeAgentsCount} agent${activeAgentsCount === 1 ? "" : "s"} live · ${openTasksCount} task${openTasksCount === 1 ? "" : "s"} · ${formattedDailyCost}`,
    };
  }
  if (openTasksCount > 0) {
    return {
      tone: "muted",
      label: `${openTasksCount} open task${openTasksCount === 1 ? "" : "s"} · ${formattedDailyCost}`,
    };
  }
  return {
    tone: "muted",
    label: dailyCostUsd > 0 ? `${formattedDailyCost} today` : "Workload clear",
  };
}
