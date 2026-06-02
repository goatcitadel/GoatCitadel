// @vitest-environment happy-dom
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRoutePage } from "./MemoryRoutePage";

const memorySnapshot = vi.hoisted(() => ({
  loading: false,
  error: null,
  notice: null,
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
  data: {
    files: [],
    qmdStats: null,
    memoryItems: [
      {
        itemId: "mem-1",
        namespace: "knowledge/routing",
        title: "Haiku fallback heuristic",
        content: "Reshard-idle window before reclassifying.",
        pinned: true,
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
        pinned: true,
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
      {
        itemId: "mem-4",
        namespace: "routing/audit",
        title: "routing-audit-may.json",
        content: "May rolling routing audit.",
        pinned: false,
        status: "active",
        lifecycleState: "active",
        updatedAt: "2026-05-22T00:00:00.000Z",
        metadata: {},
      },
      {
        itemId: "mem-5",
        namespace: "scratch/note",
        title: "Quick scratch",
        content: "Quick note.",
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

function findTablist(root: ReactTestInstance): ReactTestInstance {
  return root.findAll(
    (node) => node.props?.role === "tablist" && node.props["aria-label"] === "Memory namespace filter",
  )[0]!;
}

function findPills(root: ReactTestInstance): ReactTestInstance[] {
  return findTablist(root).findAllByType("button");
}

function pillLabel(pill: ReactTestInstance): string {
  return collectText(pill).trim();
}

describe("MemoryRoutePage namespace filter pills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memorySnapshot.selectedItemId = null;
    memorySnapshot.selectedItem = null;
    evidenceApiMocks.fetchEvidenceEnvelopes.mockResolvedValue({ items: [] });
  });

  it("renders the tablist with derived namespace groups and an all pill", () => {
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
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Memory namespace filter"');
    // First-segment groups derived from "knowledge/routing", "knowledge/policy",
    // "knowledge/files", "routing/audit", "scratch/note" => knowledge (3), routing (1), scratch (1).
    expect(markup).toContain(">all<");
    expect(markup).toContain(">knowledge<");
    expect(markup).toContain(">routing<");
    expect(markup).toContain(">scratch<");
  });

  it("counts items by first namespace segment and shows the total on the all pill", async () => {
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

    const pills = findPills(renderer!.root);
    const labels = pills.map(pillLabel);
    // Order: all (5), knowledge (3 — highest), routing (1), scratch (1)
    expect(labels[0]).toContain("all");
    expect(labels[0]).toContain("5");
    expect(labels[1]).toContain("knowledge");
    expect(labels[1]).toContain("3");
  });

  it("filters memory items when a namespace pill is activated", async () => {
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

    // Initially: all 5 items visible
    let bodyText = collectText(renderer!.root);
    expect(bodyText).toContain("Haiku fallback heuristic");
    expect(bodyText).toContain("Approval verdict policy v3");
    expect(bodyText).toContain("retention-pulse-w19.csv");
    expect(bodyText).toContain("routing-audit-may.json");
    expect(bodyText).toContain("Quick scratch");

    // Click the "knowledge" pill
    const pills = findPills(renderer!.root);
    const knowledgePill = pills.find((pill) => pillLabel(pill).startsWith("knowledge"))!;
    await act(async () => {
      knowledgePill.props.onClick();
    });

    bodyText = collectText(renderer!.root);
    expect(bodyText).toContain("Haiku fallback heuristic");
    expect(bodyText).toContain("Approval verdict policy v3");
    expect(bodyText).toContain("retention-pulse-w19.csv");
    // The non-knowledge items should disappear
    expect(bodyText).not.toContain("routing-audit-may.json");
    expect(bodyText).not.toContain("Quick scratch");
  });

  it("returns to all items when the all pill is selected", async () => {
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

    const pillsBefore = findPills(renderer!.root);
    const scratchPill = pillsBefore.find((pill) => pillLabel(pill).startsWith("scratch"))!;
    await act(async () => {
      scratchPill.props.onClick();
    });
    let bodyText = collectText(renderer!.root);
    expect(bodyText).not.toContain("Haiku fallback heuristic");
    expect(bodyText).toContain("Quick scratch");

    const pillsAfter = findPills(renderer!.root);
    const allPill = pillsAfter.find((pill) => pillLabel(pill).startsWith("all"))!;
    await act(async () => {
      allPill.props.onClick();
    });
    bodyText = collectText(renderer!.root);
    expect(bodyText).toContain("Haiku fallback heuristic");
    expect(bodyText).toContain("routing-audit-may.json");
    expect(bodyText).toContain("Quick scratch");
  });

  it("composes the namespace filter with the search query", async () => {
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

    const pills = findPills(renderer!.root);
    const knowledgePill = pills.find((pill) => pillLabel(pill).startsWith("knowledge"))!;
    await act(async () => {
      knowledgePill.props.onClick();
    });

    const inputs = renderer!.root.findAllByType("input");
    const search = inputs.find((node) => node.props.placeholder === "Namespace, title, or content")!;
    await act(async () => {
      search.props.onChange({ target: { value: "approval" } });
    });

    const bodyText = collectText(renderer!.root);
    expect(bodyText).toContain("Approval verdict policy v3");
    expect(bodyText).not.toContain("Haiku fallback heuristic");
    expect(bodyText).not.toContain("retention-pulse-w19.csv");
  });

  it("does not render detail for a selected item hidden by the active namespace filter", async () => {
    const scratchItem = memorySnapshot.data.memoryItems.find((item) => item.itemId === "mem-5")!;
    memorySnapshot.selectedItemId = scratchItem.itemId;
    memorySnapshot.selectedItem = scratchItem;
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

    expect(collectText(renderer!.root)).toContain("Quick scratch");
    const knowledgePill = findPills(renderer!.root).find((pill) => pillLabel(pill).startsWith("knowledge"))!;
    await act(async () => {
      knowledgePill.props.onClick();
    });

    const bodyText = collectText(renderer!.root);
    expect(bodyText).not.toContain("Quick scratch");
    expect(bodyText).toContain("Select a memory item to inspect lifecycle state");
  });
});
