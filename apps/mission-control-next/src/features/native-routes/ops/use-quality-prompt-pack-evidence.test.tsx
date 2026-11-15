// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptPackRecord, PromptPackReportRecord } from "@goatcitadel/contracts";
import { QualityDashboardRoutePage } from "./QualityDashboardRoutePage";
import { createUnavailableQualitySnapshot } from "./QualityDashboardRoutePage.helpers";
import { useQualityPromptPackEvidence } from "./use-quality-prompt-pack-evidence";

const api = vi.hoisted(() => ({ report: vi.fn(), exported: vi.fn(), snapshot: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchPromptPackReport: api.report,
  fetchOpsQualitySnapshot: api.snapshot,
  fetchPromptPackExport: api.exported,
}));
const pack: PromptPackRecord = {
  packId: "pack-a",
  name: "Pack",
  testCount: 1,
  contentSha256: "a".repeat(64),
  createdAt: "created",
  updatedAt: "reviewed",
};
const report = (owner = pack, totalTests = 1): PromptPackReportRecord => ({
  pack: owner,
  tests: [],
  runs: [],
  scores: [],
  autoScoresV2: [],
  humanReviewsV2: [],
  latestAssessments: [],
  summary: {
    totalTests,
    completedRuns: 0,
    failedRuns: 0,
    runFailureCount: 0,
    invalidLatestRuns: 0,
    scoreFailureCount: 0,
    needsScoreCount: 1,
    staleLatestAutoScoreCount: 0,
    judgeFallbackCount: 0,
    judgeErrorCount: 0,
    autoScoredRuns: 0,
    humanReviewedRuns: 0,
    degradedScoreCount: 0,
    passCount: 0,
    failCount: 0,
    reviewCount: 0,
    effectivePassRate: 0,
    reviewRate: 0,
    activeScoringSchemaVersion: "v3",
    passThreshold: 0.8,
    averageTotalScore: 0,
    averageWeightedScore: 0,
    passRate: 0,
    failingCodes: [],
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: Root, container: HTMLDivElement, state: ReturnType<typeof useQualityPromptPackEvidence>;
function Harness({
  owner = pack,
  observed = "first",
  active = true,
}: {
  owner?: PromptPackRecord;
  observed?: string;
  active?: boolean;
}) {
  state = useQualityPromptPackEvidence(active, owner, observed);
  return null;
}
beforeEach(() => {
  vi.resetAllMocks();
  api.report.mockResolvedValue(report());
  api.exported.mockResolvedValue({ packId: pack.packId, path: "report.json", exists: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("selected Quality report owner", () => {
  it("reads only on explicit inspection and withholds foreign or changed records", async () => {
    await act(async () => root.render(<Harness active={false} />));
    expect(api.report).not.toHaveBeenCalled();
    api.report.mockResolvedValueOnce(report({ ...pack, contentSha256: "b".repeat(64) }));
    api.exported.mockResolvedValueOnce({ packId: "foreign", path: "wrong.json", exists: true });
    await act(async () => root.render(<Harness />));
    expect(state.report).toBeNull();
    expect(state.exportInfo).toBeNull();
    expect(state.data?.issues).toHaveLength(2);
  });
  it("refreshes scores for a new snapshot and does not render the old same-definition result", async () => {
    await act(async () => root.render(<Harness />));
    expect(state.report?.summary.totalTests).toBe(1);
    const pending = deferred<PromptPackReportRecord>();
    api.report.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(<Harness observed="second" />));
    expect(state.report).toBeNull();
    expect(state.exportInfo).toBeNull();
    await act(async () => pending.resolve(report(pack, 2)));
    expect(state.report?.summary.totalTests).toBe(2);
  });
  it("ignores a late previous selection and keeps refresh failure visible", async () => {
    const old = deferred<PromptPackReportRecord>();
    api.report.mockReturnValueOnce(old.promise);
    await act(async () => root.render(<Harness />));
    const selected = { ...pack, packId: "pack-b" };
    api.report.mockResolvedValueOnce(report(selected, 2));
    api.exported.mockResolvedValueOnce({ packId: "pack-b", path: "b.json", exists: true });
    await act(async () => root.render(<Harness owner={selected} />));
    await act(async () => old.resolve(report(pack, 999)));
    expect(state.report?.pack.packId).toBe("pack-b");
    expect(state.report?.summary.totalTests).toBe(2);
    api.report.mockRejectedValueOnce(new Error("Report unavailable"));
    await act(async () => state.reload());
    expect(state.report).toBeNull();
    expect(state.data?.issues[0]?.message).toContain("Report unavailable");
  });
});

describe("Classic Quality export path", () => {
  const latest = "fixture/latest.md";
  const archived = "fixture/archive/snapshot.md";
  it.each([
    { exists: false, latestSnapshotExists: false, expectedPath: null },
    { exists: true, latestSnapshotExists: false, expectedPath: latest },
    { exists: false, latestSnapshotExists: true, expectedPath: archived },
  ])("copies only the path of an export reported present ($expectedPath)", async (entry) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    api.snapshot.mockResolvedValue({
      ...createUnavailableQualitySnapshot(),
      promptPacks: { state: "available", items: [pack] },
    });
    api.exported.mockResolvedValue({
      packId: pack.packId,
      path: latest,
      latestPath: latest,
      exists: entry.exists,
      sizeBytes: entry.exists ? 64 : 0,
      latestSnapshotPath: archived,
      latestSnapshotExists: entry.latestSnapshotExists,
      latestSnapshotSizeBytes: entry.latestSnapshotExists ? 128 : undefined,
    });
    await act(async () => {
      root.render(
        <QualityDashboardRoutePage
          route={{ area: "ops", section: "quality", theme: "ops" }}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });
    const button = (label: string) =>
      [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label)!;
    await act(async () => button("Inspect Pack").click());

    const copy = button("Copy prompt-pack export path");
    expect(copy.disabled).toBe(entry.expectedPath === null);
    const details = container.querySelector(".mc-next-detail-inspector")!;
    if (entry.expectedPath) {
      expect(details.textContent).toContain("available");
      expect(details.textContent).toContain(entry.expectedPath);
    } else {
      expect(details.textContent).toContain("not recorded");
      expect(details.textContent).not.toContain(latest);
      expect(details.textContent).not.toContain(archived);
    }
    await act(async () => copy.click());
    if (entry.expectedPath) expect(writeText).toHaveBeenCalledExactlyOnceWith(entry.expectedPath);
    else expect(writeText).not.toHaveBeenCalled();
  });
});
