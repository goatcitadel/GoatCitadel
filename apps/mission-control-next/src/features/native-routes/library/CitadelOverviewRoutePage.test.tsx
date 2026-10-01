import { __resetSessionDraftsForTests } from "./session-drafts";
import { __resetCitadelStructureAttemptsForTests } from "./citadel-structure-state";
import { __resetWorkspaceAttemptsForTests, setWorkspaceAttempt, workspaceAttemptLocked } from "../settings/workspace-editor-state";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { act, create as createRenderer, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitadelCharter, CitadelRecord, CitadelStructureSnapshot } from "@goatcitadel/contracts";

import { CitadelOverviewRoutePage } from "./CitadelOverviewRoutePage";
import type { NativeRoutePagesProps } from "../types";

const mounted: ReactTestRenderer[] = [];
function create(...args: Parameters<typeof createRenderer>) { const renderer = createRenderer(...args); mounted.push(renderer); return renderer; }
afterEach(async () => { await act(async () => { for (const renderer of mounted.splice(0)) renderer.unmount(); }); });
function lifecycleModal(renderer: ReactTestRenderer) { return renderer.root.findAllByType(ConfirmModal).find(modal => /^(Archive|Restore) Citadel/.test(modal.props.title))!; }
function structureModal(renderer: ReactTestRenderer) { return renderer.root.findAllByType(ConfirmModal).find(modal => /^(Save this Charter|Apply this Citadel template)/.test(modal.props.title))!; }

