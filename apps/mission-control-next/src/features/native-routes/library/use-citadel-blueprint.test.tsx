// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitadelBlueprint, CitadelStructureSnapshot } from "@goatcitadel/contracts";
import { useCitadelBlueprint } from "./use-citadel-blueprint";
import { __resetBlueprintAttemptsForTests, blueprintLocked } from "./citadel-blueprint-state";
import { __resetSessionDraftsForTests } from "./session-drafts";
import { blueprintImportMatches } from "./citadel-blueprint-binding";

const api = vi.hoisted(() => ({ base: "http://gateway-one", exportCitadelBlueprint: vi.fn(), getCitadelStructureSnapshot: vi.fn(), importCitadelBlueprint: vi.fn(), listCitadels: vi.fn(), validateCitadelBlueprint: vi.fn(), isApiRequestError: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.base }));
vi.mock("@goatcitadel/mission-control-shared/components/ui/GCModal", () => ({ GCModal: ({ children }: { children: ReactNode }) => <>{children}</> }));
export const blueprint: CitadelBlueprint = { schemaVersion: "goatcitadel.blueprint.v1", metadata: { name: "Reviewed structure" },
  charter: { purpose: "Reviewed purpose", kind: "team", goals: ["Goal"], boundaries: ["Boundary"], successDefinition: ["Success"], riskPosture: "balanced", modelPolicyDefault: "hybrid_guarded" },
  chambers: [{ name: "New Chamber", sensitivity: "private", sealed: true }], riskNotes: [] };
