import { describe, expect, it } from "vitest";
import { formatWorkProviderModelSummary, formatWorkloadSummaryDescriptor } from "./work-trust";

describe("formatWorkProviderModelSummary", () => {
  it("prefers explicit provider/model labels and falls back to pending routing copy", () => {
    expect(formatWorkProviderModelSummary("OpenAI", "GPT-5.4")).toBe("OpenAI / GPT-5.4");
    expect(formatWorkProviderModelSummary("Anthropic", null)).toBe("Anthropic");
    expect(formatWorkProviderModelSummary(null, "Gemini 3")).toBe("Gemini 3");
    expect(formatWorkProviderModelSummary(null, undefined)).toBe("Provider routing pending");
  });
});

describe("formatWorkloadSummaryDescriptor", () => {
  it("prioritizes waiting approvals over live workload detail", () => {
    expect(
      formatWorkloadSummaryDescriptor({
        approvalsCount: 2,
        activeAgentsCount: 4,
        openTasksCount: 8,
        dailyCostUsd: 12.35,
      }),
    ).toEqual({
      tone: "warning",
      label: "2 approvals waiting",
    });
  });

  it("describes live agents, open tasks, task-only load, and clear days with cost precision", () => {
    expect(
      formatWorkloadSummaryDescriptor({
        approvalsCount: 0,
        activeAgentsCount: 1,
        openTasksCount: 1,
        dailyCostUsd: 9.876,
      }),
    ).toEqual({
      tone: "live",
      label: "1 agent live · 1 task · $9.88",
    });

    expect(
      formatWorkloadSummaryDescriptor({
        approvalsCount: 0,
        activeAgentsCount: 0,
        openTasksCount: 3,
        dailyCostUsd: 10.24,
      }),
    ).toEqual({
      tone: "muted",
      label: "3 open tasks · $10.2",
    });

    expect(
      formatWorkloadSummaryDescriptor({
        approvalsCount: 0,
        activeAgentsCount: 0,
        openTasksCount: 0,
        dailyCostUsd: 0,
      }),
    ).toEqual({
      tone: "muted",
      label: "Workload clear",
    });
  });
});
