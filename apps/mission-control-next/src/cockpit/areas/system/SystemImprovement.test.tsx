// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CuratorReviewItem, WeeklyImprovementReportRecord } from "@goatcitadel/contracts";
import {
  fetchCuratorReviewItems,
  fetchImprovementReplayRun,
  fetchImprovementReplayRuns,
  fetchImprovementReport,
  fetchImprovementReports,
} from "@goatcitadel/mission-control-shared/api/improvement";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { SystemImprovement } from "./SystemImprovement";

vi.mock("@goatcitadel/mission-control-shared/api/improvement", () => ({
  fetchCuratorReviewItems: vi.fn(),
  fetchImprovementReplayRun: vi.fn(),
  fetchImprovementReplayRuns: vi.fn(),
  fetchImprovementReport: vi.fn(),
  fetchImprovementReports: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "one", activeCitadelId: "personal", showTechnicalDetails: false }),
}));

const suggestion = {
  candidate: { candidateId: "cand-1", summary: "Prefer cached lookups", status: "evaluated", supportingSignalCount: 3 },
  evidence: [],
  risk: "medium",
  proposedChange: "Use the cache before calling the provider.",
  callableImpact: "none",
  approvalRequired: true,
  mutationApplied: false,
  runtimeProvenCallable: false,
  corruptionStatus: "clean",
  actionStatuses: { activate: "ready" },
  disabledReasons: {},
} as unknown as CuratorReviewItem;
const report = {
  reportId: "rep-1",
  runId: "run-1",
  weekStart: "2026-09-28",
  weekEnd: "2026-10-04",
  summary: {
    sampledDecisions: 40,
    likelyWrongCount: 3,
    wrongnessRate: 0.075,
    topCauseClasses: [],
    duplicateSuppressedCount: 0,
    improvedCount: 0,
    regressedCount: 0,
  },
  topFindings: [],
  appliedAutoTunes: [],
  queuedRecommendations: [{ tuneId: "tune-1", description: "Raise retry budget", status: "queued", riskLevel: "low" }],
  weekOverWeek: { improved: [], regressed: [], unchanged: [] },
  createdAt: "2026-10-05T00:00:00.000Z",
} as unknown as WeeklyImprovementReportRecord;
let root: Root, container: HTMLDivElement, client: QueryClient;
const writeText = vi.fn(async () => undefined);

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchCuratorReviewItems).mockResolvedValue({ generatedAt: "now", items: [suggestion] } as never);
  vi.mocked(fetchImprovementReports).mockResolvedValue({ items: [report] });
  vi.mocked(fetchImprovementReplayRuns).mockResolvedValue({
    items: [
      {
        runId: "run-1",
        status: "completed",
        startedAt: "2026-10-05T00:00:00.000Z",
        sampleSize: 40,
        totalScored: 40,
        likelyWrongCount: 3,
      } as never,
    ],
  });
  vi.mocked(fetchImprovementReport).mockResolvedValue(report);
  vi.mocked(fetchImprovementReplayRun).mockResolvedValue({
    run: {
      runId: "run-1",
      status: "completed",
      sampleSize: 40,
      totalCandidates: 44,
      totalScored: 40,
      likelyWrongCount: 3,
      modelJudgedCount: 12,
      triggerMode: "manual",
      windowStart: "a",
      windowEnd: "b",
      startedAt: "2026-10-05T00:00:00.000Z",
    },
    items: [],
    findings: [],
    autoTunes: [],
  } as never);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

async function open(path: string) {
  await act(async () => {
    window.history.replaceState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <SystemImprovement />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    );
  });
}
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);

it("lists workspace suggestions and carries the exact candidate request to Chat without applying anything", async () => {
  await open("/system/improvement");
  await vi.waitFor(() => expect(container.textContent).toContain("Prefer cached lookups"));
  expect(fetchCuratorReviewItems).toHaveBeenCalledWith({ limit: 40, workspaceId: "one" });
  expect(container.textContent).toContain("Apply improvement candidate cand-1");
  await act(async () => button("Copy request")!.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("cand-1"));
  expect(container.textContent).toContain("Nothing is applied from here");
});

