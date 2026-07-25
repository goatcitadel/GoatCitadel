import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { MemoryRoutePage } from "./MemoryRoutePage";

/**
 * HX-402 P1: the Memory page must reflect pending-approval state HONESTLY —
 * a mutation verb only requests one canonical `memory.lifecycle` approval, so
 * the page must say nothing changed yet, name the approval, and route the
 * batch toolbar through the approval flow. Landmine guard: values are never
 * imported from the vi.mock'd hook module (memory_batch_ui_review_fixes).
 */

type PendingApprovalFixture = {
  approvalId: string;
  status: string;
  kind: "memory.lifecycle";
  action: "item_updated" | "items_forgotten" | "batch_mutated";
  subjectKind: "memory_item" | "memory_item_batch";
  subjectId?: string;
  workspaceId: string;
  requestSha256: string;
  expectedStateSha256: string;
  createdAt: string;
  replayed: boolean;
  itemIds: string[];
};

const memorySnapshot = vi.hoisted(() => ({
  pendingMutationApprovals: [] as Array<Record<string, unknown>>,
  dismissPendingMutationApproval: vi.fn(),
  loading: false,
  error: null,
  notice: null as { tone: string; message: string } | null,
  busyKey: null as string | null,
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
  batchForgetItems: vi.fn(),
  batchSetItemsPinned: vi.fn(),
  data: {
    files: [],
    qmdStats: null,
    memoryRetrievalStatus: null,
    memoryItems: [
      {
        itemId: "mem-1",
        namespace: "knowledge/routing",
        title: "Haiku fallback heuristic",
        content: "Reshard-idle window before reclassifying.",
        pinned: false,
        status: "active",
        lifecycleState: "active",
        updatedAt: "2026-05-22T00:00:00.000Z",
        metadata: {},
      },
      {
        itemId: "mem-2",
        namespace: "knowledge/policy",
        title: "Approval verdict policy v3",
        content: "Critical-risk scopes require a human verdict.",
        pinned: false,
        status: "active",
        lifecycleState: "active",
        updatedAt: "2026-05-22T00:00:00.000Z",
        metadata: {},
      },
    ],
    memoryEntities: [],
    memoryRelations: [],
    memoryDecisions: [],
    memoryFeedback: [],
    memoryQualityIssues: [],
    traceMemoryCandidates: [],
    memoryHistory: [],
    maintenanceStatus: null,
    maintenanceRuns: [],
    maintenanceRecommendations: [],
    selectedRunProvenance: null,
    selectedDurableRun: null,
    selectedDurableTimeline: [],
    memoryAdminEnabled: true,
    memoryAdminState: "enabled",
    maintenanceEnabled: false,
    maintenanceDurableReady: false,
    sectionErrors: {
      settings: null,
      files: null,
      qmdStats: null,
      memoryRetrievalStatus: null,
      memoryItems: null,
      memoryEntities: null,
      memoryRelations: null,
      memoryDecisions: null,
      memoryFeedback: null,
      memoryQualityIssues: null,
      traceMemoryCandidates: null,
      memoryHistory: null,
      maintenanceStatus: null,
      maintenanceRuns: null,
      maintenanceRecommendations: null,
      selectedRunProvenance: null,
      selectedDurableRun: null,
      selectedDurableTimeline: null,
    },
  },
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

function buildPendingApproval(overrides: Partial<PendingApprovalFixture> = {}): PendingApprovalFixture {
  return {
    approvalId: "aaaabbbb-cccc-dddd-eeee-ffff00001111",
    status: "pending",
    kind: "memory.lifecycle",
    action: "items_forgotten",
    subjectKind: "memory_item",
    subjectId: "mem-1",
    workspaceId: "default",
    requestSha256: "a".repeat(64),
    expectedStateSha256: "b".repeat(64),
    createdAt: "2026-07-22T00:00:00.000Z",
    replayed: false,
    itemIds: ["mem-1"],
    ...overrides,
  };
}

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      return collectText(child);
    })
    .join(" ")
    .replace(/\s+/gu, " ");
}

function findPendingBanners(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(
    (node) =>
      node.props?.role === "status" &&
      typeof node.props["aria-label"] === "string" &&
      node.props["aria-label"].startsWith("Pending memory mutation approval "),
  );
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!button) {
    throw new Error(`Unable to find button: ${label}`);
  }
  return button;
}

function findCheckbox(root: ReactTestInstance, title: string): ReactTestInstance {
  const checkbox = root.findAll(
    (node) => node.type === "input" && node.props["aria-label"] === `Select memory item ${title} for batch actions`,
  )[0];
  if (!checkbox) {
    throw new Error(`Unable to find checkbox for: ${title}`);
  }
  return checkbox;
}

async function renderPage(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(
      <MemoryRoutePage
        route={{ area: "library", section: "memory", theme: "library" } as never}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={0}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );
    await Promise.resolve();
  });
  return renderer!;
}