const initial = (): CitadelStructureSnapshot => ({ citadelId: "one", revision: "a".repeat(64), charter: null, chambers: [{ chamberId: "old", citadelId: "one", name: "Retained Chamber", sensitivity: "private", sealed: false, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" }] });
const receipt = (before: CitadelStructureSnapshot): CitadelStructureSnapshot => ({ ...before, revision: "b".repeat(64), charter: { ...blueprint.charter, citadelId: "one", createdAt: "2026-09-30T01:00:00.000Z", updatedAt: "2026-09-30T01:00:00.000Z" },
  chambers: [...before.chambers, { ...blueprint.chambers[0]!, citadelId: "one", chamberId: "new", createdAt: "2026-09-30T01:00:00.000Z", updatedAt: "2026-09-30T01:00:00.000Z" }] });
let saved: CitadelStructureSnapshot, root: Root, container: HTMLDivElement, scope: string, control: ReturnType<typeof useCitadelBlueprint>;
function Harness() { control = useCitadelBlueprint(scope); return <p>{control.attempt.message}</p>; }
async function render(next = scope) { scope = next; await act(async () => root.render(<Harness />)); }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function prepare() { await act(async () => control.changeText(JSON.stringify(blueprint))); await act(async () => control.validate()); await act(async () => control.setConfirmImport(true)); }
async function apply() { let result!: boolean; await act(async () => { result = await control.applyImport(); }); return result; }
beforeEach(async () => {
  vi.resetAllMocks(); api.base = "http://gateway-one"; __resetBlueprintAttemptsForTests(); __resetSessionDraftsForTests(); saved = initial(); scope = "one";
  api.listCitadels.mockResolvedValue({ items: [{ citadelId: "one", hasCharter: true }] }); api.exportCitadelBlueprint.mockResolvedValue(blueprint);
  api.getCitadelStructureSnapshot.mockImplementation(async () => structuredClone(saved)); api.validateCitadelBlueprint.mockResolvedValue({ ok: true, errors: [] });
  api.importCitadelBlueprint.mockImplementation(async () => { saved = receipt(saved); return structuredClone(saved); });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); await render();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); __resetBlueprintAttemptsForTests(); __resetSessionDraftsForTests(); });

describe("shared Blueprint lifecycle", () => {
  it("cancels Gateway installation round trips during preflight without writes", async () => {
    await prepare(); const read = deferred<CitadelStructureSnapshot>(); api.getCitadelStructureSnapshot.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.applyImport(); });
    api.base = "http://gateway-two"; await render(); api.base = "http://gateway-one"; await render();
    await act(async () => { read.resolve(saved); await pending; }); expect(api.importCitadelBlueprint).not.toHaveBeenCalled(); expect(control.locked).toBe(false); expect(control.importText).toBe(JSON.stringify(blueprint));
  });
  it("retains the origin import lock and both drafts when installation changes during readback", async () => {
    await prepare(); const read = deferred<CitadelStructureSnapshot>(); api.getCitadelStructureSnapshot.mockResolvedValueOnce(saved).mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.applyImport(); });
    api.base = "http://gateway-two"; await render(); await act(async () => control.changeText("Second Gateway draft"));
    await act(async () => { read.resolve(saved); await pending; }); expect(blueprintLocked("one", "http://gateway-one")).toBe(true); expect(control.importText).toBe("Second Gateway draft");
    api.base = "http://gateway-one"; await render(); expect(control.attempt.phase).toBe("uncertain"); expect(control.importText).toBe(JSON.stringify(blueprint)); expect(control.blueprintDraft.isDirty).toBe(true);
  });
  it("requires validation, review and confirmation then confirms the exact import and independent owner", async () => {
    await act(async () => control.changeText(JSON.stringify(blueprint))); expect(await apply()).toBe(false); expect(api.importCitadelBlueprint).not.toHaveBeenCalled();
    await act(async () => control.validate()); expect(await apply()).toBe(false); expect(api.importCitadelBlueprint).not.toHaveBeenCalled();
    await act(async () => control.setConfirmImport(true)); expect(await apply()).toBe(true);
    expect(api.importCitadelBlueprint).toHaveBeenCalledExactlyOnceWith("one", blueprint, "a".repeat(64));
    expect(api.getCitadelStructureSnapshot).toHaveBeenCalledTimes(3); expect(control.importState.done).toBe(true); expect(control.importText).toBe(""); expect(blueprintLocked("one")).toBe(false);
  });
  it("cancel and post-validation text changes cannot dispatch the earlier import", async () => {
    await prepare(); await act(async () => control.setConfirmImport(false)); expect(await apply()).toBe(false);
    await act(async () => { control.setConfirmImport(true); control.changeText("{}"); }); expect(await apply()).toBe(false); expect(api.importCitadelBlueprint).not.toHaveBeenCalled();
  });
  it("withholds a changed structure before dispatch and preserves the submitted draft", async () => {
    await prepare(); saved = { ...saved, revision: "c".repeat(64) }; expect(await apply()).toBe(false);
    expect(api.importCitadelBlueprint).not.toHaveBeenCalled(); expect(control.importText).toBe(JSON.stringify(blueprint)); expect(control.canApply).toBe(false); expect(control.importState.error).toContain("Validate again");
  });
  it("allows only one pending write and retains a lost response across remount and returning scope", async () => {
    await prepare(); const response = deferred<CitadelStructureSnapshot>(); api.importCitadelBlueprint.mockReturnValue(response.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.applyImport(); });
    expect(await apply()).toBe(false); expect(api.importCitadelBlueprint).toHaveBeenCalledOnce();
    await act(async () => root.unmount()); root = createRoot(container); await render("two"); await render("one");
    expect(control.locked).toBe(true);
    await act(async () => { response.resolve({ ...receipt(saved), citadelId: "foreign" }); await pending; });
    expect(control.attempt.phase).toBe("uncertain"); expect(control.importText).toBe(JSON.stringify(blueprint)); expect(await apply()).toBe(false);
  });
  it.each(["foreign", "missing-readback", "changed-charter", "lost-old-chamber", "extra-chamber"])("retains uncertainty for %s receipt or owner evidence", async (failure) => {
    await prepare(); api.importCitadelBlueprint.mockImplementation(async () => {
      const after = receipt(saved); if (failure === "foreign") after.citadelId = "foreign";
      if (failure === "changed-charter") after.charter!.purpose = "Unexpected purpose";
      if (failure === "lost-old-chamber") after.chambers = after.chambers.filter(item => item.chamberId !== "old");
      if (failure === "extra-chamber") after.chambers.push({ ...after.chambers[0]!, chamberId: "extra" });
      if (failure !== "missing-readback") saved = after;
      return after;
    });
    expect(await apply()).toBe(false); expect(control.attempt.phase).toBe("uncertain"); expect(control.importState.done).toBe(false); expect(control.importText).toBe(JSON.stringify(blueprint));
  });
  it("unlocks only an exact prewrite revision conflict; generic and committed conflicts stay unknown", async () => {
    await prepare(); api.importCitadelBlueprint.mockRejectedValueOnce({ status: 409, body: { code: "WRITE_CONFLICT", details: { reason: "CITADEL_STRUCTURE_REVISION_CONFLICT" } } });
    expect(await apply()).toBe(false); expect(control.locked).toBe(false); expect(control.canApply).toBe(false);
    await prepare(); api.importCitadelBlueprint.mockRejectedValueOnce({ status: 409, body: { code: "WRITE_CONFLICT", mutationCommitted: true, details: { reason: "CITADEL_STRUCTURE_REVISION_CONFLICT" } } });
    expect(await apply()).toBe(false); expect(control.attempt.phase).toBe("uncertain");
  });
  it("cancels validation and preflight after scope changes away and back", async () => {
    await act(async () => control.changeText(JSON.stringify(blueprint))); const validation = deferred<{ ok: boolean; errors: string[] }>(); api.validateCitadelBlueprint.mockReturnValueOnce(validation.promise);
    let checking!: Promise<void>; await act(async () => { checking = control.validate(); }); await render("two"); await render("one");
    await act(async () => { validation.resolve({ ok: true, errors: [] }); await checking; }); expect(control.canApply).toBe(false);
    await prepare(); const read = deferred<CitadelStructureSnapshot>(); api.getCitadelStructureSnapshot.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.applyImport(); }); await render("two"); await render("one");
    await act(async () => { read.resolve(saved); await pending; }); expect(api.importCitadelBlueprint).not.toHaveBeenCalled(); expect(blueprintLocked("one")).toBe(false);
  });
  it("cancels deferred preflight when the operator leaves the import and returns", async () => {
    await act(async () => control.setView("import")); await prepare(); const read = deferred<CitadelStructureSnapshot>(); api.getCitadelStructureSnapshot.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.applyImport(); });
    await act(async () => control.setView("export")); await act(async () => control.setView("import"));
    await act(async () => { read.resolve(saved); await pending; }); expect(api.importCitadelBlueprint).not.toHaveBeenCalled(); expect(control.canApply).toBe(false); expect(blueprintLocked("one")).toBe(false);
  });
  it("acknowledges a late confirmed origin without erasing newer draft text", async () => {
    await prepare(); const response = deferred<CitadelStructureSnapshot>(); api.importCitadelBlueprint.mockReturnValueOnce(response.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.applyImport(); });
    await act(async () => control.blueprintDraft.setValue("Newer draft text")); saved = receipt(saved);
    await act(async () => { response.resolve(saved); await pending; }); expect(control.importText).toBe("Newer draft text"); expect(control.blueprintDraft.isDirty).toBe(true); expect(control.locked).toBe(false);
  });
  it("matches setup's real default Chamber reset and excludes derived hasCharter", () => {
    const before = initial(); before.record = { citadelId: "one", name: "One", slug: "one", kind: "team", lifecycleStatus: "active", revision: "d".repeat(64), createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z", hasCharter: false };
    const after = receipt(before); after.record = { ...before.record, hasCharter: true };
    expect(blueprintImportMatches(before, blueprint, after)).toBe(true); after.charter!.defaultChamberId = "old"; expect(blueprintImportMatches(before, blueprint, after)).toBe(false);
  });
  it("keeps newer input and scope changes from being overwritten by a late file read", async () => {
    const text = deferred<string>(); let read!: Promise<void>;
    await act(async () => { read = control.loadFile({ size: 500, text: () => text.promise }); });
    await act(async () => control.changeText("Newer text")); await act(async () => { text.resolve(JSON.stringify(blueprint)); await read; });
    expect(control.importText).toBe("Newer text");
    const next = deferred<string>(); await act(async () => { read = control.loadFile({ size: 500, text: () => next.promise }); });
    await render("two"); await render("one"); await act(async () => { next.resolve("Old scope file"); await read; });
    expect(control.importText).toBe("Newer text"); expect(api.importCitadelBlueprint).not.toHaveBeenCalled();
  });
  it("withholds oversized files and loading an export preserves an existing dirty import", async () => {
    const read = vi.fn(async () => "{}"); await act(async () => control.loadFile({ size: 1_048_577, text: read })); expect(read).not.toHaveBeenCalled();
    expect(control.importState.error).toContain("1 MiB"); await act(async () => control.changeText("Kept import"));
    await act(async () => control.loadExportForImport()); expect(control.importText).toBe("Kept import"); expect(control.importState.error).toContain("preserved");
  });
});
