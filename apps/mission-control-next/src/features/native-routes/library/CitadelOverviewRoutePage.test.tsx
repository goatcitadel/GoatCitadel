import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitadelOverviewRoutePage } from "./CitadelOverviewRoutePage";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  getCitadel: vi.fn(),
  getCitadelGatehouse: vi.fn(),
  isApiRequestError: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  getCitadel: apiMocks.getCitadel,
  getCitadelGatehouse: apiMocks.getCitadelGatehouse,
  isApiRequestError: apiMocks.isApiRequestError,
}));

function makeProps(navigate = vi.fn()): NativeRoutePagesProps {
  return {
    route: { area: "library", section: "citadel-overview", theme: "library" },
    activeWorkspaceId: "default",
    activeWorkspaceName: "Acme",
    pendingApprovals: 0,
    navigate,
    setActiveWorkspaceId: vi.fn(),
  };
}

function treeString(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

const CITADEL = {
  citadelId: "default",
  charter: {
    citadelId: "default",
    purpose: "Run the company",
    kind: "company",
    goals: ["Ship v1"],
    boundaries: ["No prod writes without approval"],
    successDefinition: ["Paying customers"],
    riskPosture: "balanced",
    modelPolicyDefault: "hybrid_guarded",
    createdAt: "t",
    updatedAt: "t",
  },
  chambers: [{ chamberId: "c1", citadelId: "default", name: "Finance", sensitivity: "restricted", sealed: true, createdAt: "t", updatedAt: "t" }],
};

const GATEHOUSE = {
  citadelId: "default",
  hasCharter: true,
  chamberCount: 1,
  sealedChamberCount: 1,
  sensitivityCounts: { public: 0, internal: 0, private: 0, sensitive: 0, restricted: 1, secret: 0 },
  riskPosture: "balanced",
  modelPolicyDefault: "hybrid_guarded",
  sharingDefault: "private",
  externalWritesDefault: "approval_required",
  wardCount: 2,
};

describe("CitadelOverviewRoutePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.isApiRequestError.mockImplementation(
      (error: unknown) => typeof error === "object" && error !== null && "status" in error,
    );
  });

  it("renders the Citadel header while loading", () => {
    apiMocks.getCitadel.mockReturnValue(new Promise(() => {}));
    apiMocks.getCitadelGatehouse.mockReturnValue(new Promise(() => {}));
    const markup = renderToStaticMarkup(<CitadelOverviewRoutePage {...makeProps()} />);
    expect(markup).toContain("Citadel");
  });

  it("shows the Charter, Chambers, and Gatehouse posture when staged", async () => {
    apiMocks.getCitadel.mockResolvedValue(CITADEL);
    apiMocks.getCitadelGatehouse.mockResolvedValue(GATEHOUSE);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelOverviewRoutePage {...makeProps()} />);
    });
    const tree = treeString(renderer!);
    expect(tree).toContain("Run the company");
    expect(tree).toContain("Finance");
    expect(tree).toContain("sealed");
    expect(tree).toContain("approval_required");
  });

  it("routes to the Mason when the workspace is not a Citadel yet (404)", async () => {
    apiMocks.getCitadel.mockRejectedValue({ status: 404 });
    apiMocks.getCitadelGatehouse.mockRejectedValue({ status: 404 });
    const navigate = vi.fn();
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelOverviewRoutePage {...makeProps(navigate)} />);
    });
    expect(treeString(renderer!)).toContain("isn't a Citadel yet");

    const [openMason] = renderer!.root.findAll((node) => node.type === "button");
    if (!openMason) {
      throw new Error("Expected an 'Open the Mason' button");
    }
    await act(async () => {
      openMason.props.onClick();
    });
    expect(navigate).toHaveBeenCalledWith({ area: "library", section: "citadel" });
  });
});
