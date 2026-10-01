// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitadelStructureSnapshot, CitadelTemplateSnapshot } from "@goatcitadel/contracts";
import { useCitadelOverview } from "./use-citadel-overview";
import { __resetCitadelStructureAttemptsForTests, citadelStructureAttempt, setCitadelStructureAttempt } from "./citadel-structure-state";
import { __resetSessionDraftsForTests } from "./session-drafts";
import { __resetWorkspaceAttemptsForTests } from "../settings/workspace-editor-state";
import { __resetFormDirtyRegistryForTests } from "./use-form-dirty";

const api = vi.hoisted(() => ({ base: "http://gateway-one", createCitadelFromTemplate: vi.fn(), getCitadelGatehouse: vi.fn(), getCitadelStructureSnapshot: vi.fn(), listCitadelTemplates: vi.fn(), upsertCitadelCharter: vi.fn(), listCitadels: vi.fn(), fetchWorkspaces: vi.fn(), archiveCitadel: vi.fn(), restoreCitadel: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.base }));
vi.mock("@goatcitadel/mission-control-shared/components/ui/GCModal", () => ({ GCModal: ({ children }: { children: ReactNode }) => <>{children}</> }));
const initial = (): CitadelStructureSnapshot => ({ citadelId: "one", revision: "a".repeat(64), charter: { citadelId: "one", purpose: "Original purpose", kind: "team", goals: ["Goal"], boundaries: ["Boundary"], successDefinition: ["Success"], riskPosture: "balanced", modelPolicyDefault: "hybrid_guarded", defaultChamberId: "old", createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" },
  chambers: [{ chamberId: "old", citadelId: "one", name: "Retained", sensitivity: "private", sealed: true, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" }] });
const template: CitadelTemplateSnapshot = { id: "personal-template", revision: "c".repeat(64), name: "Personal", description: "Reviewed template", kind: "personal", purpose: "Template purpose", goals: ["Template goal"], boundaries: [], successDefinition: [], chambers: [{ name: "New Chamber" }] };
let saved: CitadelStructureSnapshot, scope: string, view: string, control: ReturnType<typeof useCitadelOverview>, root: Root, container: HTMLDivElement;
function Harness() { control = useCitadelOverview(scope, view); return <p>{control.attempt.message}</p>; }
async function render(next = scope, nextView = view) { scope = next; view = nextView; await act(async () => root.render(<Harness />)); }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function prepare() { await act(async () => { control.openEditor(); control.changePurpose("Reviewed purpose"); }); await act(async () => control.requestCharter()); }
async function confirm() { let result!: boolean; await act(async () => { result = await control.confirm(); }); return result; }
beforeEach(async () => {
  vi.resetAllMocks(); api.base = "http://gateway-one"; __resetCitadelStructureAttemptsForTests(); __resetSessionDraftsForTests(); __resetWorkspaceAttemptsForTests(); __resetFormDirtyRegistryForTests();
  saved = initial(); scope = "one"; view = "charter";
  api.getCitadelStructureSnapshot.mockImplementation(async () => structuredClone(saved)); api.getCitadelGatehouse.mockResolvedValue({ citadelId: "one" }); api.listCitadelTemplates.mockResolvedValue([template]);
  api.upsertCitadelCharter.mockImplementation(async (_id, input) => { const { expectedRevision: _revision, ...charter } = input; saved = { ...saved, revision: "b".repeat(64), charter: { ...saved.charter!, ...charter, updatedAt: "2026-09-30T01:00:00.000Z" } }; return structuredClone(saved); });
  api.createCitadelFromTemplate.mockImplementation(async () => { saved = { ...saved, revision: "b".repeat(64), charter: { citadelId: "one", purpose: template.purpose, kind: template.kind, goals: template.goals, boundaries: template.boundaries, successDefinition: template.successDefinition, riskPosture: "balanced", modelPolicyDefault: "hybrid_guarded", createdAt: "2026-09-30T01:00:00.000Z", updatedAt: "2026-09-30T01:00:00.000Z" },
    chambers: [...saved.chambers, { chamberId: "new", citadelId: "one", name: "New Chamber", sensitivity: "private", sealed: false, createdAt: "2026-09-30T01:00:00.000Z", updatedAt: "2026-09-30T01:00:00.000Z" }] }; return structuredClone(saved); });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); await render();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe("shared Citadel Overview lifecycle", () => {
  it("reviews immutable purpose with unchanged Charter fields and confirms independent owner", async () => {
    expect(await confirm()).toBe(false); await prepare(); expect(api.upsertCitadelCharter).not.toHaveBeenCalled(); expect(control.review?.kind).toBe("charter");
    expect(await confirm()).toBe(true); expect(api.upsertCitadelCharter).toHaveBeenCalledExactlyOnceWith("one", { purpose: "Reviewed purpose", kind: "team", goals: ["Goal"], boundaries: ["Boundary"], successDefinition: ["Success"], defaultChamberId: "old", riskPosture: "balanced", modelPolicyDefault: "hybrid_guarded", expectedRevision: "a".repeat(64) });
    expect(saved.charter?.defaultChamberId).toBe("old"); expect(control.charterDraft.isDirty).toBe(false); expect(control.attempt.phase).toBe("idle");
  });
  it("cancel, typing, and stale revision withhold the earlier submission", async () => {
    await prepare(); await act(async () => control.cancelReview()); expect(await confirm()).toBe(false);
    await prepare(); await act(async () => control.changePurpose("New purpose")); expect(await confirm()).toBe(false);
    await prepare(); saved = { ...saved, revision: "d".repeat(64) }; expect(await confirm()).toBe(false); expect(api.upsertCitadelCharter).not.toHaveBeenCalled(); expect(control.charterDraft.value).toBe("Reviewed purpose"); expect(control.charterDraft.hasRemoteChanges).toBe(true);
  });
  it.each(["scope", "view", "installation"])("cancels deferred preflight on %s navigation", async change => {
    await prepare(); const read = deferred<CitadelStructureSnapshot>(); api.getCitadelStructureSnapshot.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.confirm(); });
    if (change === "scope") { await render("two"); await render("one"); }
    if (change === "view") { await render("one", "chambers"); await render("one", "charter"); }
    if (change === "installation") { api.base = "http://gateway-two"; await render(); api.base = "http://gateway-one"; await render(); }
    await act(async () => { read.resolve(initial()); await pending; }); expect(api.upsertCitadelCharter).not.toHaveBeenCalled(); expect(citadelStructureAttempt("one", "http://gateway-one").phase).toBe("idle");
  });
  it("prevents duplicate dispatch and preserves unknown outcome across remount", async () => {
    await prepare(); const write = deferred<CitadelStructureSnapshot>(); api.upsertCitadelCharter.mockReturnValueOnce(write.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.confirm(); }); expect(await confirm()).toBe(false); expect(api.upsertCitadelCharter).toHaveBeenCalledOnce();
    await act(async () => root.unmount()); root = createRoot(container); await render(); expect(control.locked).toBe(true);
    await act(async () => { write.resolve({ ...initial(), citadelId: "foreign" }); await pending; }); expect(control.attempt.phase).toBe("uncertain"); expect(control.charterDraft.value).toBe("Reviewed purpose"); expect(await confirm()).toBe(false);
  });
  it("shares uncertain Blueprint admission with Charter and template actions", async () => {
    await act(async () => setCitadelStructureAttempt("one", { phase: "uncertain", message: "Prior import unknown" }));
    await prepare(); expect(control.review).toBeNull(); expect(await confirm()).toBe(false); expect(api.upsertCitadelCharter).not.toHaveBeenCalled();
    saved = { ...initial(), charter: null }; await act(async () => control.reload()); await act(async () => control.requestTemplate(template)); expect(control.review).toBeNull(); expect(api.createCitadelFromTemplate).not.toHaveBeenCalled();
  });
  it.each(["foreign", "fields", "chambers", "readback", "committed-conflict"])("retains uncertain %s evidence", async failure => {
    await prepare(); api.upsertCitadelCharter.mockImplementationOnce(async () => {
      if (failure === "committed-conflict") throw { status: 409, body: { code: "WRITE_CONFLICT", mutationCommitted: true, details: { reason: "CITADEL_STRUCTURE_REVISION_CONFLICT" } } };
      const receipt = { ...initial(), revision: "b".repeat(64), charter: { ...initial().charter!, purpose: "Reviewed purpose" } };
      if (failure === "foreign") receipt.citadelId = "foreign";
      if (failure === "fields") receipt.charter.goals = ["Unreviewed goal"];
      if (failure === "chambers") receipt.chambers = [];
      if (failure !== "readback") saved = receipt;
      return receipt;
    });
    expect(await confirm()).toBe(false); expect(control.attempt.phase).toBe("uncertain"); expect(control.charterDraft.isDirty).toBe(true);
  });
  it("acknowledges a late exact save only in its origin, retaining newer typing", async () => {
    await prepare(); const write = deferred<CitadelStructureSnapshot>(); api.upsertCitadelCharter.mockReturnValueOnce(write.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.confirm(); }); await act(async () => control.charterDraft.setValue("New unsent purpose"));
    saved = { ...initial(), revision: "b".repeat(64), charter: { ...initial().charter!, purpose: "Reviewed purpose" } };
    await act(async () => { write.resolve(saved); await pending; }); expect(control.charterDraft.value).toBe("New unsent purpose"); expect(control.charterDraft.isDirty).toBe(true); expect(control.locked).toBe(false);
  });
  it("keeps the original installation uncertain when it changes during readback", async () => {
    await prepare(); const read = deferred<CitadelStructureSnapshot>(); api.getCitadelStructureSnapshot.mockResolvedValueOnce(initial()).mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.confirm(); }); api.base = "http://gateway-two"; await render();
    await act(async () => control.charterDraft.setValue("Unsent second Gateway purpose"));
    await act(async () => { read.resolve(saved); await pending; }); expect(citadelStructureAttempt("one", "http://gateway-one").phase).toBe("uncertain"); expect(control.charterDraft.value).toBe("Unsent second Gateway purpose");
    api.base = "http://gateway-one"; await render(); expect(control.charterDraft.value).toBe("Reviewed purpose"); expect(control.charterDraft.isDirty).toBe(true);
  });
  it("reviews an exact template before adding Chambers with normalized defaults", async () => {
    saved = { ...initial(), charter: null }; await act(async () => control.reload()); await act(async () => control.requestTemplate(template));
    expect(api.createCitadelFromTemplate).not.toHaveBeenCalled(); expect(await confirm()).toBe(true);
    expect(api.createCitadelFromTemplate).toHaveBeenCalledExactlyOnceWith("one", template.id, "a".repeat(64), template.revision); expect(saved.chambers).toHaveLength(2);
  });
  it("withholds a changed template before dispatch and requires a new review", async () => {
    saved = { ...initial(), charter: null }; await act(async () => control.reload()); await act(async () => control.requestTemplate(template)); api.listCitadelTemplates.mockResolvedValueOnce([{ ...template, revision: "d".repeat(64) }]);
    expect(await confirm()).toBe(false); expect(api.createCitadelFromTemplate).not.toHaveBeenCalled(); expect(control.locked).toBe(false); expect(control.review).toBeNull();
  });
});
