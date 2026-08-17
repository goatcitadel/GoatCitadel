// @vitest-environment happy-dom
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { CitadelBrief } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchCitadelBrief: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

import { buildBriefMarkdown, CitadelBriefPanel, formatBriefAge } from "./CitadelBriefPanel";

const BRIEF: CitadelBrief = {
  citadelId: "personal",
  citadelName: "Personal",
  since: "2026-08-15T18:00:00.000Z",
  generatedAt: "2026-08-16T18:00:00.000Z",
  workspaces: [{ workspaceId: "ws-1", name: "Default" }],
  approvals: {
    pendingCount: 2,
    oldestAgeMs: 14 * 60 * 60 * 1000,
    pending: [
      {
        approvalId: "appr-old",
        workspaceId: "ws-1",
        kind: "tool_invoke",
        riskLevel: "danger",
        createdAt: "2026-08-16T04:00:00.000Z",
        ageMs: 14 * 60 * 60 * 1000,
      },
      {
        approvalId: "appr-young",
        workspaceId: "ws-1",
        kind: "code_mode_run",
        riskLevel: "caution",
        createdAt: "2026-08-16T17:00:00.000Z",
        ageMs: 60 * 60 * 1000,
      },
    ],
  },
  activity: { eventsSince: 12, completedSince: 4, failedSince: 1, wardHitsSince: 2, byType: [] },
  spend: { scope: "instance", sinceUsd: 1.75, sinceTokens: 5000, complete: false },
  memory: { pendingRecommendations: 3 },
};

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

async function renderPanel(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<CitadelBriefPanel citadelId="personal" />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchCitadelBrief.mockResolvedValue(BRIEF);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatBriefAge", () => {
  it("humanizes ages at minute, hour, and day granularity", () => {
    expect(formatBriefAge(30_000)).toBe("just now");
    expect(formatBriefAge(9 * 60_000)).toBe("9m");
    expect(formatBriefAge(14 * 60 * 60 * 1000 + 20 * 60_000)).toBe("14h 20m");
    expect(formatBriefAge(2 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000)).toBe("2d 3h");
  });
});

describe("buildBriefMarkdown", () => {
  it("renders the summary lines and the waiting-on-you section", () => {
    const markdown = buildBriefMarkdown(BRIEF);
    expect(markdown).toContain("# Daily brief — Personal");
    expect(markdown).toContain("Pending approvals: 2 (oldest 14h 0m)");
    expect(markdown).toContain("12 events · 4 completed · 1 failed · 2 ward hits");
    expect(markdown).toContain("(partial data)");
    expect(markdown).toContain("3 recommendation(s) pending review");
    expect(markdown).toContain("## Waiting on you");
    expect(markdown).toContain("waiting 14h 0m");
  });

  it("reports memory unavailability instead of a count", () => {
    const markdown = buildBriefMarkdown({ ...BRIEF, memory: { unavailable: "feature disabled" } });
    expect(markdown).toContain("Memory: unavailable (feature disabled)");
  });
});

describe("CitadelBriefPanel", () => {
  it("loads the brief and renders stats plus the pending approval rows", async () => {
    const renderer = await renderPanel();
    const text = textOf(renderer.root);

    expect(api.fetchCitadelBrief).toHaveBeenCalledWith("personal");
    expect(text).toContain("Daily brief");
    expect(text).toContain("2 Pending approvals");
    expect(text).toContain("2 Ward hits");
    expect(text).toContain("$1.75 (partial) Spend");
    expect(text).toContain("Tool invoke");
    expect(text).toContain("waiting 14h 0m");
    expect(text).toContain("3 memory recommendations pending review.");

    renderer.unmount();
  });

  it("surfaces a load failure as a warning without crashing the page", async () => {
    api.fetchCitadelBrief.mockRejectedValue(new Error("gateway unreachable"));
    const renderer = await renderPanel();

    expect(textOf(renderer.root)).toContain("gateway unreachable");

    renderer.unmount();
  });
});
