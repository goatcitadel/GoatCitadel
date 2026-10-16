import type { ComponentProps } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelComparisonRun, ModelComparisonStatus } from "@goatcitadel/contracts";
import { LibraryPromptPacksSection } from "./LibraryPromptPacksSection";

const apiMocks = vi.hoisted(() => ({
  listModelComparisons: vi.fn(),
  judgeModelComparison: vi.fn(),
  runModelComparison: vi.fn(),
  cancelModelComparison: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/model-comparisons", () => apiMocks);

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function comparison(status: ModelComparisonStatus): ModelComparisonRun {
  return {
    comparisonId: "comparison-1",
    packId: "launch-pack",
    status,
    title: "Launch pack comparison",
    candidates: [
      { candidateId: "candidate-a", providerId: "openai", model: "gpt-5", blindLabel: "A" },
      { candidateId: "candidate-b", providerId: "anthropic", model: "claude-5", blindLabel: "B" },
    ],
    testIds: ["test-1"],
    results: [],
    judgments: [],
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T11:00:00.000Z",
  } as ModelComparisonRun;
}

function collectText(node: ReactTestInstance | string): string {
  if (typeof node === "string") {
    return node;
  }
  return node.children.map((child) => collectText(child as ReactTestInstance | string)).join(" ");
}

function findButtons(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll((node) => node.type === "button" && collectText(node).includes(label));
}

async function renderDetail(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <LibraryPromptPacksSection
        {...({
          route: { area: "library", section: "prompt-packs", theme: "ops" },
          navigate: vi.fn(),
        } as unknown as ComponentProps<typeof LibraryPromptPacksSection>)}
      />,
    );
  });
  await act(async () => {
    findButtons(renderer.root, "Launch pack comparison")[0]!.props.onClick();
  });
  return renderer;
}

describe("LibraryPromptPacksSection run controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["queued", "failed", "cancelled"] as const)("starts a %s comparison and reloads", async (status) => {
    apiMocks.listModelComparisons
      .mockResolvedValueOnce({ items: [comparison(status)] })
      .mockResolvedValue({ items: [comparison("running")] });
    apiMocks.runModelComparison.mockResolvedValue(comparison("running"));
    const renderer = await renderDetail();

    expect(findButtons(renderer.root, "Cancel run")).toHaveLength(0);
    await act(async () => {
      await findButtons(renderer.root, "Run comparison")[0]!.props.onClick();
    });

    expect(apiMocks.runModelComparison).toHaveBeenCalledWith("comparison-1");
    expect(apiMocks.listModelComparisons).toHaveBeenCalledTimes(2);
    expect(collectText(renderer.root)).toContain("Comparison status: Running");
    expect(collectText(renderer.root)).not.toContain("Started the comparison run.");
    expect(findButtons(renderer.root, "Cancel run")).toHaveLength(1);
    expect(findButtons(renderer.root, "Run comparison")).toHaveLength(0);
  });

  it("cancels a running comparison and shows a readable status", async () => {
    apiMocks.listModelComparisons
      .mockResolvedValueOnce({ items: [comparison("running")] })
      .mockResolvedValue({ items: [comparison("cancelled")] });
    apiMocks.cancelModelComparison.mockResolvedValue(comparison("cancelled"));
    const renderer = await renderDetail();

    expect(collectText(renderer.root)).toContain("Running");
    expect(collectText(renderer.root)).not.toContain("running");
    await act(async () => {
      await findButtons(renderer.root, "Cancel run")[0]!.props.onClick();
    });

    expect(apiMocks.cancelModelComparison).toHaveBeenCalledWith("comparison-1");
    expect(collectText(renderer.root)).toContain("Comparison status: Cancelled");
    expect(collectText(renderer.root)).not.toContain("Cancelled the comparison run.");
    expect(findButtons(renderer.root, "Run comparison")).toHaveLength(1);
  });

  it("reports the status the gateway returned when it differs from the requested action", async () => {
    apiMocks.listModelComparisons
      .mockResolvedValueOnce({ items: [comparison("running")] })
      .mockResolvedValue({ items: [comparison("completed")] });
    apiMocks.cancelModelComparison.mockResolvedValue(comparison("completed"));
    const renderer = await renderDetail();

    await act(async () => {
      await findButtons(renderer.root, "Cancel run")[0]!.props.onClick();
    });

    expect(apiMocks.cancelModelComparison).toHaveBeenCalledWith("comparison-1");
    expect(collectText(renderer.root)).toContain("Comparison status: Done");
    expect(collectText(renderer.root)).not.toContain("Comparison status: Cancelled");
    expect(collectText(renderer.root)).not.toContain("Cancelled the comparison run.");
  });

  it("offers no run control for a completed comparison", async () => {
    apiMocks.listModelComparisons.mockResolvedValue({ items: [comparison("completed")] });
    const renderer = await renderDetail();

    expect(findButtons(renderer.root, "Run comparison")).toHaveLength(0);
    expect(findButtons(renderer.root, "Cancel run")).toHaveLength(0);
  });

  it("shows the gateway error when a run cannot start", async () => {
    apiMocks.listModelComparisons.mockResolvedValue({ items: [comparison("queued")] });
    apiMocks.runModelComparison.mockRejectedValue(new Error("Comparison is already running."));
    const renderer = await renderDetail();

    await act(async () => {
      await findButtons(renderer.root, "Run comparison")[0]!.props.onClick();
    });

    expect(collectText(renderer.root)).toContain("Comparison is already running.");
    expect(apiMocks.listModelComparisons).toHaveBeenCalledTimes(1);
  });
});
