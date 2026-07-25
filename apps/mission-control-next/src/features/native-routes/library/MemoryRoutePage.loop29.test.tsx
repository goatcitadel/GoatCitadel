import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asRecord, MemoryRoutePage, readMemoryWriteDecision, readMetadataString } from "./MemoryRoutePage";

const memorySnapshot = vi.hoisted(() => ({
  // HX-402 P1: approval-first mutation surface state.
  pendingMutationApprovals: [] as Array<Record<string, unknown>>,
  dismissPendingMutationApproval: vi.fn(),
  loading: false,
  error: null as string | null,
  notice: null as { tone: string; message: string } | null,
  busyKey: null,
  reload: vi.fn(),
  selectedItemId: null as string | null,
  setSelectedItemId: vi.fn(),
  selectedRunId: null as string | null,
  setSelectedRunId: vi.fn(),
  selectedItem: null as unknown,
  selectedRun: null as unknown,
  policyDraft: null as unknown,
  setPolicyDraft: vi.fn(),
  policyDirty: false,
  setPolicyDirty: vi.fn(),
  saveItemPatch: vi.fn(),
  forgetSelectedItem: vi.fn(),
  scanMemoryQuality: vi.fn(),
  patchQualityIssue: vi.fn(),
  runMaintenance: vi.fn(),
  savePolicy: vi.fn(),
  resolveRecommendation: vi.fn(),
  reviewDecision: vi.fn(),
  data: null as unknown,
}));

const evidenceApiMocks = vi.hoisted(() => ({
  fetchEvidenceEnvelopes: vi.fn(),
  runMemoryRetrievalBenchmark: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchEvidenceEnvelopes: evidenceApiMocks.fetchEvidenceEnvelopes,
  runMemoryRetrievalBenchmark: evidenceApiMocks.runMemoryRetrievalBenchmark,
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useMemoryOperatorSnapshot", () => ({
  useMemoryOperatorSnapshot: () => memorySnapshot,
}));

describe("MemoryRoutePage loop 29 branch tails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memorySnapshot.loading = false;
    memorySnapshot.error = null;
    memorySnapshot.notice = null;
    memorySnapshot.data = null;
    memorySnapshot.selectedItem = null;
    memorySnapshot.selectedRun = null;
    evidenceApiMocks.fetchEvidenceEnvelopes.mockResolvedValue({ items: [] });
  });

  it("renders unknown memory truth when the snapshot has not loaded data yet", () => {
    const markup = renderToStaticMarkup(
      <MemoryRoutePage
        route={{ area: "library", section: "memory", theme: "library" } as never}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={0}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    expect(markup).toContain("Memory item truth is unavailable until backend settings truth reloads.");
    expect(markup).toContain("Memory maintenance truth is unavailable until backend settings truth reloads.");
    expect(markup).toContain("No maintenance recommendations.");
    expect(markup).toContain("No memory file subspaces discovered.");
  });

  it("keeps memory metadata and write-gate decision readers defensive", () => {
    expect(asRecord({ source: "operator" })).toEqual({ source: "operator" });
    expect(asRecord(false)).toBeUndefined();
    expect(asRecord(["source"])).toBeUndefined();
    expect(readMetadataString({ source: "  durable-run  " }, "source")).toBe("durable-run");
    expect(readMetadataString({ source: "" }, "source")).toBeUndefined();
    expect(readMetadataString({ source: 123 }, "source")).toBeUndefined();
    expect(readMetadataString(null, "source")).toBeUndefined();

    expect(
      readMemoryWriteDecision({
        metadata: { decision: { decision: "blocked" } },
        signatureStatus: "signed_hmac",
      } as never),
    ).toBe("blocked");
    expect(
      readMemoryWriteDecision({ metadata: { decision: { decision: false } }, signatureStatus: "signed_hmac" } as never),
    ).toBe("signed_hmac");
    expect(readMemoryWriteDecision({ metadata: { decision: null }, signatureStatus: "unsigned_local" } as never)).toBe(
      "unsigned_local",
    );
    expect(readMemoryWriteDecision({ metadata: "bad", signatureStatus: "unsigned_local" } as never)).toBe(
      "unsigned_local",
    );
  });
});
