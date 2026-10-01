// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalityCatalogResponse, PersonalityPreset } from "@goatcitadel/contracts";
import { usePersonalityEditor } from "./use-personality-editor";
import { __resetPersonalityDefaultForTests } from "./use-personality-default";
import { __resetPersonalityEditorMutationForTests } from "./personality-editor-mutation";
import { __resetSessionDraftsForTests } from "../library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../library/use-form-dirty";

const api = vi.hoisted(() => ({ fetchPersonalities: vi.fn(), createPersonality: vi.fn(), updatePersonality: vi.fn(), deletePersonality: vi.fn(), setDefaultPersonality: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ ...api,
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error) }));
const preset = (id: string): PersonalityPreset => ({ id, label: id, category: "core", description: "", tone: "", style: "", systemOverlay: "",
  safetyNotes: ["Policy stays authoritative"], builtin: id !== "custom", visibility: id === "custom" ? "custom" : "builtin", soulFile: "", editable: id !== "default", modified: id === "operator" });
let owner: PersonalityCatalogResponse, root: Root, container: HTMLDivElement, control: ReturnType<typeof usePersonalityEditor>;
function Probe() { control = usePersonalityEditor(); return null; }
async function render() { await act(async () => root.render(<Probe />)); await vi.waitFor(() => expect(control.loading).toBe(false)); }
async function select(id: string) { await act(async () => control.personalityTransitionGuard.requestTransition({ kind: "select", id })); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const conflict = (committed = false) => ({ status: 409, body: { code: "WRITE_CONFLICT", mutationCommitted: committed, details: { reason: "PERSONALITY_CATALOG_REVISION_CONFLICT" } } });
beforeEach(() => {
  vi.resetAllMocks(); __resetPersonalityDefaultForTests(); __resetPersonalityEditorMutationForTests(); __resetSessionDraftsForTests();
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in personality editor test"))));
  owner = { revision: "a".repeat(64), defaultPersonalityId: "default", items: [preset("default"), preset("operator"), preset("custom")] };
  api.fetchPersonalities.mockImplementation(async () => owner);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); __resetPersonalityEditorMutationForTests(); __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests(); vi.unstubAllGlobals(); });

describe("shared personality editor owner lifecycle", () => {
  it("binds custom creation to the exact catalog and prevents duplicate dispatch", async () => {
    const result = deferred<PersonalityCatalogResponse>(); api.createPersonality.mockReturnValue(result.promise);
    await render(); await act(async () => control.beginCustomPersonality());
    await act(async () => { control.updateDraft("id", "new-voice"); control.updateDraft("label", "New voice"); });
    let saving!: Promise<boolean>;
    await act(async () => { saving = control.savePersonality(); });
    await act(async () => { await control.savePersonality(); });
    expect(api.createPersonality).toHaveBeenCalledOnce();
    const input = api.createPersonality.mock.calls[0]![0]; expect(input.expectedRevision).toBe("a".repeat(64));
    owner = { ...owner, revision: "b".repeat(64), items: [...owner.items, { ...preset("custom"), ...input, id: "new-voice" }] };
    await act(async () => { result.resolve(owner); await saving; });
    expect(control.data?.revision).toBe(owner.revision); expect(control.editorOpen).toBe(false);
    expect(control.notice?.message).toBe("Custom personality created."); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not close or replace a newer editor when an older creation completes", async () => {
    const result = deferred<PersonalityCatalogResponse>(); api.createPersonality.mockReturnValue(result.promise);
    await render(); await act(async () => control.beginCustomPersonality());
    await act(async () => { control.updateDraft("id", "new-voice"); control.updateDraft("label", "New voice"); });
    let saving!: Promise<boolean>; await act(async () => { saving = control.savePersonality(); });
    await select("operator");
    await act(async () => control.leave.dialogProps.onContinue());
    expect(control.selectedPersonalityId).toBe("operator");
    const input = api.createPersonality.mock.calls[0]![0];
    owner = { ...owner, revision: "b".repeat(64), items: [...owner.items, { ...preset("custom"), ...input, id: "new-voice" }] };
    await act(async () => { result.resolve(owner); await saving; });
    expect(control.editorOpen).toBe(true); expect(control.selectedPersonalityId).toBe("operator"); expect(control.draft.id).toBe("operator");
  });
  it("retains an unknown outcome lock across unmount and blocks both editing and default changes", async () => {
    api.updatePersonality.mockRejectedValue(new Error("Connection ended after dispatch"));
    await render(); await select("operator");
    await act(async () => control.updateDraft("label", "Retained voice"));
    await act(async () => { await control.savePersonality(); });
    expect(control.mutation.uncertain).toContain("Connection ended");
    await act(async () => root.render(<p>Another route</p>)); await render(); await select("operator");
    expect(control.draft.label).toBe("Retained voice"); expect(control.canSave).toBe(false);
    await act(async () => { await control.savePersonality(); control.defaultSelection.requestReview("operator"); });
    expect(api.updatePersonality).toHaveBeenCalledOnce(); expect(control.defaultSelection.review).toBeNull();
  });
  it("requires explicit rebase after a definite precommit catalog conflict", async () => {
    api.updatePersonality.mockRejectedValue(conflict());
    await render(); await select("operator"); await act(async () => control.updateDraft("label", "Preserved"));
    owner = { ...owner, revision: "b".repeat(64) };
    await act(async () => { await control.savePersonality(); });
    expect(control.mutation.uncertain).toBeUndefined(); expect(control.hasCatalogConflict).toBe(true); expect(control.draft.label).toBe("Preserved");
    await act(async () => { await control.savePersonality(); }); expect(api.updatePersonality).toHaveBeenCalledOnce();
    await act(async () => { control.editor.rebaseToCurrent(); control.setCatalogConflict(null); });
    expect(control.editor.baseRevision).toBe(owner.revision); expect(control.hasCatalogConflict).toBe(false);
  });
  it("keeps a committed-marked conflict uncertain and rejects a mismatched success receipt", async () => {
    api.updatePersonality.mockRejectedValue(conflict(true)); await render(); await select("operator");
    await act(async () => { await control.savePersonality(); }); expect(control.mutation.uncertain).toBeTruthy();
    await act(async () => __resetPersonalityEditorMutationForTests());
    api.updatePersonality.mockResolvedValue({ ...owner, revision: "b".repeat(64), items: owner.items.filter((item) => item.id !== "operator") });
    await act(async () => { await control.savePersonality(); }); expect(control.mutation.uncertain).toContain("submitted personality identity");
  });
  it("withholds stale removal confirmation and never edits the locked default", async () => {
    await render(); await select("default"); expect(control.editorLocked).toBe(true);
    await act(async () => { await control.savePersonality(); }); expect(api.updatePersonality).not.toHaveBeenCalled();
    await select("custom"); await act(async () => control.setPendingRemove({ id: "custom", label: "custom", builtin: false, expectedRevision: owner.revision }));
    owner = { ...owner, revision: "b".repeat(64) }; await act(async () => { await control.reload(); });
    await act(async () => { await control.removeOrResetPersonality(); }); expect(api.deletePersonality).not.toHaveBeenCalled();
  });
});
