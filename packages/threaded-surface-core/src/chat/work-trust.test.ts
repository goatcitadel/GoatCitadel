import { describe, expect, it } from "vitest";
import { formatWorkProviderModelSummary, formatWorkloadSummaryDescriptor } from "./work-trust";

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
});
