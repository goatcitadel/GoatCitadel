import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CuratorRoutePage } from "./CuratorRoutePage";

const curatorApiMocks = vi.hoisted(() => ({
  fetchCuratorStatus: vi.fn(),
  archiveCuratorSkill: vi.fn(),
  pruneCuratorSkill: vi.fn(),
  listCuratorArchived: vi.fn(),
  runCurator: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchCuratorStatus: curatorApiMocks.fetchCuratorStatus,
  archiveCuratorSkill: curatorApiMocks.archiveCuratorSkill,
  pruneCuratorSkill: curatorApiMocks.pruneCuratorSkill,
  listCuratorArchived: curatorApiMocks.listCuratorArchived,
  runCurator: curatorApiMocks.runCurator,
}));

const defaultProps = {
  route: { area: "library" as const, section: "curator" as const },
  activeWorkspaceId: "ws-default",
  activeWorkspaceName: "default",
  pendingApprovals: 0,
  navigate: vi.fn(),
  setActiveWorkspaceId: vi.fn(),
};

const sampleStatus = {
  generatedAt: "2026-05-15T12:00:00Z",
  cycleDays: 7,
  items: [
    {
      skillId: "skill-a",
      name: "alpha",
      source: "managed",
      pinned: false,
      bundled: false,
      immune: false,
      state: "enabled",
      usageCount: 90,
      ageDays: 0,
      score: {
        honesty: 0.8,
        blockerQuality: 0.8,
        retryQuality: 0.8,
        toolEvidence: 0.8,
        actionability: 0.8,
        mean: 0.8,
      },
      signals: [],
      recommendation: "keep",
      archived: false,
    },
    {
      skillId: "skill-b",
      name: "beta",
      source: "bundled",
      pinned: false,
      bundled: true,
      immune: true,
      immunityReason: "bundled",
      state: "enabled",
      usageCount: 0,
      ageDays: 0,
      score: {
        honesty: 0.4,
        blockerQuality: 0.4,
        retryQuality: 0.4,
        toolEvidence: 0.4,
        actionability: 0.4,
        mean: 0.4,
      },
      signals: ["never_used"],
      recommendation: "keep",
      archived: false,
    },
  ],
};

function readText(node: ReactTestInstance): string {
  return node
    .findAll(() => true)
    .reduce((text, child) => {
      for (const value of child.children) {
        if (typeof value === "string" || typeof value === "number") {
          text += String(value);
        }
      }
      return text;
    }, "");
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAllByType("button").find((candidate) => readText(candidate).includes(label));
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

async function renderPage(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<CuratorRoutePage {...defaultProps} />);
  });
  await act(async () => undefined);
  return renderer!;
}

beforeEach(() => {
  vi.clearAllMocks();
  curatorApiMocks.fetchCuratorStatus.mockResolvedValue(sampleStatus);
  curatorApiMocks.archiveCuratorSkill.mockResolvedValue({
    skillId: "skill-a",
    archived: true,
    archivedAt: "2026-05-15T12:00:00Z",
    state: "disabled",
  });
  curatorApiMocks.runCurator.mockResolvedValue({
    runId: "curator-run-test",
    scheduled: false,
    report: { proposalCount: 1, archivedCount: 0, immuneCount: 1 },
  });
});

describe("CuratorRoutePage", () => {
  it("passes loading and load errors through the native frame", async () => {
    let resolveStatus: (value: typeof sampleStatus) => void = () => undefined;
    curatorApiMocks.fetchCuratorStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CuratorRoutePage {...defaultProps} />);
    });
    expect(readText(renderer.root)).toContain("Loading current route data");
    await act(async () => {
      resolveStatus(sampleStatus);
    });

    curatorApiMocks.fetchCuratorStatus.mockRejectedValueOnce(new Error("curator route offline"));
    await act(async () => {
      renderer = create(<CuratorRoutePage {...defaultProps} />);
    });
    await act(async () => undefined);
    expect(readText(renderer.root)).toContain("curator route offline");
  });

  it("renders proposal-only actions and immunity badges", async () => {
    const renderer = await renderPage();
    const text = readText(renderer.root);

    expect(text).toContain("Skill Curator");
    expect(text).toContain("Skills (ranked by usage)");
    expect(text).toContain("Generate report");
    expect(text).toContain("Refresh");
    expect(text).toContain("Immune: bundled");
    expect(text).not.toContain("Dry run");
    expect(text).not.toContain("Run now");
  });

  it("generates curator reports with dryRun: true", async () => {
    const renderer = await renderPage();

    await act(async () => {
      await findButton(renderer.root, "Generate report").props.onClick();
    });

    expect(curatorApiMocks.runCurator).toHaveBeenCalledWith({ sync: true, dryRun: true });
    expect(readText(renderer.root)).toContain("1 archive proposals");
  });

  it("requires confirmation before archiving and sends confirm: true", async () => {
    const renderer = await renderPage();

    await act(async () => {
      findButton(renderer.root, "Archive").props.onClick();
    });
    const modal = renderer.root.findByType(ConfirmModal);
    expect(modal.props.open).toBe(true);

    await act(async () => {
      modal.props.onCancel();
    });
    expect(curatorApiMocks.archiveCuratorSkill).not.toHaveBeenCalled();
    expect(renderer.root.findByType(ConfirmModal).props.open).toBe(false);

    await act(async () => {
      findButton(renderer.root, "Archive").props.onClick();
    });
    await act(async () => {
      await renderer.root.findByType(ConfirmModal).props.onConfirm();
    });

    expect(curatorApiMocks.archiveCuratorSkill).toHaveBeenCalledWith({
      skillId: "skill-a",
      reason: "manual archive from Mission Control",
      confirm: true,
    });
  });
});