describe("MemoryRoutePage pending memory.lifecycle approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memorySnapshot.pendingMutationApprovals = [];
    memorySnapshot.notice = null;
    memorySnapshot.busyKey = null;
    memorySnapshot.data.memoryAdminState = "enabled";
    evidenceApiMocks.fetchEvidenceEnvelopes.mockResolvedValue({ items: [] });
  });

  it("renders no pending-approval banner when nothing is awaiting approval", async () => {
    const renderer = await renderPage();
    expect(findPendingBanners(renderer.root)).toHaveLength(0);
  });

  it("reflects each pending approval honestly: nothing changed yet, named approval, resolve guidance", async () => {
    memorySnapshot.pendingMutationApprovals = [
      buildPendingApproval({ approvalId: "aaaabbbb-cccc-dddd-eeee-ffff00001111", action: "item_updated" }),
      buildPendingApproval({
        approvalId: "22223333-4444-5555-6666-777788889999",
        action: "batch_mutated",
        subjectKind: "memory_item_batch",
        subjectId: undefined,
        itemIds: ["mem-1", "mem-2"],
        replayed: true,
      }),
    ];
    const renderer = await renderPage();

    const banners = findPendingBanners(renderer.root);
    expect(banners).toHaveLength(2);

    const patchBanner = collectText(banners[0]!);
    expect(patchBanner).toContain("A memory item update awaits approval");
    expect(patchBanner).toContain("Nothing has changed yet");
    expect(patchBanner).toContain("resolve it from the Approvals surface");
    // The page never renders an executed-mutation claim for a pending request.
    expect(patchBanner).not.toContain("updated.");
    expect(patchBanner).not.toContain("forgotten.");

    const batchBanner = collectText(banners[1]!);
    expect(batchBanner).toContain("An atomic batch mutation of 2 memory item(s) awaits approval");
    expect(batchBanner).toContain("(already requested)");
  });

  it("names forget approvals by their bound item count", async () => {
    memorySnapshot.pendingMutationApprovals = [
      buildPendingApproval({ action: "items_forgotten", itemIds: ["mem-1"] }),
      buildPendingApproval({
        approvalId: "9999aaaa-bbbb-cccc-dddd-eeeeffff0000",
        action: "items_forgotten",
        subjectKind: "memory_item_batch",
        subjectId: undefined,
        itemIds: ["mem-1", "mem-2"],
      }),
    ];
    const renderer = await renderPage();

    const banners = findPendingBanners(renderer.root).map((banner) => collectText(banner));
    expect(banners[0]).toContain("A memory forget awaits approval");
    expect(banners[1]).toContain("A forget of 2 memory items awaits approval");
  });

  it("dismisses one pending approval without touching the others", async () => {
    memorySnapshot.pendingMutationApprovals = [
      buildPendingApproval({ approvalId: "aaaabbbb-cccc-dddd-eeee-ffff00001111" }),
      buildPendingApproval({ approvalId: "22223333-4444-5555-6666-777788889999", action: "item_updated" }),
    ];
    const renderer = await renderPage();

    const banners = findPendingBanners(renderer.root);
    const dismiss = banners[0]!.findAll((node) => node.type === "button" && collectText(node).includes("Dismiss"))[0];
    expect(dismiss).toBeDefined();
    await act(async () => {
      dismiss!.props.onClick();
    });

    expect(memorySnapshot.dismissPendingMutationApproval).toHaveBeenCalledTimes(1);
    expect(memorySnapshot.dismissPendingMutationApproval).toHaveBeenCalledWith("aaaabbbb-cccc-dddd-eeee-ffff00001111");
  });

  it("routes the batch toolbar through the approval flow with honest confirm copy", async () => {
    memorySnapshot.batchForgetItems.mockResolvedValue({
      pendingApproval: buildPendingApproval({ action: "batch_mutated" }),
    });
    const renderer = await renderPage();

    await act(async () => {
      findCheckbox(renderer.root, "Haiku fallback heuristic").props.onChange();
    });
    await act(async () => {
      findButton(renderer.root, "Forget selected").props.onClick();
    });

    const modal = renderer.root.findByType(ConfirmModal);
    expect(modal.props.open).toBe(true);
    expect(modal.props.title).toContain("Request approval to forget");
    expect(modal.props.message).toContain("Nothing is forgotten yet");
    expect(modal.props.message).toContain("memory.lifecycle approval");
    expect(modal.props.confirmLabel).toBe("Request approval");
    expect(memorySnapshot.batchForgetItems).not.toHaveBeenCalled();

    await act(async () => {
      await modal.props.onConfirm();
    });
    expect(memorySnapshot.batchForgetItems).toHaveBeenCalledWith(["mem-1"]);
  });
});