it("inspects a report from its own record, with advisory copy", async () => {
  await open("/system/improvement?reportId=rep-1");
  await vi.waitFor(() => expect(container.textContent).toContain("40 sampled decisions"));
  expect(fetchImprovementReport).toHaveBeenCalledWith("rep-1");
  expect(container.textContent).toContain("Raise retry budget");
  expect(container.textContent).toContain("do not certify applied changes or performance gains");
});

it("inspects a replay by reading the replay record, not a timeline snapshot", async () => {
  await open("/system/improvement?replayRunId=run-1");
  await vi.waitFor(() => expect(container.textContent).toContain("44 candidates"));
  expect(fetchImprovementReplayRun).toHaveBeenCalledWith("run-1");
  expect(container.textContent).toContain("12 model-judged");
});

it("refuses a report whose identity does not match the selected record", async () => {
  vi.mocked(fetchImprovementReport).mockResolvedValue({ ...report, reportId: "rep-other" });
  await open("/system/improvement?reportId=rep-1");
  await vi.waitFor(() => expect(container.textContent).toContain("Report identity did not match"));
});

it("shows report findings, proposals and harness evidence visibly, and links to its replay run", async () => {
  vi.mocked(fetchImprovementReport).mockResolvedValue({
    ...report,
    topFindings: [
      {
        findingId: "f-1",
        title: "Missed tool on retries",
        summary: "Retries skipped the cache.",
        severity: "high",
        recurrenceCount: 4,
      },
    ],
    proposalDrafts: [
      {
        draftId: "d-1",
        title: "Routing rule for cache",
        summary: "Route lookups through the cache.",
        kind: "routing_rule",
      },
    ],
    routingGapSummary: { totalEvents: 7, topCauseClasses: [], topRequestedTools: ["cache.read"] },
    harnessAudit: {
      generatedAt: "x",
      overallScore: 0.82,
      weakestPillars: [{ pillarId: "evals", label: "Evaluations", score: 0.4 }],
    },
    appliedAutoTunes: [{ tuneId: "tune-9", description: "Lower threshold", status: "applied", riskLevel: "medium" }],
  } as never);
  await open("/system/improvement?reportId=rep-1");
  await vi.waitFor(() => expect(container.textContent).toContain("Missed tool on retries"));
  for (const text of [
    "Routing rule for cache",
    "7 routing-gap events",
    "Evaluations",
    "Lower threshold · applied · risk medium",
  ])
    expect(container.textContent).toContain(text);
  await act(async () => button("Open replay run run-1")!.click());
  await vi.waitFor(() => expect(new URLSearchParams(window.location.search).get("replayRunId")).toBe("run-1"));
});

it("says reports and replay runs are Gateway-wide, not filtered to the workspace", async () => {
  await open("/system/improvement");
  await vi.waitFor(() => expect(container.textContent).toContain("Prefer cached lookups"));
  expect(container.textContent).toContain("Gateway-wide, not filtered to this workspace");
});

it("reports a copy failure when no clipboard is available instead of throwing", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  await open("/system/improvement");
  await vi.waitFor(() => expect(button("Copy request")).toBeDefined());
  await act(async () => button("Copy request")!.click());
  expect(container.textContent).toContain("Copy failed; select the text instead.");
});

it("does not offer a Change Plan for a skill revision, which needs a Code Mode proposal", async () => {
  vi.mocked(fetchCuratorReviewItems).mockResolvedValue({
    generatedAt: "now",
    items: [{ ...suggestion, candidate: { ...suggestion.candidate, kind: "skill_revision" } }],
  } as never);
  await open("/system/improvement");
  await vi.waitFor(() => expect(container.textContent).toContain("Prefer cached lookups"));
  expect(container.textContent).toContain("needs a Code Mode proposal");
  expect(container.textContent).not.toContain("Ready for a Change Plan");
  expect(button("Copy request")).toBeUndefined();
});

it("states an inbox failure without claiming there are no suggestions", async () => {
  vi.mocked(fetchCuratorReviewItems).mockRejectedValue(new Error("Inbox unavailable"));
  await open("/system/improvement");
  await vi.waitFor(() => expect(container.textContent).toContain("Inbox unavailable"));
  expect(container.textContent).not.toContain("No improvement suggestions");
});
