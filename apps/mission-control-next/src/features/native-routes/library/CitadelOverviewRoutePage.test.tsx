import { __resetSessionDraftsForTests } from "./session-drafts";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitadelOverviewRoutePage } from "./CitadelOverviewRoutePage";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  archiveCitadel: vi.fn(),
  createCitadelFromTemplate: vi.fn(),
  getCitadel: vi.fn(),
  getCitadelStructureSnapshot: vi.fn(),
  getCitadelGatehouse: vi.fn(),
  isApiRequestError: vi.fn(),
  listCitadels: vi.fn(),
  listCitadelTemplates: vi.fn(),
  restoreCitadel: vi.fn(),
  upsertCitadelCharter: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  archiveCitadel: apiMocks.archiveCitadel,
  createCitadelFromTemplate: apiMocks.createCitadelFromTemplate,
  getCitadel: apiMocks.getCitadel,
  getCitadelStructureSnapshot: apiMocks.getCitadelStructureSnapshot,
  getCitadelGatehouse: apiMocks.getCitadelGatehouse,
  isApiRequestError: apiMocks.isApiRequestError,
  listCitadels: apiMocks.listCitadels,
  listCitadelTemplates: apiMocks.listCitadelTemplates,
  restoreCitadel: apiMocks.restoreCitadel,
  upsertCitadelCharter: apiMocks.upsertCitadelCharter,
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
  revision: "1".repeat(64),
  record: {
    citadelId: "default",
    revision: "a".repeat(64),
    name: "Acme",
    slug: "default",
    kind: "company",
    lifecycleStatus: "active",
    hasCharter: true,
    createdAt: "t",
    updatedAt: "t",
  },
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
    revision: "2".repeat(64),
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
    revision: "3".repeat(64),
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
    __resetSessionDraftsForTests();
    apiMocks.isApiRequestError.mockImplementation(
      (error: unknown) => typeof error === "object" && error !== null && "status" in error,
    );
    apiMocks.listCitadelTemplates.mockResolvedValue(TEMPLATES);
    apiMocks.getCitadelStructureSnapshot.mockReset().mockResolvedValue(CITADEL);
    apiMocks.listCitadels.mockResolvedValue({
      items: [CITADEL.record],
    });
    apiMocks.createCitadelFromTemplate.mockResolvedValue(PERSONAL_CITADEL);
    apiMocks.upsertCitadelCharter.mockImplementation(async (_citadelId: string, input: object) => ({
      ...CITADEL,
      revision: "4".repeat(64),
      charter: { ...CITADEL.charter, ...input, updatedAt: "t2" },
    }));
    apiMocks.archiveCitadel.mockResolvedValue({
      ...CITADEL.record,
      revision: "b".repeat(64),
      lifecycleStatus: "archived",
      archivedAt: "t2",
      updatedAt: "t2",
    });
    apiMocks.restoreCitadel.mockResolvedValue({
      ...CITADEL.record,
      revision: "c".repeat(64),
      updatedAt: "t3",
    });
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
    await act(async () => { buttonContaining(renderer!, "Chambers").props.onClick(); });
    expect(treeString(renderer!)).toContain("Finance");
    expect(treeString(renderer!)).toContain("sealed");
    await act(async () => { buttonContaining(renderer!, "Gatehouse").props.onClick(); });
    // Gatehouse enums are humanized for operators (was raw "approval_required").
    expect(treeString(renderer!)).toContain("Approval required");
    expect(tree).not.toContain("approval_required");
  });

  it("saves Charter purpose and explicitly archives then restores the Citadel", async () => {
    apiMocks.getCitadel.mockResolvedValue(CITADEL);
    apiMocks.getCitadelGatehouse.mockResolvedValue(GATEHOUSE);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelOverviewRoutePage {...makeProps()} />);
    });
    await act(async () => { buttonContaining(renderer!, "Edit Charter").props.onClick(); });

    await act(async () => {
      renderer!.root.findByType("textarea").props.onChange({
        target: { value: "Govern the verification Citadel." },
      });
    });
    await act(async () => {
      buttonContaining(renderer!, "Save charter").props.onClick();
      await Promise.resolve();
    });
    expect(apiMocks.upsertCitadelCharter).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({
        purpose: "Govern the verification Citadel.",
        kind: "company",
        goals: ["Ship v1"],
        boundaries: ["No prod writes without approval"],
      }),
    );
    expect(treeString(renderer!)).toContain("Citadel Charter saved");
    await act(async () => { buttonContaining(renderer!, "Edit Charter").props.onClick(); });

    await act(async () => {
      buttonContaining(renderer!, "Archive Citadel").props.onClick();
      await Promise.resolve();
    });
    expect(apiMocks.archiveCitadel).not.toHaveBeenCalled();
    await act(async () => { renderer!.root.findByType(ConfirmModal).props.onConfirm(); });
    expect(apiMocks.archiveCitadel).toHaveBeenCalledWith("default", CITADEL.record.revision);
    expect(treeString(renderer!)).toContain("Citadel archived");
    expect(buttonContaining(renderer!, "Restore Citadel")).toBeDefined();

    await act(async () => {
      buttonContaining(renderer!, "Restore Citadel").props.onClick();
      await Promise.resolve();
    });
    expect(apiMocks.restoreCitadel).toHaveBeenCalledWith("default", "b".repeat(64));
    expect(treeString(renderer!)).toContain("Citadel restored");
  });

  it("retains a Charter draft after an archive conflict and requires a new confirmation of the current profile", async () => {
    apiMocks.getCitadel.mockResolvedValue(CITADEL);
    apiMocks.getCitadelGatehouse.mockResolvedValue(GATEHOUSE);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { buttonContaining(renderer!, "Edit Charter").props.onClick(); });
    await act(async () => { renderer!.root.findByType("textarea").props.onChange({ target: { value: "Unsaved Charter purpose" } }); });
    await act(async () => { buttonContaining(renderer!, "Archive Citadel").props.onClick(); });
    expect(renderer!.root.findByType(ConfirmModal).props.message).toContain("Acme");
    const winner = { ...CITADEL, record: { ...CITADEL.record, name: "Peer Citadel", revision: "d".repeat(64) } };
    apiMocks.archiveCitadel.mockRejectedValueOnce({ status: 409 });
    apiMocks.getCitadel.mockResolvedValueOnce(winner);
    await act(async () => { await renderer!.root.findByType(ConfirmModal).props.onConfirm(); });
    expect(apiMocks.archiveCitadel).toHaveBeenCalledExactlyOnceWith("default", CITADEL.record.revision);
    expect(renderer!.root.findByType(ConfirmModal).props.open).toBe(false);
    expect(renderer!.root.findByType("textarea").props.value).toBe("Unsaved Charter purpose");
    expect(treeString(renderer!)).toContain("open a new archive confirmation");
    await act(async () => { buttonContaining(renderer!, "Archive Citadel").props.onClick(); });
    expect(renderer!.root.findByType(ConfirmModal).props.message).toContain("Peer Citadel");
    await act(async () => { await renderer!.root.findByType(ConfirmModal).props.onConfirm(); });
    expect(apiMocks.archiveCitadel).toHaveBeenNthCalledWith(2, "default", winner.record.revision);
    await act(async () => { renderer!.unmount(); });
  });

  it("refreshes a rejected restore without retrying it automatically", async () => {
    const archived = { ...CITADEL, record: { ...CITADEL.record, lifecycleStatus: "archived" } };
    apiMocks.getCitadelStructureSnapshot.mockResolvedValue(archived);
    apiMocks.getCitadel.mockResolvedValue(archived);
    apiMocks.getCitadelGatehouse.mockResolvedValue(GATEHOUSE);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { buttonContaining(renderer!, "Edit Charter").props.onClick(); });
    apiMocks.restoreCitadel.mockRejectedValueOnce({ status: 409 });
    const winner = { ...archived, record: { ...archived.record, revision: "e".repeat(64) } };
    apiMocks.getCitadel.mockResolvedValueOnce(winner);
    await act(async () => { await buttonContaining(renderer!, "Restore Citadel").props.onClick(); });
    expect(apiMocks.restoreCitadel).toHaveBeenCalledExactlyOnceWith("default", archived.record.revision);
    expect(treeString(renderer!)).toContain("before restoring it again");
    await act(async () => { await buttonContaining(renderer!, "Restore Citadel").props.onClick(); });
    expect(apiMocks.restoreCitadel).toHaveBeenNthCalledWith(2, "default", winner.record.revision);
    await act(async () => { renderer!.unmount(); });
  });

  it("shows the staged setup state without fetching detail when the active Citadel has no Charter", async () => {
    apiMocks.getCitadelStructureSnapshot.mockResolvedValue({ citadelId: "default", revision: "0".repeat(64), charter: null, chambers: [] });
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
    apiMocks.getCitadelStructureSnapshot.mockResolvedValue({ citadelId: "default", revision: "0".repeat(64), charter: null, chambers: [] });
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

  it("preserves a stale Charter draft and only retries with an explicitly reviewed structure", async () => {
    apiMocks.getCitadelGatehouse.mockResolvedValue(GATEHOUSE);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { buttonContaining(renderer, "Edit Charter").props.onClick(); });
    await act(async () => { renderer.root.findByType("textarea").props.onChange({ target: { value: "My retained draft" } }); });
    const winner = { ...CITADEL, revision: "8".repeat(64), charter: { ...CITADEL.charter, purpose: "Peer purpose" }, chambers: [] };
    apiMocks.upsertCitadelCharter.mockRejectedValueOnce({ status: 409 });
    apiMocks.getCitadelStructureSnapshot.mockResolvedValueOnce(winner);
    await act(async () => { await buttonContaining(renderer, "Save charter").props.onClick(); });
    expect(apiMocks.upsertCitadelCharter).toHaveBeenCalledExactlyOnceWith("default", expect.objectContaining({ purpose: "My retained draft", expectedRevision: CITADEL.revision }));
    expect(renderer.root.findByType("textarea").props.value).toBe("My retained draft");
    expect(treeString(renderer)).toContain("Peer purpose");
    expect(buttonContaining(renderer, "Save charter").props.disabled).toBe(true);
    await act(async () => { buttonContaining(renderer, "Apply draft to current Charter").props.onClick(); });
    expect(apiMocks.upsertCitadelCharter).toHaveBeenCalledTimes(1);
    await act(async () => { await buttonContaining(renderer, "Save charter").props.onClick(); });
    expect(apiMocks.upsertCitadelCharter).toHaveBeenNthCalledWith(2, "default", expect.objectContaining({ purpose: "My retained draft", expectedRevision: winner.revision }));
    await act(async () => { renderer.unmount(); });
  });

  it("refreshes changed template contents without applying them automatically", async () => {
    const empty = { citadelId: "default", revision: "0".repeat(64), charter: null, chambers: [] };
    apiMocks.getCitadelStructureSnapshot.mockResolvedValue(empty);
    apiMocks.createCitadelFromTemplate.mockRejectedValueOnce({ status: 409 });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    apiMocks.listCitadelTemplates.mockResolvedValueOnce(TEMPLATES.map((template) => ({ ...template, revision: "9".repeat(64) })));
    await act(async () => { await buttonContaining(renderer, "Use template").props.onClick(); });
    expect(apiMocks.createCitadelFromTemplate).toHaveBeenCalledExactlyOnceWith("default", TEMPLATES[0]!.id, empty.revision, TEMPLATES[0]!.revision);
    expect(treeString(renderer)).toContain("Citadel or template changed");
    await act(async () => { await buttonContaining(renderer, "Use template").props.onClick(); });
    expect(apiMocks.createCitadelFromTemplate).toHaveBeenNthCalledWith(2, "default", TEMPLATES[0]!.id, empty.revision, "9".repeat(64));
    await act(async () => { renderer.unmount(); });
  });

  it("keeps a committed setup when its Gatehouse follow-up fails", async () => {
    apiMocks.getCitadelStructureSnapshot.mockResolvedValue({ citadelId: "default", revision: "0".repeat(64), charter: null, chambers: [] });
    apiMocks.getCitadelGatehouse.mockRejectedValue(new Error("Summary offline"));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { await buttonContaining(renderer, "Use template").props.onClick(); });
    expect(treeString(renderer)).toContain("Run personal life");
    expect(treeString(renderer)).toContain("Template applied. Gatehouse summary unavailable");
    expect(apiMocks.createCitadelFromTemplate).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.unmount(); });
  });

  it("creates the active Citadel from the Personal default template", async () => {
    apiMocks.getCitadelStructureSnapshot.mockResolvedValue({ citadelId: "default", revision: "0".repeat(64), charter: null, chambers: [] });
    apiMocks.getCitadel.mockRejectedValue({ status: 404 });
    apiMocks.getCitadelGatehouse.mockRejectedValueOnce({ status: 404 }).mockResolvedValueOnce(GATEHOUSE);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelOverviewRoutePage {...makeProps()} />);
    });

    await act(async () => {
      buttonContaining(renderer!, "Use template").props.onClick();
    });

    expect(apiMocks.createCitadelFromTemplate).toHaveBeenCalledWith("default", "personal-chief-of-staff", "0".repeat(64), "2".repeat(64));
    expect(treeString(renderer!)).toContain("Run personal life");
  });
});
