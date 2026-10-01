import { __resetSessionDraftsForTests } from "./session-drafts";
import { __resetBlueprintAttemptsForTests } from "./citadel-blueprint-state";
import { __resetFormDirtyRegistryForTests } from "./use-form-dirty";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { act, create as createRenderer, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildBlueprintProofItems, CitadelBlueprintRoutePage, downloadBlueprint } from "./CitadelBlueprintRoutePage";
import type { NativeRoutePagesProps } from "../types";

const blueprint = { schemaVersion: "goatcitadel.blueprint.v1", metadata: { name: "Acme" },
  charter: { purpose: "Reviewed purpose", kind: "team", goals: [], boundaries: [], successDefinition: [], riskPosture: "balanced", modelPolicyDefault: "hybrid_guarded" }, chambers: [], riskNotes: [] };
let owner: any;
const mounted: ReactTestRenderer[] = [];
function create(...args: Parameters<typeof createRenderer>) { const view = createRenderer(...args); mounted.push(view); return view; }
afterEach(async () => { await act(async () => { for (const view of mounted.splice(0)) view.unmount(); }); });

const apiMocks = vi.hoisted(() => ({
  exportCitadelBlueprint: vi.fn(),
  validateCitadelBlueprint: vi.fn(),
  importCitadelBlueprint: vi.fn(),
  getCitadelStructureSnapshot: vi.fn(),
  isApiRequestError: vi.fn(),
  listCitadels: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  exportCitadelBlueprint: apiMocks.exportCitadelBlueprint,
  validateCitadelBlueprint: apiMocks.validateCitadelBlueprint,
  importCitadelBlueprint: apiMocks.importCitadelBlueprint,
  getCitadelStructureSnapshot: apiMocks.getCitadelStructureSnapshot,
  isApiRequestError: apiMocks.isApiRequestError,
  listCitadels: apiMocks.listCitadels,
}));

function makeProps(): NativeRoutePagesProps {
  return {
    route: { area: "library", section: "citadel-blueprint", theme: "library" },
    activeWorkspaceId: "default",
    activeWorkspaceName: "Acme",
    pendingApprovals: 0,
    navigate: vi.fn(),
    setActiveWorkspaceId: vi.fn(),
  };
}

function treeString(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function instanceText(node: ReactTestInstance | string): string {
  if (typeof node === "string") {
    return node;
  }
  return (node.children ?? []).map((child) => instanceText(child)).join(" ");
}

function buttonByLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const [node] = renderer.root.findAll((n) => n.type === "button" && instanceText(n).includes(label));
  if (!node) {
    throw new Error(`No button "${label}"`);
  }
  return node;
}

describe("CitadelBlueprintRoutePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSessionDraftsForTests(); __resetBlueprintAttemptsForTests(); __resetFormDirtyRegistryForTests();
    apiMocks.exportCitadelBlueprint.mockResolvedValue(blueprint);
    apiMocks.validateCitadelBlueprint.mockResolvedValue({ ok: true, errors: [] });
    owner = { citadelId: "default", revision: "a".repeat(64), charter: null, chambers: [] };
    apiMocks.importCitadelBlueprint.mockImplementation(async (_id, imported) => {
      owner = { ...owner, revision: "f".repeat(64), charter: { ...imported.charter, citadelId: "default", createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" } }; return structuredClone(owner);
    });
    apiMocks.getCitadelStructureSnapshot.mockReset().mockImplementation(async () => structuredClone(owner));
    apiMocks.listCitadels.mockResolvedValue({
      items: [{ citadelId: "default", name: "Acme", slug: "default", kind: "company", hasCharter: true }],
    });
    apiMocks.isApiRequestError.mockImplementation(
      (error: unknown) => typeof error === "object" && error !== null && "status" in error,
    );
  });

  it("renders the Blueprint header", () => {
    apiMocks.exportCitadelBlueprint.mockReturnValue(new Promise(() => {}));
    const markup = renderToStaticMarkup(<CitadelBlueprintRoutePage {...makeProps()} />);
    expect(markup).toContain("Blueprint");
  });

  it("shows the exported Blueprint JSON when staged", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelBlueprintRoutePage {...makeProps()} />);
    });
    expect(apiMocks.exportCitadelBlueprint).toHaveBeenCalledWith("default");
    expect(treeString(renderer!)).toContain("goatcitadel.blueprint.v1");
    expect(treeString(renderer!)).toContain("Secret posture");
    expect(treeString(renderer!)).toContain("secret-free contract");
  });

  it("validates then imports a pasted Blueprint", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelBlueprintRoutePage {...makeProps()} />);
    });
    await act(async () => { buttonByLabel(renderer!, "Import").props.onClick(); });
    await act(async () => {
      renderer!.root
        .findByType("textarea")
        .props.onChange({ target: { value: JSON.stringify(blueprint) } });
    });
    await act(async () => {
      buttonByLabel(renderer!, "Validate").props.onClick();
    });
    expect(apiMocks.validateCitadelBlueprint).toHaveBeenCalledWith(blueprint);
    expect(treeString(renderer!)).toContain("Blueprint valid");

    await act(async () => {
      buttonByLabel(renderer!, "Review import").props.onClick();
    });
    expect(apiMocks.importCitadelBlueprint).not.toHaveBeenCalled();
    await act(async () => { renderer!.root.findByType(ConfirmModal).props.onConfirm(); });
    expect(apiMocks.importCitadelBlueprint).toHaveBeenCalledWith("default", blueprint, "a".repeat(64));
  });

  it("loads the staged export into the governed import flow", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelBlueprintRoutePage {...makeProps()} />);
    });

    await act(async () => {
      buttonByLabel(renderer!, "Load export for import").props.onClick();
    });
    expect(renderer!.root.findByType("textarea").props.value).toContain("goatcitadel.blueprint.v1");

    await act(async () => {
      buttonByLabel(renderer!, "Validate").props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      buttonByLabel(renderer!, "Review import").props.onClick();
      await Promise.resolve();
    });
    expect(apiMocks.validateCitadelBlueprint).toHaveBeenCalledWith(blueprint);
    expect(apiMocks.importCitadelBlueprint).not.toHaveBeenCalled();
    await act(async () => { renderer!.root.findByType(ConfirmModal).props.onConfirm(); });
    expect(apiMocks.importCitadelBlueprint).toHaveBeenCalledWith("default", blueprint, "a".repeat(64));
  });

  it("preserves a rejected Blueprint and requires fresh validation and confirmation before retry", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelBlueprintRoutePage {...makeProps()} />); });
    await act(async () => { buttonByLabel(renderer, "Import").props.onClick(); });
    const input = JSON.stringify(blueprint);
    await act(async () => { renderer.root.findByType("textarea").props.onChange({ target: { value: input } }); });
    await act(async () => { await buttonByLabel(renderer, "Validate").props.onClick(); });
    await act(async () => { buttonByLabel(renderer, "Review import").props.onClick(); });
    apiMocks.importCitadelBlueprint.mockRejectedValueOnce({ status: 409, body: { code: "WRITE_CONFLICT", details: { reason: "CITADEL_STRUCTURE_REVISION_CONFLICT" } } });
    await act(async () => { await renderer.root.findByType(ConfirmModal).props.onConfirm(); });
    expect(apiMocks.importCitadelBlueprint).toHaveBeenCalledExactlyOnceWith("default", JSON.parse(input), "a".repeat(64));
    expect(renderer.root.findByType("textarea").props.value).toBe(input);
    expect(renderer.root.findByType(ConfirmModal).props.open).toBe(false);
    expect(buttonByLabel(renderer, "Review import").props.disabled).toBe(true);
    expect(treeString(renderer)).toContain("Validate again");
    owner = { ...owner, revision: "b".repeat(64), charter: { ...blueprint.charter, citadelId: "default", purpose: "Peer Charter", createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" } };
    await act(async () => { await buttonByLabel(renderer, "Validate").props.onClick(); });
    expect(treeString(renderer)).toContain("Peer Charter");
    expect(apiMocks.importCitadelBlueprint).toHaveBeenCalledTimes(1);
    await act(async () => { buttonByLabel(renderer, "Review import").props.onClick(); });
    await act(async () => { await renderer.root.findByType(ConfirmModal).props.onConfirm(); });
    expect(apiMocks.importCitadelBlueprint).toHaveBeenNthCalledWith(2, "default", JSON.parse(input), "b".repeat(64));
    await act(async () => { renderer.unmount(); });
  });

  it("does not apply validation from a different Citadel after scope changes", async () => {
    let release!: (value: unknown) => void;
    apiMocks.validateCitadelBlueprint.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelBlueprintRoutePage {...makeProps()} />); });
    await act(async () => { buttonByLabel(renderer, "Import").props.onClick(); });
    await act(async () => { renderer.root.findByType("textarea").props.onChange({ target: { value: "{}" } }); });
    await act(async () => { buttonByLabel(renderer, "Validate").props.onClick(); });
    await act(async () => { renderer.update(<CitadelBlueprintRoutePage {...makeProps()} activeCitadelId="other" />); });
    await act(async () => { release({ ok: true, errors: [] }); });
    expect(treeString(renderer)).toContain("Citadel directory evidence is unavailable");
    expect(apiMocks.importCitadelBlueprint).not.toHaveBeenCalled();
    await act(async () => { renderer.unmount(); });
  });

  it("downloads a secret-free Blueprint with a safe filename", () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const createObjectURL = vi.fn(() => "blob:blueprint");
    const revokeObjectURL = vi.fn();
    const anchor = { href: "", download: "", click, remove };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    try {
      downloadBlueprint('{"schemaVersion":"goatcitadel.blueprint.v1"}', "Acme / Operations");
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(anchor.download).toBe("Acme-Operations-blueprint.json");
      expect(appendChild).toHaveBeenCalledWith(anchor);
      expect(click).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();
      vi.runAllTimers();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:blueprint");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("reports a not-staged workspace as nothing to export", async () => {
    apiMocks.exportCitadelBlueprint.mockRejectedValue({ status: 404 });
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelBlueprintRoutePage {...makeProps()} />);
    });
    expect(treeString(renderer!)).toContain("needs a Charter before export");
  });

  it("reports a no-charter workspace as not staged without exporting", async () => {
    apiMocks.listCitadels.mockResolvedValueOnce({
      items: [{ citadelId: "default", name: "Acme", slug: "default", kind: "company", hasCharter: false }],
    });
    apiMocks.exportCitadelBlueprint.mockRejectedValue(new Error("export should not load"));
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelBlueprintRoutePage {...makeProps()} />);
    });
    expect(apiMocks.exportCitadelBlueprint).not.toHaveBeenCalled();
    expect(treeString(renderer!)).toContain("needs a Charter before export");
  });

  it("builds export proof rows from the staged blueprint artifact", () => {
    expect(buildBlueprintProofItems('{"schemaVersion":"goatcitadel.blueprint.v1"}', "default")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Citadel", meta: "default" }),
        expect.objectContaining({ title: "Schema", meta: "goatcitadel.blueprint.v1" }),
        expect.objectContaining({ title: "Secret posture", meta: "secret-free contract" }),
      ]),
    );
  });
});
