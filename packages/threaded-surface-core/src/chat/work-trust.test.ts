import { describe, expect, it } from "vitest";
import {
  buildThreadedGatewayStatusSummary,
  buildThreadedSessionStatusSummary,
  formatWorkProviderModelSummary,
  formatWorkloadSummaryDescriptor,
} from "./work-trust";

describe("work-trust", () => {
  it("formats provider/model summaries with pending fallbacks", () => {
    expect(formatWorkProviderModelSummary("OpenAI", "gpt-5.5")).toBe("OpenAI / gpt-5.5");
    expect(formatWorkProviderModelSummary("OpenAI", null)).toBe("OpenAI");
    expect(formatWorkProviderModelSummary(null, "gpt-5.5")).toBe("gpt-5.5");
    expect(formatWorkProviderModelSummary(null, null)).toBe("Provider routing pending");
  });

  it("prioritizes workload approval, live-agent, task, and cost states", () => {
    expect(
      formatWorkloadSummaryDescriptor({
        approvalsCount: 2,
        activeAgentsCount: 1,
        openTasksCount: 3,
        dailyCostUsd: 12.34,
      }),
    ).toEqual({ tone: "warning", label: "2 approvals waiting" });
    expect(
      formatWorkloadSummaryDescriptor({
        approvalsCount: 1,
        activeAgentsCount: 0,
        openTasksCount: 0,
        dailyCostUsd: 0,
      }),
    ).toEqual({ tone: "warning", label: "1 approval waiting" });
    expect(
      formatWorkloadSummaryDescriptor({
        approvalsCount: 0,
        activeAgentsCount: 2,
        openTasksCount: 1,
        dailyCostUsd: 9.876,
      }),
    ).toEqual({ tone: "live", label: "2 agents live · 1 task · $9.88" });
    expect(
      formatWorkloadSummaryDescriptor({
        approvalsCount: 0,
        activeAgentsCount: 1,
        openTasksCount: 2,
        dailyCostUsd: 12.34,
      }),
    ).toEqual({ tone: "live", label: "1 agent live · 2 tasks · $12.3" });
    expect(
      formatWorkloadSummaryDescriptor({
        approvalsCount: 0,
        activeAgentsCount: 0,
        openTasksCount: 2,
        dailyCostUsd: 0.5,
      }),
    ).toEqual({ tone: "muted", label: "2 open tasks · $0.50" });
    expect(
      formatWorkloadSummaryDescriptor({ approvalsCount: 0, activeAgentsCount: 0, openTasksCount: 0, dailyCostUsd: 3 }),
    ).toEqual({
      tone: "muted",
      label: "$3.00 today",
    });
    expect(
      formatWorkloadSummaryDescriptor({ approvalsCount: 0, activeAgentsCount: 0, openTasksCount: 0, dailyCostUsd: 0 }),
    ).toEqual({
      tone: "muted",
      label: "Workload clear",
    });
  });

  it("normalizes shell gateway status for threaded surfaces", () => {
    expect(
      buildThreadedGatewayStatusSummary({
        gatewayReady: true,
        gatewayMessage: "Gateway ready",
        daemonRunning: true,
      }),
    ).toEqual({
      ready: true,
      tone: "success",
      label: "Gateway ready",
      detail: "Gateway ready. Daemon health is serving.",
    });

    expect(
      buildThreadedGatewayStatusSummary({
        gatewayReady: true,
        gatewayMessage: "Gateway ready",
        dashboardError: "dashboard offline",
        healthError: "health offline",
      }),
    ).toEqual({
      ready: true,
      tone: "warning",
      label: "Gateway ready, status stale",
      detail:
        "Gateway access is ready, but dashboard status refresh failed: dashboard offline; daemon health refresh failed: health offline.",
    });

    expect(buildThreadedGatewayStatusSummary({ gatewayReady: false })).toEqual({
      ready: false,
      tone: "warning",
      label: "Gateway unavailable",
      detail: "Mission Control is waiting for gateway access before runtime status can be trusted.",
    });
  });

  it("compacts session status for threaded header chips", () => {
    expect(
      buildThreadedSessionStatusSummary({
        trust: {
          workspaceLabel: "Workspace",
          gatewayTone: "success",
          gatewayLabel: "Gateway ready",
          approvalsSummary: "2 decisions",
          runStateSummary: "Run: waiting for approval",
          activeModeLabel: "Code",
          providerModelSummary: "OpenAI / gpt-5.5",
          runtimeSummary: "Provider reachable",
        },
        policySummary: "Policy: Trusted Local Power · skips normal prompts · override until 20:30 UTC",
        policyOverrideActive: true,
      }),
    ).toEqual({
      providerModelSummary: "OpenAI / gpt-5.5",
      runtimeRunSummary: "Provider reachable · Run: waiting for approval",
      approvalsSummary: "2 decisions",
      compactPolicySummary: "Policy: Trusted Local Power · override",
    });
  });
});
