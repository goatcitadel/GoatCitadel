// @vitest-environment happy-dom
import { StrictMode, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitadelBlueprint, CitadelStructureSnapshot } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetBlueprintAttemptsForTests } from "../../../features/native-routes/library/citadel-blueprint-state";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
import { CitadelBlueprintSettings } from "./CitadelBlueprintSettings";
const api = vi.hoisted(() => ({ exportCitadelBlueprint: vi.fn(), getCitadelStructureSnapshot: vi.fn(), importCitadelBlueprint: vi.fn(), listCitadels: vi.fn(), validateCitadelBlueprint: vi.fn(), isApiRequestError: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("../../ui/Dialog", () => ({ Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) => open ? <div role="dialog" aria-label={title}>{children}</div> : null }));
const blueprint: CitadelBlueprint = { schemaVersion: "goatcitadel.blueprint.v1", metadata: { name: "Reviewed structure" },
  charter: { purpose: "Reviewed purpose", kind: "team", goals: ["Goal"], boundaries: ["Boundary"], successDefinition: ["Success"], riskPosture: "balanced", modelPolicyDefault: "hybrid_guarded" }, chambers: [], riskNotes: [] };
let owner: CitadelStructureSnapshot, view: ReactTestRenderer | undefined;
const text = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(text).join("");
const button = (label: string) => view!.root.findAllByType("button").find(node => text(node) === label)!;
async function click(label: string) { expect(button(label)).toBeTruthy(); expect(button(label).props.disabled).not.toBe(true); await act(async () => button(label).props.onClick()); }
async function render(scope = "one") { await act(async () => { const tree = <StrictMode><CitadelBlueprintSettings citadelId={scope} /></StrictMode>; if (view) view.update(tree); else view = create(tree); }); }
async function input(value = JSON.stringify(blueprint)) { await act(async () => view!.root.findByType("textarea").props.onChange({ target: { value } })); }
beforeEach(() => {
  vi.resetAllMocks(); __resetSessionDraftsForTests(); __resetBlueprintAttemptsForTests(); __resetFormDirtyRegistryForTests();
  owner = { citadelId: "one", revision: "a".repeat(64), charter: null, chambers: [] };
  api.listCitadels.mockResolvedValue({ items: [{ citadelId: "one", hasCharter: true }] }); api.exportCitadelBlueprint.mockResolvedValue(blueprint);
  api.validateCitadelBlueprint.mockResolvedValue({ ok: true, errors: [] }); api.getCitadelStructureSnapshot.mockImplementation(async () => structuredClone(owner));
  api.importCitadelBlueprint.mockImplementation(async () => { owner = { ...owner, revision: "b".repeat(64), charter: { ...blueprint.charter, citadelId: "one", createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" } }; return structuredClone(owner); });
});
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; __resetSessionDraftsForTests(); __resetBlueprintAttemptsForTests(); __resetFormDirtyRegistryForTests(); });
describe("native Blueprint controls", () => {
  it("validates and presents structured changes, requires explicit review, then confirms the owner", async () => {
    await render(); await click("Import"); await input(); await click("Validate"); expect(text(view!.root)).toContain("Reviewed purpose");
    await click("Review import"); expect(api.importCitadelBlueprint).not.toHaveBeenCalled(); expect(text(view!.root.findByProps({ role: "dialog" }))).toContain("a".repeat(64));
    await click("Cancel"); expect(api.importCitadelBlueprint).not.toHaveBeenCalled(); await click("Review import"); await click("Apply Blueprint");
    expect(api.importCitadelBlueprint).toHaveBeenCalledExactlyOnceWith("one", blueprint, "a".repeat(64)); expect(text(view!.root)).toContain("confirmed against the saved structure");
  });
  it("retains a draft on close and keeps the later import locked after response loss", async () => {
    await render(); await click("Import"); await input(); await click("Close import"); await click("Keep draft and close");
    await click("Import · Unsaved"); expect(view!.root.findByType("textarea").props.value).toBe(JSON.stringify(blueprint));
    await click("Validate"); await click("Review import"); api.importCitadelBlueprint.mockRejectedValueOnce(new Error("Lost response")); await click("Apply Blueprint");
    await act(async () => view!.unmount()); view = undefined; await render(); await click("Import · Unsaved");
    expect(button("Validate").props.disabled).toBe(true); expect(button("Review import").props.disabled).toBe(true); expect(view!.root.findByType("textarea").props.disabled).toBe(true);
    expect(text(view!.root)).toContain("outcome is unconfirmed"); expect(api.importCitadelBlueprint).toHaveBeenCalledOnce();
  });
  it("loads a file into the draft without changing the structure", async () => {
    await render(); await click("Import"); const file = view!.root.findByProps({ type: "file" }); const target = { files: [{ size: 400, text: async () => JSON.stringify(blueprint) }], value: "file" };
    await act(async () => file.props.onChange({ target }));
    expect(view!.root.findByType("textarea").props.value).toBe(JSON.stringify(blueprint)); expect(target.value).toBe(""); expect(api.importCitadelBlueprint).not.toHaveBeenCalled();
  });
  it("displays failed schema validation without enabling any import", async () => {
    api.validateCitadelBlueprint.mockResolvedValueOnce({ ok: false, errors: ["Blueprint charter is missing or invalid."] }); await render(); await click("Import"); await input("{}"); await click("Validate");
    expect(button("Review import").props.disabled).toBe(true); expect(text(view!.root)).toContain("missing or invalid"); expect(api.importCitadelBlueprint).not.toHaveBeenCalled();
  });
});
