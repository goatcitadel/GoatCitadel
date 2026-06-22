import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitadelOverviewRoutePage } from "./CitadelOverviewRoutePage";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  createCitadelFromTemplate: vi.fn(),
  getCitadel: vi.fn(),
  getCitadelGatehouse: vi.fn(),
  isApiRequestError: vi.fn(),
  listCitadels: vi.fn(),
  listCitadelTemplates: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  createCitadelFromTemplate: apiMocks.createCitadelFromTemplate,
  getCitadel: apiMocks.getCitadel,
  getCitadelGatehouse: apiMocks.getCitadelGatehouse,
  isApiRequestError: apiMocks.isApiRequestError,
  listCitadels: apiMocks.listCitadels,
  listCitadelTemplates: apiMocks.listCitadelTemplates,
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

function buttonContaining(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root.findAllByType("button").find((node) => readNodeText(node).includes(label));
  if (!button) {
    throw new Error(`Expected a '${label}' button`);
  }
  return button;
}

function readNodeText(node: { children?: unknown[] } | string | number | null | undefined): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node || !Array.isArray(node.children)) {
    return "";
  }
  return node.children.map((child) => readNodeText(child as never)).join("");
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
  chambers: [
    {
      chamberId: "c1",
      citadelId: "default",
      name: "Finance",
      sensitivity: "restricted",
      sealed: true,
      createdAt: "t",
      updatedAt: "t",
    },
  ],
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

const PERSONAL_CITADEL = {
  ...CITADEL,
  charter: {
    ...CITADEL.charter,
    purpose: "Run personal life",
    kind: "personal",
  },
};

const TEMPLATES = [
  {
    id: "personal-chief-of-staff",
    name: "Personal Chief of Staff",
    description: "A private Citadel for life admin.",
    kind: "personal",
    purpose: "Help with personal routines.",
    goals: ["Plan the week"],
    boundaries: ["Draft messages only"],
    successDefinition: ["A useful daily brief"],
    chambers: [{ name: "General" }],
  },
  {
    id: "company-co-founder",
    name: "Company Co-Founder",
    description: "A Citadel for operating the company.",
    kind: "company",
    purpose: "Help run the business.",
    goals: ["Maintain an operating picture"],
    boundaries: ["Approve production writes"],
    successDefinition: ["A useful weekly review"],
    chambers: [{ name: "General" }],
  },
];

describe("CitadelOverviewRoutePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.isApiRequestError.mockImplementation(
      (error: unknown) => typeof error === "object" && error !== null && "status" in error,
    );
    apiMocks.listCitadelTemplates.mockResolvedValue(TEMPLATES);
    apiMocks.listCitadels.mockResolvedValue({
      items: [{ citadelId: "default", name: "Acme", slug: "default", kind: "company", hasCharter: true }],
    });
    apiMocks.createCitadelFromTemplate.mockResolvedValue(PERSONAL_CITADEL);
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

  it("shows the staged setup state without fetching detail when the active Citadel has no Charter", async () => {
    apiMocks.listCitadels.mockResolvedValueOnce({
      items: [{ citadelId: "default", name: "Acme", slug: "default", kind: "company", hasCharter: false }],
    });
    apiMocks.getCitadel.mockRejectedValue(new Error("detail should not load"));
    apiMocks.getCitadelGatehouse.mockRejectedValue(new Error("gatehouse should not load"));
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelOverviewRoutePage {...makeProps()} />);
    });
    const tree = treeString(renderer!);
    expect(apiMocks.getCitadel).not.toHaveBeenCalled();
    expect(apiMocks.getCitadelGatehouse).not.toHaveBeenCalled();
    expect(tree).toContain("needs a Charter");
  });

  it("routes to the Mason when the workspace is not a Citadel yet (404)", async () => {
    apiMocks.getCitadel.mockRejectedValue({ status: 404 });
    apiMocks.getCitadelGatehouse.mockRejectedValue({ status: 404 });
    const navigate = vi.fn();
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelOverviewRoutePage {...makeProps(navigate)} />);
    });
    expect(treeString(renderer!)).toContain("needs a Charter");
    expect(treeString(renderer!)).toContain("Personal Chief of Staff");
    expect(treeString(renderer!)).toContain("Company Co-Founder");

    const openMason = buttonContaining(renderer!, "Open the Mason");
    await act(async () => {
      openMason.props.onClick();
    });
    expect(navigate).toHaveBeenCalledWith({ area: "library", section: "citadel" });
  });

  it("creates the active Citadel from the Personal default template", async () => {
    apiMocks.getCitadel.mockRejectedValue({ status: 404 });
    apiMocks.getCitadelGatehouse.mockRejectedValueOnce({ status: 404 }).mockResolvedValueOnce(GATEHOUSE);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelOverviewRoutePage {...makeProps()} />);
    });

    await act(async () => {
      buttonContaining(renderer!, "Use template").props.onClick();
    });

    expect(apiMocks.createCitadelFromTemplate).toHaveBeenCalledWith("default", "personal-chief-of-staff");
    expect(treeString(renderer!)).toContain("Run personal life");
  });
});
