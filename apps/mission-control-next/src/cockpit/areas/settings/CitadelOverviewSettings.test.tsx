// @vitest-environment happy-dom
import { StrictMode, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitadelStructureSnapshot } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetCitadelStructureAttemptsForTests } from "../../../features/native-routes/library/citadel-structure-state";
import { __resetWorkspaceAttemptsForTests } from "../../../features/native-routes/settings/workspace-editor-state";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
import { overviewBrief, overviewStructure, overviewTemplate } from "../../../features/native-routes/library/citadel-overview.test-support";
import { CitadelOverviewSettings } from "./CitadelOverviewSettings";
const api = vi.hoisted(() => ({ createCitadelFromTemplate: vi.fn(), getCitadelGatehouse: vi.fn(), getCitadelStructureSnapshot: vi.fn(), listCitadelTemplates: vi.fn(), upsertCitadelCharter: vi.fn(), listCitadels: vi.fn(), fetchWorkspaces: vi.fn(), archiveCitadel: vi.fn(), restoreCitadel: vi.fn(), fetchCitadelBrief: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("../../ui/Dialog", () => ({ Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) => open ? <div role="dialog" aria-label={title}>{children}</div> : null }));
let owner: CitadelStructureSnapshot, view: ReactTestRenderer | undefined;
const text = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(text).join("");
const button = (label: string) => view!.root.findAllByType("button").find(node => text(node) === label)!;
async function click(label: string) { expect(button(label)).toBeTruthy(); expect(button(label).props.disabled).not.toBe(true); await act(async () => button(label).props.onClick()); }
async function render() { await act(async () => { const tree = <StrictMode><CitadelOverviewSettings citadelId="one" /></StrictMode>; if (view) view.update(tree); else view = create(tree); }); }
async function input(value: string) { await act(async () => view!.root.findByType("textarea").props.onChange({ target: { value } })); }
beforeEach(() => {
  vi.resetAllMocks(); __resetSessionDraftsForTests(); __resetCitadelStructureAttemptsForTests(); __resetWorkspaceAttemptsForTests(); __resetFormDirtyRegistryForTests(); owner = overviewStructure();
  api.getCitadelStructureSnapshot.mockImplementation(async () => structuredClone(owner)); api.getCitadelGatehouse.mockResolvedValue({ citadelId: "one", wardCount: 3, sealedChamberCount: 1, riskPosture: "balanced", modelPolicyDefault: "hybrid_guarded", sharingDefault: "private", externalWritesDefault: "approval_required" });
  api.listCitadelTemplates.mockResolvedValue([overviewTemplate]); api.fetchCitadelBrief.mockResolvedValue(overviewBrief());
  api.upsertCitadelCharter.mockImplementation(async (_id, input) => { const { expectedRevision: _revision, ...fields } = input; owner = { ...owner, revision: "b".repeat(64), charter: { ...owner.charter!, ...fields } }; return structuredClone(owner); });
});
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; });
describe("native Citadel Overview", () => {
  it("reviews and cancels without writes, then confirms the exact purpose and retained structure", async () => {
    await render(); await click("Edit Charter"); await input("Native reviewed purpose"); await click("Review Charter save"); expect(api.upsertCitadelCharter).not.toHaveBeenCalled(); expect(text(view!.root)).toContain("a".repeat(64));
    await click("Cancel review"); expect(api.upsertCitadelCharter).not.toHaveBeenCalled(); await click("Review Charter save"); await click("Confirm Charter save");
    expect(api.upsertCitadelCharter).toHaveBeenCalledExactlyOnceWith("one", expect.objectContaining({ purpose: "Native reviewed purpose", expectedRevision: "a".repeat(64), defaultChamberId: "old" })); expect(text(view!.root)).toContain("saved and confirmed");
  });
  it("retains inspectable dirty purpose and disables writes after a lost response and remount", async () => {
    await render(); await click("Edit Charter"); await input("Retained unknown purpose"); await click("Review Charter save"); api.upsertCitadelCharter.mockRejectedValueOnce(new Error("Response lost")); await click("Confirm Charter save");
    await act(async () => view!.unmount()); view = undefined; await render(); await click("Edit Charter · Unsaved");
    expect(view!.root.findByType("textarea").props.value).toBe("Retained unknown purpose"); expect(view!.root.findByType("textarea").props.disabled).toBe(true); expect(button("Review Charter save").props.disabled).toBe(true); expect(text(view!.root)).toContain("outcome is unconfirmed"); expect(api.upsertCitadelCharter).toHaveBeenCalledOnce();
  });
  it("keeps a dirty draft during view navigation and renders exact readable Chambers and Gatehouse", async () => {
    await render(); await click("Edit Charter"); await input("Retained native draft"); await click("Close Charter"); await click("Keep draft and close");
    await click("Chambers"); expect(text(view!.root)).toContain("Retained"); expect(text(view!.root)).toContain("Sealed");
    await click("Gatehouse"); expect(text(view!.root)).toContain("Approval required"); expect(api.upsertCitadelCharter).not.toHaveBeenCalled();
    await click("Charter"); await click("Edit Charter · Unsaved"); expect(view!.root.findByType("textarea").props.value).toBe("Retained native draft");
  });
  it("withholds stale native purpose before dispatch and presents current owner for explicit rebase", async () => {
    await render(); await click("Edit Charter"); await input("Retained draft"); await click("Review Charter save"); owner = { ...owner, revision: "d".repeat(64), charter: { ...owner.charter!, purpose: "Peer purpose" } }; await click("Confirm Charter save");
    expect(api.upsertCitadelCharter).not.toHaveBeenCalled(); expect(view!.root.findByType("textarea").props.value).toBe("Retained draft"); expect(text(view!.root)).toContain("Peer purpose"); expect(button("Review Charter save").props.disabled).toBe(true);
  });
  it("presents installation spend and exact copied brief without writes", async () => {
    const copy = vi.fn(async (_text: string) => {}); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    await render(); await click("Brief"); expect(text(view!.root)).toContain("Spend · installation"); expect(text(view!.root)).toContain("Feature disabled"); await click("Copy as Markdown");
    expect(copy).toHaveBeenCalledOnce(); expect(copy.mock.calls[0]?.[0]).toContain("# Daily brief — Reviewed Citadel"); expect(api.upsertCitadelCharter).not.toHaveBeenCalled(); expect(api.createCitadelFromTemplate).not.toHaveBeenCalled();
  });
});