const apiMocks = vi.hoisted(() => ({
  archiveCitadel: vi.fn(),
  createCitadelFromTemplate: vi.fn(),
  fetchWorkspaces: vi.fn(),
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
  fetchWorkspaces: apiMocks.fetchWorkspaces,
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

const CITADEL: CitadelStructureSnapshot & { record: CitadelRecord; charter: CitadelCharter } = {
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
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
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
let directoryRecord: typeof CITADEL.record & { archivedAt?: string };
let structureOwner: CitadelStructureSnapshot;
const revisionConflict = { status: 409, body: { code: "WRITE_CONFLICT", details: { reason: "CITADEL_RECORD_REVISION_CONFLICT" } } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe("CitadelOverviewRoutePage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetSessionDraftsForTests();
    __resetCitadelStructureAttemptsForTests();
    __resetWorkspaceAttemptsForTests();
    directoryRecord = { ...CITADEL.record };
    structureOwner = structuredClone(CITADEL);
    apiMocks.isApiRequestError.mockImplementation(
      (error: unknown) => typeof error === "object" && error !== null && "status" in error,
    );
    apiMocks.listCitadelTemplates.mockResolvedValue(TEMPLATES);
    apiMocks.getCitadelStructureSnapshot.mockImplementation(async () => ({ ...structureOwner, record: directoryRecord }));
    apiMocks.listCitadels.mockImplementation(async () => ({ items: [directoryRecord] }));
    apiMocks.createCitadelFromTemplate.mockImplementation(async (_citadelId: string, templateId: string) => {
      const template = TEMPLATES.find(item => item.id === templateId)!;
      structureOwner = { ...structureOwner, revision: "4".repeat(64), charter: { ...CITADEL.charter, ...template, citadelId: "default", kind: template.kind as CitadelCharter["kind"], defaultChamberId: undefined, updatedAt: "t2" },
        chambers: [...structureOwner.chambers, ...template.chambers.map((chamber, index) => ({ ...CITADEL.chambers[0]!, chamberId: `template-${index}`, name: chamber.name, sensitivity: "private" as const, sealed: false }))] };
      return { ...structureOwner, record: directoryRecord };
    });
    apiMocks.upsertCitadelCharter.mockImplementation(async (_citadelId: string, input: { expectedRevision: string } & Partial<CitadelCharter>) => {
      const { expectedRevision: _revision, ...fields } = input;
      structureOwner = { ...structureOwner, revision: "4".repeat(64), charter: { ...structureOwner.charter!, ...fields, updatedAt: "t2" } };
      return { ...structureOwner, record: directoryRecord };
    });
    apiMocks.archiveCitadel.mockImplementation(async () => (directoryRecord = {
      ...directoryRecord,
      revision: "b".repeat(64),
      lifecycleStatus: "archived",
      archivedAt: "2026-09-30T01:00:00.000Z",
      updatedAt: "2026-09-30T01:00:00.000Z",
    }));
    apiMocks.restoreCitadel.mockImplementation(async () => (directoryRecord = {
      ...directoryRecord,
      revision: "c".repeat(64),
      lifecycleStatus: "active",
      archivedAt: undefined,
      updatedAt: "2026-09-30T02:00:00.000Z",
    }));
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
    expect(apiMocks.upsertCitadelCharter).not.toHaveBeenCalled();
    await act(async () => { await structureModal(renderer!).props.onConfirm(); });
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
    await act(async () => { lifecycleModal(renderer!).props.onConfirm(); });
    expect(apiMocks.archiveCitadel).toHaveBeenCalledWith("default", CITADEL.record.revision);
    expect(treeString(renderer!)).toContain("Acme archived");
    expect(buttonContaining(renderer!, "Restore Citadel")).toBeDefined();

    await act(async () => {
      buttonContaining(renderer!, "Restore Citadel").props.onClick();
      await Promise.resolve();
    });
    expect(apiMocks.restoreCitadel).not.toHaveBeenCalled();
    await act(async () => { lifecycleModal(renderer!).props.onConfirm(); });
    expect(apiMocks.restoreCitadel).toHaveBeenCalledWith("default", "b".repeat(64));
    expect(treeString(renderer!)).toContain("Acme restored");
  });

  it("retains a Charter draft after an archive conflict and requires a new confirmation of the current profile", async () => {
    apiMocks.getCitadel.mockResolvedValue(CITADEL);
    apiMocks.getCitadelGatehouse.mockResolvedValue(GATEHOUSE);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { buttonContaining(renderer!, "Edit Charter").props.onClick(); });
    await act(async () => { renderer!.root.findByType("textarea").props.onChange({ target: { value: "Unsaved Charter purpose" } }); });
    await act(async () => { buttonContaining(renderer!, "Archive Citadel").props.onClick(); });
    expect(lifecycleModal(renderer!).props.message).toContain("Acme");
    const winner = { ...CITADEL, record: { ...CITADEL.record, name: "Peer Citadel", revision: "d".repeat(64) } };
    apiMocks.archiveCitadel.mockImplementationOnce(async () => { directoryRecord = winner.record; throw revisionConflict; });
    await act(async () => { await lifecycleModal(renderer!).props.onConfirm(); });
    expect(apiMocks.archiveCitadel).toHaveBeenCalledExactlyOnceWith("default", CITADEL.record.revision);
    expect(lifecycleModal(renderer!).props.open).toBe(false);
    expect(renderer!.root.findByType("textarea").props.value).toBe("Unsaved Charter purpose");
    expect(treeString(renderer!)).toContain("Refresh and review its current revision");
    await act(async () => { buttonContaining(renderer!, "Archive Citadel").props.onClick(); });
    expect(lifecycleModal(renderer!).props.message).toContain("Peer Citadel");
    await act(async () => { await lifecycleModal(renderer!).props.onConfirm(); });
    expect(apiMocks.archiveCitadel).toHaveBeenNthCalledWith(2, "default", winner.record.revision);
    await act(async () => { renderer!.unmount(); });
  });

  it("refreshes a rejected restore without retrying it automatically", async () => {
    const archived = { ...CITADEL, record: { ...CITADEL.record, lifecycleStatus: "archived" as const } };
    directoryRecord = archived.record;
    apiMocks.getCitadel.mockResolvedValue(archived);
    apiMocks.getCitadelGatehouse.mockResolvedValue(GATEHOUSE);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { buttonContaining(renderer!, "Edit Charter").props.onClick(); });
    const winner = { ...archived, record: { ...archived.record, revision: "e".repeat(64) } };
    apiMocks.restoreCitadel.mockImplementationOnce(async () => { directoryRecord = winner.record; throw revisionConflict; });
    await act(async () => { await buttonContaining(renderer!, "Restore Citadel").props.onClick(); });
    await act(async () => { lifecycleModal(renderer!).props.onConfirm(); });
    expect(apiMocks.restoreCitadel).toHaveBeenCalledExactlyOnceWith("default", archived.record.revision);
    expect(treeString(renderer!)).toContain("Refresh and review its current revision");
    await act(async () => { await buttonContaining(renderer!, "Restore Citadel").props.onClick(); });
    await act(async () => { lifecycleModal(renderer!).props.onConfirm(); });
    expect(apiMocks.restoreCitadel).toHaveBeenNthCalledWith(2, "default", winner.record.revision);
    await act(async () => { renderer!.unmount(); });
  });

  it.each(["saving", "uncertain"] as const)("honors the shared Citadel metadata %s lock after mounting", async (phase) => {
    setWorkspaceAttempt("citadel:default:edit", { phase, message: "Profile change awaiting its owner." });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { buttonContaining(renderer, "Edit Charter").props.onClick(); });
    expect(buttonContaining(renderer, "Archive Citadel").props.disabled).toBe(true);
    await act(async () => { buttonContaining(renderer, "Archive Citadel").props.onClick(); });
    expect(lifecycleModal(renderer).props.open).toBe(false);
    expect(apiMocks.archiveCitadel).not.toHaveBeenCalled();
    expect(treeString(renderer)).toContain("Profile change awaiting its owner");
    await act(async () => { renderer.unmount(); });
  });

  it("retains an unconfirmed lifecycle lock across remount while preserving the Charter draft", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { buttonContaining(renderer, "Edit Charter").props.onClick(); });
    await act(async () => { renderer.root.findByType("textarea").props.onChange({ target: { value: "Retain Charter input" } }); });
    await act(async () => { buttonContaining(renderer, "Archive Citadel").props.onClick(); });
    expect(lifecycleModal(renderer).props.message).toContain(CITADEL.record.revision);
    expect(lifecycleModal(renderer).props.message).toContain("Charter draft are retained");
    apiMocks.archiveCitadel.mockRejectedValueOnce(new Error("Response lost"));
    await act(async () => { lifecycleModal(renderer).props.onConfirm(); });
    expect(workspaceAttemptLocked("citadel:default:edit")).toBe(true);
    await act(async () => { renderer.unmount(); });
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { buttonContaining(renderer, "Edit Charter").props.onClick(); });
    expect(renderer.root.findByType("textarea").props.value).toBe("Retain Charter input");
    expect(buttonContaining(renderer, "Archive Citadel").props.disabled).toBe(true);
    expect(apiMocks.archiveCitadel).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.unmount(); });
  });

  it("cancels an overview lifecycle preflight after leaving and returning to its Citadel", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { buttonContaining(renderer, "Edit Charter").props.onClick(); });
    await act(async () => { buttonContaining(renderer, "Archive Citadel").props.onClick(); });
    const read = deferred<{ items: typeof CITADEL.record[] }>();
    apiMocks.listCitadels.mockReturnValueOnce(read.promise);
    await act(async () => { lifecycleModal(renderer).props.onConfirm(); });
    await act(async () => { renderer.update(<CitadelOverviewRoutePage {...makeProps()} activeCitadelId="other" />); });
    await act(async () => { renderer.update(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { read.resolve({ items: [CITADEL.record] }); });
    expect(apiMocks.archiveCitadel).not.toHaveBeenCalled();
    expect(lifecycleModal(renderer).props.open).toBe(false);
    expect(workspaceAttemptLocked("citadel:default:edit")).toBe(false);
    await act(async () => { renderer.unmount(); });
  });

  it("withholds a late lifecycle refresh after a Citadel round trip", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { buttonContaining(renderer, "Edit Charter").props.onClick(); });
    await act(async () => { buttonContaining(renderer, "Archive Citadel").props.onClick(); });
    const read = deferred<typeof CITADEL>();
    apiMocks.getCitadelStructureSnapshot.mockReturnValueOnce(read.promise);
    await act(async () => { lifecycleModal(renderer).props.onConfirm(); });
    expect(directoryRecord.lifecycleStatus).toBe("archived");
    await act(async () => { renderer.update(<CitadelOverviewRoutePage {...makeProps()} activeCitadelId="other" />); });
    apiMocks.getCitadelStructureSnapshot.mockResolvedValueOnce({ ...CITADEL, record: directoryRecord,
      charter: { ...CITADEL.charter, purpose: "Current Charter after reload" } });
    await act(async () => { renderer.update(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { read.resolve({ ...CITADEL, charter: { ...CITADEL.charter, purpose: "Stale lifecycle projection" } }); });
    expect(treeString(renderer)).toContain("Current Charter after reload");
    expect(treeString(renderer)).not.toContain("Stale lifecycle projection");
    await act(async () => { renderer.unmount(); });
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
    apiMocks.upsertCitadelCharter.mockImplementationOnce(async () => { structureOwner = winner; throw { status: 409, body: { code: "WRITE_CONFLICT", details: { reason: "CITADEL_STRUCTURE_REVISION_CONFLICT" } } }; });
    await act(async () => { await buttonContaining(renderer, "Save charter").props.onClick(); });
    await act(async () => { await structureModal(renderer).props.onConfirm(); });
    expect(apiMocks.upsertCitadelCharter).toHaveBeenCalledExactlyOnceWith("default", expect.objectContaining({ purpose: "My retained draft", expectedRevision: CITADEL.revision }));
    expect(renderer.root.findByType("textarea").props.value).toBe("My retained draft");
    expect(treeString(renderer)).toContain("Peer purpose");
    expect(buttonContaining(renderer, "Save charter").props.disabled).toBe(true);
    await act(async () => { buttonContaining(renderer, "Apply draft to current Charter").props.onClick(); });
    expect(apiMocks.upsertCitadelCharter).toHaveBeenCalledTimes(1);
    await act(async () => { await buttonContaining(renderer, "Save charter").props.onClick(); });
    await act(async () => { await structureModal(renderer).props.onConfirm(); });
    expect(apiMocks.upsertCitadelCharter).toHaveBeenNthCalledWith(2, "default", expect.objectContaining({ purpose: "My retained draft", expectedRevision: winner.revision }));
    await act(async () => { renderer.unmount(); });
  });

  it("refreshes changed template contents without applying them automatically", async () => {
    const empty = { citadelId: "default", revision: "0".repeat(64), charter: null, chambers: [] };
    structureOwner = empty;
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    apiMocks.listCitadelTemplates.mockResolvedValueOnce(TEMPLATES.map((template) => ({ ...template, revision: "9".repeat(64) })));
    await act(async () => { await buttonContaining(renderer, "Use template").props.onClick(); });
    await act(async () => { await structureModal(renderer).props.onConfirm(); });
    expect(apiMocks.createCitadelFromTemplate).not.toHaveBeenCalled();
    expect(treeString(renderer)).toContain("The template changed");
    apiMocks.listCitadelTemplates.mockResolvedValue(TEMPLATES.map((template) => ({ ...template, revision: "9".repeat(64) })));
    await act(async () => { await buttonContaining(renderer, "Use template").props.onClick(); });
    await act(async () => { await structureModal(renderer).props.onConfirm(); });
    expect(apiMocks.createCitadelFromTemplate).toHaveBeenCalledExactlyOnceWith("default", TEMPLATES[0]!.id, empty.revision, "9".repeat(64));
    await act(async () => { renderer.unmount(); });
  });

  it("keeps a committed setup when its Gatehouse follow-up fails", async () => {
    structureOwner = { citadelId: "default", revision: "0".repeat(64), charter: null, chambers: [] };
    apiMocks.getCitadelGatehouse.mockRejectedValue(new Error("Summary offline"));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelOverviewRoutePage {...makeProps()} />); });
    await act(async () => { await buttonContaining(renderer, "Use template").props.onClick(); });
    await act(async () => { await structureModal(renderer).props.onConfirm(); });
    expect(treeString(renderer)).toContain(TEMPLATES[0]!.purpose);
    expect(treeString(renderer)).toContain("Charter loaded. Gatehouse summary unavailable");
    expect(apiMocks.createCitadelFromTemplate).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.unmount(); });
  });

  it("creates the active Citadel from the Personal default template", async () => {
    structureOwner = { citadelId: "default", revision: "0".repeat(64), charter: null, chambers: [] };
    apiMocks.getCitadel.mockRejectedValue({ status: 404 });
    apiMocks.getCitadelGatehouse.mockRejectedValueOnce({ status: 404 }).mockResolvedValueOnce(GATEHOUSE);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelOverviewRoutePage {...makeProps()} />);
    });

    await act(async () => {
      buttonContaining(renderer!, "Use template").props.onClick();
    });
    expect(apiMocks.createCitadelFromTemplate).not.toHaveBeenCalled();
    await act(async () => { await structureModal(renderer!).props.onConfirm(); });

    expect(apiMocks.createCitadelFromTemplate).toHaveBeenCalledWith("default", "personal-chief-of-staff", "0".repeat(64), "2".repeat(64));
    expect(treeString(renderer!)).toContain(TEMPLATES[0]!.purpose);
  });
});
