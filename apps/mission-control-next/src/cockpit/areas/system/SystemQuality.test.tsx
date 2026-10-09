// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpsQualitySnapshotResponse, PromptPackRecord, PromptPackReportRecord } from "@goatcitadel/contracts";
import { createUnavailableQualitySnapshot } from "../../../features/native-routes/ops/QualityDashboardRoutePage.helpers";
import { SystemQuality } from "./SystemQuality";
import { QualityExports } from "./quality/QualityExports";

const api = vi.hoisted(() => ({ snapshot: vi.fn(), evalExport: vi.fn(), qualityExport: vi.fn(), packReport: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/ops-quality", () => ({ fetchOpsQualitySnapshot: api.snapshot, exportOpsQualityEvidence: api.qualityExport }));
vi.mock("@goatcitadel/mission-control-shared/api/platform", () => ({ exportLlmEvalProofRuns: api.evalExport }));
vi.mock("@goatcitadel/mission-control-shared/api/prompt-packs", () => ({ fetchPromptPackReport: api.packReport }));

const stamp = "2026-09-30T14:00:00.000Z";
const pack: PromptPackRecord = { packId: "pack-a", name: "Owner pack", testCount: 7, createdAt: stamp, updatedAt: stamp, contentSha256: "a".repeat(64) };
function snapshot(): OpsQualitySnapshotResponse {
  const base = createUnavailableQualitySnapshot();
  return { ...base, generatedAt: stamp, metricScope: { ...base.metricScope, note: "At most 200 packs and 25 evaluations." },
    promptPacks: { state: "available", items: [pack] },
    evalProof: { state: "available", items: ["first", "second"].map((id, index) => ({ runId: id, promptHash: id.repeat(8),
      status: "completed_with_warnings", createdAt: stamp, candidates: [{ providerId: "fixture", model: id }],
      results: [{ providerId: "fixture", model: id, measurementSource: "unavailable", qualityScoreSource: index ? "unavailable" : "operator",
        ...(index ? {} : { qualityScore: 0 }), paretoOptimal: false, notes: [`Only ${id} evidence`] }], warnings: [] })) },
    securityQualityGates: { state: "available", warnings: [], items: [{ gateId: "gate-a", packKey: "builtin-a", title: "Defensive gate",
      status: "needs_score", releaseGate: true, readOnly: true, packId: pack.packId, generatedAt: stamp,
      evidence: { definitionStatus: "imported", testCount: 7, completedRuns: 3, failedRuns: 1, needsScoreCount: 2,
        passCount: 1, failCount: 1, reviewCount: 1, effectivePassRate: 0.333, passThreshold: 0.8, failingCodes: ["TEST-1"] },
      blockers: ["Two scores are missing."], nextActions: ["Review stored results."],
      posture: { callsProviders: false, mutationPerformed: false, source: "stored_prompt_pack_report", note: "Stored report only." } }] },
    designQuality: { ...base.designQuality, state: "available", checks: ["design-a", "design-b"].map((id) => ({
      id, label: "Same check label", severity: "P1", status: "advisory", owner: "UI", evidence: `Evidence for ${id}`, nextAction: `Review ${id}` })) },
  };
}
function packReport(owner: PromptPackRecord, totalTests = 7): PromptPackReportRecord {
  return { pack: owner, tests: [], runs: [], scores: [], autoScoresV2: [], humanReviewsV2: [], latestAssessments: [], summary: {
    totalTests, completedRuns: 2, failedRuns: 0, runFailureCount: 0, invalidLatestRuns: 0, scoreFailureCount: 0,
    needsScoreCount: 1, staleLatestAutoScoreCount: 0, judgeFallbackCount: 0, judgeErrorCount: 0, autoScoredRuns: 0,
    humanReviewedRuns: 0, degradedScoreCount: 0, passCount: 1, failCount: 0, reviewCount: 1, effectivePassRate: 0.5,
    reviewRate: 0.5, activeScoringSchemaVersion: "v3", passThreshold: 0.8, averageTotalScore: 0, averageWeightedScore: 0,
    passRate: 0.5, failingCodes: [],
  } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
let root: Root, container: HTMLDivElement, client: QueryClient;
const clipboard = vi.fn();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected real network in Quality test"))));
  api.snapshot.mockResolvedValue(snapshot());
  api.packReport.mockResolvedValue(packReport(pack));
  api.evalExport.mockResolvedValue({ content: "exact eval payload", posture: { readOnly: true, sideEffectPosture: "audit_only" } });
  api.qualityExport.mockResolvedValue({ content: "exact quality payload", posture: { readOnly: true, sideEffectPosture: "audit_only" } });
  clipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  act(() => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard); else Reflect.deleteProperty(navigator, "clipboard");
});
async function mount() {
  await act(async () => root.render(<QueryClientProvider client={client}><SystemQuality /></QueryClientProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  await vi.waitFor(() => expect(container.textContent).toContain("At most 200 packs"));
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  expect(button, label).toBeDefined(); await act(async () => { button!.click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
}
const region = (label: string) => container.querySelector(`[aria-label="${label}"]`)!;

describe("native Quality owner evidence", () => {
  it("shows installation limitations once while retaining source-specific warnings", async () => {
    const data = snapshot();
    data.warnings = ["Shared limitation", "Shared limitation"];
    data.securityQualityGates.warnings = ["Shared limitation", "Local gate warning", "Local gate warning"];
    api.snapshot.mockResolvedValue(data); await mount();
    expect(container.textContent?.split("Shared limitation").length).toBe(2);
    expect(container.textContent?.split("Local gate warning").length).toBe(2);
  });
  it("uses the bounded installation-wide owner and keeps partial sources unavailable", async () => {
    const data = snapshot(); data.promptPacks = { state: "unknown", items: [pack] };
    api.snapshot.mockResolvedValue(data);
    await mount();
    expect(api.snapshot).toHaveBeenCalledWith({ packLimit: 200, evalLimit: 25 });
    expect(container.textContent).toContain("Installation-wide stored evidence");
    expect(region("Prompt packs").textContent).toContain("availability unknown");
    expect(region("Prompt packs").textContent).not.toContain("Owner pack");
    await click("Inspect Defensive gate");
    expect(region("Selected quality gate").textContent).toContain("Two scores are missing.");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("selects exact evaluations and does not substitute when the selected identity disappears", async () => {
    await mount(); await click("Evaluations"); await click("Inspect evaluation 2");
    expect(region("Selected evaluation").textContent).toContain("Only second evidence");
    expect(region("Selected evaluation").textContent).toContain("Not recorded");
    expect(region("Selected evaluation").textContent).not.toContain("Only first evidence");
    const data = snapshot(); data.evalProof.items = data.evalProof.items.slice(0, 1);
    await act(async () => { client.setQueryData(["quality", "eval-proof-runs", "snapshot", 200, 25], data); await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(region("Selected evaluation").textContent).toContain("no longer in the current evidence");
    await click("Inspect evaluation 1");
    const score = [...region("Selected evaluation").querySelectorAll("dt")].find((item) => item.textContent === "Operator quality score");
    expect(score?.nextElementSibling?.textContent).toBe("0");
  });
  it("selects design checks by owner identity even with duplicate labels", async () => {
    await mount(); await click("Design"); await click("Inspect check 2");
    expect(region("Selected design check").textContent).toContain("Evidence for design-b");
    expect(region("Selected design check").textContent).not.toContain("Evidence for design-a");
  });
  it("loads the exact selected prompt-pack report and withholds changed owner content", async () => {
    api.packReport.mockResolvedValue(packReport({ ...pack, contentSha256: "b".repeat(64) }, 999));
    await mount(); await click("Inspect Owner pack");
    await vi.waitFor(() => expect(region("Selected prompt pack").textContent).toContain("Stored report unavailable"));
    expect(api.packReport).toHaveBeenCalledWith(pack.packId);
    expect(region("Selected prompt pack").textContent).not.toContain("999");
    const link = region("Selected prompt pack").querySelector("a")!;
    expect(new URL(link.href).searchParams.get("view")).toBe("pack:pack-a");
  });
  it("does not keep prior snapshot success visible after refresh failure", async () => {
    await mount(); api.snapshot.mockRejectedValueOnce(new Error("Owner offline")); await click("Refresh");
    await vi.waitFor(() => expect(container.textContent).toContain("Quality proof unavailable"));
    expect(container.textContent).not.toContain("Defensive gate");
  });
  it("refreshes scores when the observed snapshot changes without a definition revision change", async () => {
    await mount(); await click("Inspect Owner pack");
    await vi.waitFor(() => expect(region("Selected prompt pack").textContent).toContain("50%"));
    const next = packReport(pack);
    next.summary.effectivePassRate = 0.75;
    next.summary.passCount = 3;
    api.packReport.mockResolvedValueOnce(next);
    api.snapshot.mockResolvedValueOnce({ ...snapshot(), generatedAt: "2026-09-30T14:01:00.000Z" });
    await click("Refresh");
    await vi.waitFor(() => expect(region("Selected prompt pack").textContent).toContain("75%"));
    expect(api.packReport).toHaveBeenCalledTimes(2);
    expect(region("Selected prompt pack").textContent).not.toContain("50%");
  });
  it("withholds an older report completion after a newer snapshot observation", async () => {
    const oldReport = deferred<PromptPackReportRecord>();
    api.packReport.mockReturnValueOnce(oldReport.promise);
    await mount(); await click("Inspect Owner pack");
    const next = packReport(pack); next.summary.effectivePassRate = 0.75;
    api.packReport.mockResolvedValueOnce(next);
    api.snapshot.mockResolvedValueOnce({ ...snapshot(), generatedAt: "2026-09-30T14:01:00.000Z" });
    await click("Refresh");
    await vi.waitFor(() => expect(region("Selected prompt pack").textContent).toContain("75%"));
    await act(async () => { oldReport.resolve(packReport(pack)); await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(region("Selected prompt pack").textContent).toContain("75%");
    expect(region("Selected prompt pack").textContent).not.toContain("50%");
  });
});

describe("Quality read-only exports", () => {
  it("copies exact owner payloads once and waits for clipboard settlement", async () => {
    const writing = deferred<void>(); clipboard.mockReturnValueOnce(writing.promise);
    await mount(); await click("Copy evaluation evidence");
    expect(api.evalExport).toHaveBeenCalledWith(50);
    expect(clipboard).toHaveBeenCalledWith("exact eval payload");
    expect(container.textContent).not.toContain("Evaluation evidence copied.");
    await click("Copying evaluation evidence…");
    expect(api.evalExport).toHaveBeenCalledOnce();
    await act(async () => writing.resolve());
    expect(container.textContent).toContain("Evaluation evidence copied.");
    await click("Copy quality transport evidence");
    expect(api.qualityExport).toHaveBeenCalledWith({ packLimit: 200, evalLimit: 25, format: "otel_json" });
    expect(clipboard).toHaveBeenLastCalledWith("exact quality payload");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not claim copy success when the clipboard rejects", async () => {
    clipboard.mockRejectedValueOnce(new Error("Permission denied"));
    await mount(); await click("Copy evaluation evidence");
    expect(container.textContent).toContain("Evidence was not copied.");
    expect(container.textContent).not.toContain("Evaluation evidence copied.");
  });
  it("withholds a delayed clipboard side effect after navigation unmounts the export control", async () => {
    const result = deferred<{ content: string; posture: { readOnly: true; sideEffectPosture: "audit_only" } }>();
    api.evalExport.mockReturnValueOnce(result.promise);
    await act(async () => root.render(<QualityExports />)); await click("Copy evaluation evidence");
    await act(async () => root.render(<p>Another view</p>));
    await act(async () => result.resolve({ content: "delayed", posture: { readOnly: true, sideEffectPosture: "audit_only" } }));
    expect(clipboard).not.toHaveBeenCalled();
  });
});
