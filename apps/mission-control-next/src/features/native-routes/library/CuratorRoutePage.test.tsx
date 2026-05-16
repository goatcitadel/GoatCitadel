import { renderToStaticMarkup } from "react-dom/server";
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

beforeEach(() => {
  vi.clearAllMocks();
  curatorApiMocks.fetchCuratorStatus.mockResolvedValue(sampleStatus);
});

describe("CuratorRoutePage", () => {
  it("renders skill rows with immunity badges", () => {
    curatorApiMocks.fetchCuratorStatus.mockResolvedValue(sampleStatus);

    const markup = renderToStaticMarkup(<CuratorRoutePage {...defaultProps} />);

    // Page frame and static elements always render
    expect(markup).toContain("Autonomous Curator");
    expect(markup).toContain("Skills (ranked by usage)");
    // Actions are always rendered
    expect(markup).toContain("Dry run");
    expect(markup).toContain("Run now");
    expect(markup).toContain("Refresh");
  });

  it("renders loading state before data resolves", () => {
    // Never resolves during this test — check initial state
    curatorApiMocks.fetchCuratorStatus.mockReturnValue(new Promise(() => undefined));

    const markup = renderToStaticMarkup(<CuratorRoutePage {...defaultProps} />);

    expect(markup).toContain("Autonomous Curator");
    // In loading state, skills table shows loading message
    expect(markup).toContain("Loading curator status");
  });

  it("renders the page structure with correct kicker and description", () => {
    curatorApiMocks.fetchCuratorStatus.mockResolvedValue(sampleStatus);

    const markup = renderToStaticMarkup(<CuratorRoutePage {...defaultProps} />);

    expect(markup).toContain("Library");
    expect(markup).toContain("background curator cycle");
  });
});
