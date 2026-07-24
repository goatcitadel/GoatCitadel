import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { FilterPillGroup } from "../primitives";
import { MemoryRoutePage } from "./MemoryRoutePage";

const memorySnapshot = vi.hoisted(() => ({
  // HX-402 P1: approval-first mutation surface state.
  pendingMutationApprovals: [] as Array<Record<string, unknown>>,
  dismissPendingMutationApproval: vi.fn(),
  loading: false,
  error: null,
  notice: null,
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
      {
        itemId: "mem-3",
        namespace: "knowledge/files",
        title: "retention-pulse-w19.csv",
        content: "Uploaded by spurnout.",
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

// Tests below swap `memorySnapshot.data.memoryItems` for filter/limit scenarios;
// beforeEach restores this baseline so scenarios stay isolated.
const baseMemoryItems = memorySnapshot.data.memoryItems;

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

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      return collectText(child);
    })
    .join(" ");
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

function findBatchToolbar(root: ReactTestInstance): ReactTestInstance | undefined {
  return root.findAll(
    (node) => node.props?.role === "toolbar" && node.props["aria-label"] === "Memory batch actions",
  )[0];
}

function findSearchInput(root: ReactTestInstance): ReactTestInstance {
  const input = root.findAll(
    (node) => node.type === "input" && node.props["aria-label"] === "Search memories by namespace, title, or content",
  )[0];
  if (!input) {
    throw new Error("Unable to find memory search input");
  }
  return input;
}

function findNamespacePills(root: ReactTestInstance): ReactTestInstance {
  const pills = root.findAll(
    (node) => node.type === FilterPillGroup && node.props.label === "Memory namespace filter",
  )[0];
  if (!pills) {
    throw new Error("Unable to find memory namespace filter pills");
  }
  return pills;
}

function findAllCheckboxes(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((node) => node.type === "input" && node.props.type === "checkbox");
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

describe("MemoryRoutePage batch selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memorySnapshot.selectedItemId = null;
    memorySnapshot.selectedItem = null;
    memorySnapshot.busyKey = null;
    memorySnapshot.data.memoryAdminState = "enabled";
    memorySnapshot.data.memoryItems = baseMemoryItems;
    evidenceApiMocks.fetchEvidenceEnvelopes.mockResolvedValue({ items: [] });
  });

  it("selects items and routes the batch forget through the approval confirm dialog", async () => {
    memorySnapshot.batchForgetItems.mockResolvedValue({
      pendingApproval: { approvalId: "approval-batch-forget", status: "pending" },
    });
    const renderer = await renderPage();

    await act(async () => {
      findCheckbox(renderer.root, "Haiku fallback heuristic").props.onChange();
      findCheckbox(renderer.root, "Approval verdict policy v3").props.onChange();
    });

    expect(collectText(renderer.root)).toContain("2 selected");

    await act(async () => {
      findButton(renderer.root, "Forget selected").props.onClick();
    });
    const modal = renderer.root.findByType(ConfirmModal);
    expect(modal.props.open).toBe(true);
    // HX-402 P1: the confirm step is honest about the approval-first flow —
    // nothing is forgotten yet, and once approved the batch applies atomically.
    expect(modal.props.message).toContain("Nothing is forgotten yet");
    expect(modal.props.message).toContain("applies atomically — either all are forgotten or none are");
    expect(modal.props.confirmLabel).toBe("Request approval");
    expect(memorySnapshot.batchForgetItems).not.toHaveBeenCalled();

    await act(async () => {
      await modal.props.onConfirm();
    });

    expect(memorySnapshot.batchForgetItems).toHaveBeenCalledWith(["mem-1", "mem-2"]);
    expect(findBatchToolbar(renderer.root)).toBeUndefined();
  });

  it("keeps the selection when the batch fails", async () => {
    memorySnapshot.batchForgetItems.mockResolvedValue(undefined);
    const renderer = await renderPage();

    await act(async () => {
      findCheckbox(renderer.root, "Haiku fallback heuristic").props.onChange();
    });

    await act(async () => {
      findButton(renderer.root, "Forget selected").props.onClick();
    });
    await act(async () => {
      await renderer.root.findByType(ConfirmModal).props.onConfirm();
    });

    expect(memorySnapshot.batchForgetItems).toHaveBeenCalledWith(["mem-1"]);
    const toolbar = findBatchToolbar(renderer.root);
    expect(toolbar).toBeDefined();
    expect(collectText(toolbar!)).toContain("1 selected");
  });

  it("clears selection without calling the API", async () => {
    const renderer = await renderPage();

    await act(async () => {
      findCheckbox(renderer.root, "Haiku fallback heuristic").props.onChange();
    });
    expect(findBatchToolbar(renderer.root)).toBeDefined();

    await act(async () => {
      findButton(renderer.root, "Clear selection").props.onClick();
    });

    expect(findBatchToolbar(renderer.root)).toBeUndefined();
    expect(memorySnapshot.batchForgetItems).not.toHaveBeenCalled();
    expect(memorySnapshot.batchSetItemsPinned).not.toHaveBeenCalled();
  });

  it("disables batch controls when memory admin is locked", async () => {
    memorySnapshot.data.memoryAdminState = "disabled";
    const renderer = await renderPage();

    const checkbox = findCheckbox(renderer.root, "Haiku fallback heuristic");
    expect(checkbox.props.disabled).toBe(true);

    await act(async () => {
      checkbox.props.onChange();
    });

    expect(findButton(renderer.root, "Forget selected").props.disabled).toBe(true);
    expect(findButton(renderer.root, "Pin selected").props.disabled).toBe(true);
    expect(findButton(renderer.root, "Unpin selected").props.disabled).toBe(true);
  });

  it("prunes batch actions to the items visible under the current search", async () => {
    memorySnapshot.batchForgetItems.mockResolvedValue({
      pendingApproval: { approvalId: "approval-batch-prune", status: "pending" },
    });
    const renderer = await renderPage();

    await act(async () => {
      findCheckbox(renderer.root, "Haiku fallback heuristic").props.onChange();
      findCheckbox(renderer.root, "Approval verdict policy v3").props.onChange();
    });
    expect(collectText(findBatchToolbar(renderer.root)!)).toContain("2 selected");

    await act(async () => {
      findSearchInput(renderer.root).props.onChange({ target: { value: "approval" } });
    });

    // mem-1 is checked but filtered out of view — the destructive batch must
    // only count and touch the rows the operator can still see.
    const toolbar = findBatchToolbar(renderer.root);
    expect(toolbar).toBeDefined();
    expect(collectText(toolbar!)).toContain("1 selected");

    await act(async () => {
      findButton(renderer.root, "Forget selected").props.onClick();
    });
    await act(async () => {
      await renderer.root.findByType(ConfirmModal).props.onConfirm();
    });

    expect(memorySnapshot.batchForgetItems).toHaveBeenCalledWith(["mem-2"]);
  });

  it("hides the batch toolbar when the namespace filter excludes every selected item", async () => {
    memorySnapshot.data.memoryItems = baseMemoryItems.map((item) =>
      item.itemId === "mem-3" ? { ...item, namespace: "scratch/files" } : item,
    );
    const renderer = await renderPage();

    await act(async () => {
      findCheckbox(renderer.root, "Haiku fallback heuristic").props.onChange();
    });
    expect(findBatchToolbar(renderer.root)).toBeDefined();

    await act(async () => {
      findNamespacePills(renderer.root).props.onChange("scratch");
    });
    expect(findBatchToolbar(renderer.root)).toBeUndefined();

    // Returning to "all" restores the surviving selection — pruning is a view
    // concern; the checked set itself is only cleared by a successful batch.
    const allValue = findNamespacePills(renderer.root).props.options[0].value;
    await act(async () => {
      findNamespacePills(renderer.root).props.onChange(allValue);
    });
    const toolbar = findBatchToolbar(renderer.root);
    expect(toolbar).toBeDefined();
    expect(collectText(toolbar!)).toContain("1 selected");
    expect(memorySnapshot.batchForgetItems).not.toHaveBeenCalled();
    expect(memorySnapshot.batchSetItemsPinned).not.toHaveBeenCalled();
  });

  it("disables destructive batch actions above the 100-item batch limit", async () => {
    memorySnapshot.data.memoryItems = Array.from({ length: 101 }, (_, index) => ({
      itemId: `bulk-${index}`,
      namespace: "knowledge/bulk",
      title: `Bulk item ${index}`,
      content: "Bulk content.",
      pinned: false,
      status: "active",
      lifecycleState: "active",
      updatedAt: "2026-05-22T00:00:00.000Z",
      metadata: {},
    }));
    const renderer = await renderPage();

    await act(async () => {
      for (const checkbox of findAllCheckboxes(renderer.root)) {
        checkbox.props.onChange();
      }
    });

    const toolbar = findBatchToolbar(renderer.root);
    expect(toolbar).toBeDefined();
    expect(collectText(toolbar!)).toContain("101 selected");
    expect(collectText(toolbar!)).toContain("limited to 100 items");
    expect(findButton(renderer.root, "Forget selected").props.disabled).toBe(true);
    expect(findButton(renderer.root, "Pin selected").props.disabled).toBe(true);
    expect(findButton(renderer.root, "Unpin selected").props.disabled).toBe(true);
    expect(findButton(renderer.root, "Clear selection").props.disabled).toBe(false);

    // The limit is inclusive: dropping back to exactly 100 re-enables the verbs.
    await act(async () => {
      findAllCheckboxes(renderer.root)[0]!.props.onChange();
    });
    const toolbarAfter = findBatchToolbar(renderer.root);
    expect(collectText(toolbarAfter!)).toContain("100 selected");
    expect(collectText(toolbarAfter!)).not.toContain("limited to 100 items");
    expect(findButton(renderer.root, "Forget selected").props.disabled).toBe(false);
  });

  it("pins selected items", async () => {
    memorySnapshot.batchSetItemsPinned.mockResolvedValue({ appliedCount: 2 });
    const renderer = await renderPage();

    await act(async () => {
      findCheckbox(renderer.root, "Haiku fallback heuristic").props.onChange();
      findCheckbox(renderer.root, "Approval verdict policy v3").props.onChange();
    });

    await act(async () => {
      findButton(renderer.root, "Pin selected").props.onClick();
    });

    expect(memorySnapshot.batchSetItemsPinned).toHaveBeenCalledWith(["mem-1", "mem-2"], true);
    expect(findBatchToolbar(renderer.root)).toBeUndefined();
  });
});
