// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CitadelMasonSettings } from "./CitadelMasonSettings";
import { masonSession, masonBlueprint, masonSummary, masonStructure, stagedMasonStructure, deferredMason } from "../../../features/native-routes/library/mason.test-support";
import { resetMasonAttemptsForTests } from "../../../features/native-routes/library/mason-session-state";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import { __resetCitadelStructureAttemptsForTests } from "../../../features/native-routes/library/citadel-structure-state";
const api = vi.hoisted(() => ({ createMasonSession: vi.fn(), getMasonSession: vi.fn(), getMasonSetupQuestions: vi.fn(), sendMasonMessage: vi.fn(), updateMasonSessionAnswers: vi.fn(), draftMasonBlueprint: vi.fn(), draftBlueprintFromMasonSession: vi.fn(), reviewMasonBlueprint: vi.fn(), getCitadelStructureSnapshot: vi.fn(), stageMasonBlueprint: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("../../ui/Dialog", () => ({ Dialog: ({ open, title, children, onOpenChange }: { open: boolean; title: string; children: ReactNode; onOpenChange: (open: boolean) => void }) => open ? <div role="dialog" aria-label={title}><button type="button" onClick={() => onOpenChange(false)}>Dismiss dialog</button>{children}</div> : null }));
let root: Root, container: HTMLDivElement, owner = masonSession(), structure = masonStructure();
function button(label: string, within: Element = container) { const found = [...within.querySelectorAll("button")].find(item => item.textContent === label); if (!found) throw new Error(`Missing ${label}`); return found; }
async function click(label: string, within?: Element) { await act(async () => button(label, within).click()); }
async function field(label: string, value: string) { const element = [...container.querySelectorAll("label")].find(item => item.textContent?.startsWith(label))?.querySelector("input,select,textarea") as HTMLInputElement; if (!element) throw new Error(`Missing field ${label}`); await act(async () => { const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!; setter.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); }); }
beforeEach(async () => {
  vi.resetAllMocks(); resetMasonAttemptsForTests(); __resetSessionDraftsForTests(); __resetSessionViewStateForTests(); __resetCitadelStructureAttemptsForTests(); owner = masonSession(); structure = masonStructure();
  api.getMasonSetupQuestions.mockResolvedValue(["Purpose?"]); api.createMasonSession.mockImplementation(async () => structuredClone(owner)); api.getMasonSession.mockImplementation(async () => structuredClone(owner));
  api.updateMasonSessionAnswers.mockImplementation(async (_id, patch) => { owner = { ...owner, answers: patch }; return structuredClone(owner); }); api.draftMasonBlueprint.mockResolvedValue(masonBlueprint);
  api.draftBlueprintFromMasonSession.mockImplementation(async () => { owner = { ...owner, status: "drafted" }; return masonBlueprint; }); api.reviewMasonBlueprint.mockResolvedValue(masonSummary);
  api.getCitadelStructureSnapshot.mockImplementation(async () => structuredClone(structure)); api.stageMasonBlueprint.mockImplementation(async () => { structure = stagedMasonStructure(structure); return { citadel: structuredClone(structure), review: masonSummary }; });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); await act(async () => root.render(<CitadelMasonSettings citadelId="one" />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe("native Mason", () => {
  it("shows the honest session/global and no-CAS boundary", () => { expect(container.textContent).toContain("global setup records"); expect(container.textContent).toContain("no atomic revision guard"); expect(button("Start setup").disabled).toBe(false); });
  it("requires answer review, cancel is zero-write, and structured save avoids model inference", async () => {
    await click("Start setup"); await field("Kind", "team"); await field("Purpose", "Run the team"); await click("Review answers");
    const dialog = container.querySelector('[role="dialog"]')!; expect(dialog.textContent).toContain("Run the team"); await click("Cancel", dialog); expect(api.updateMasonSessionAnswers).not.toHaveBeenCalled();
    await click("Review answers"); await click("Save reviewed answers"); expect(api.updateMasonSessionAnswers).toHaveBeenCalledOnce(); expect(api.sendMasonMessage).not.toHaveBeenCalled();
  });
  it("reviews actual structure before explicit staging, with cancel preserving the Citadel", async () => {
    await click("Start setup"); await field("Kind", "team"); await field("Purpose", "Run the team"); await click("Review answers"); await click("Save reviewed answers");
    await click("Draft & review Blueprint"); await click("Review staging"); const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("One"); expect(dialog.textContent).toContain("Run the team"); await click("Cancel", dialog); expect(api.stageMasonBlueprint).not.toHaveBeenCalled();
    await click("Review staging"); await click("Stage reviewed Blueprint"); expect(api.stageMasonBlueprint).toHaveBeenCalledExactlyOnceWith("one", masonBlueprint, "a".repeat(64)); expect(container.textContent).toContain("Blueprint staged and confirmed");
  });
  it("dismissing answer review during the fresh read cancels admission with zero writes", async () => {
    await click("Start setup"); await field("Kind", "team"); await field("Purpose", "Run the team"); await click("Review answers");
    const read = deferredMason<typeof owner>(); api.getMasonSession.mockReturnValueOnce(read.promise);
    await click("Save reviewed answers"); await click("Dismiss dialog");
    await act(async () => { read.resolve(owner); await read.promise; });
    expect(api.updateMasonSessionAnswers).not.toHaveBeenCalled(); expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("Unsaved structured answers");
  });
});
