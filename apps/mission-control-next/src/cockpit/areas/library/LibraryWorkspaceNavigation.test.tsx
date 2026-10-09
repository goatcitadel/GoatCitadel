// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentProfileRecord, NoteRecord } from "@goatcitadel/contracts";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
import { listNotes, listReminders, createNote } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { fetchAgents, fetchAgent, createAgentProfile } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { LibraryNotesWorkspace } from "./LibraryNotesWorkspace";
import { LibraryAgentsWorkspace } from "./LibraryAgentsWorkspace";
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ activeWorkspaceId: "one", activeCitadelId: "personal", showTechnicalDetails: false }) }));
vi.mock("@goatcitadel/mission-control-shared/api/personal-ops", () => ({ listNotes: vi.fn(), listReminders: vi.fn(), createNote: vi.fn(), listNoteRevisions: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/operators-agents-files", () => ({ fetchAgents: vi.fn(), fetchAgent: vi.fn(), createAgentProfile: vi.fn() }));
const note: NoteRecord = { noteId: "a", workspaceId: "one", title: "Existing A", body: "Body", tags: [], sourceRefs: [], revision: 1, lifecycleStatus: "active", createdAt: "now", updatedAt: "now" };
const agent: AgentProfileRecord = { agentId: "a", roleId: "custom", name: "Existing A", title: "Role", summary: "Summary", specialties: [], aliases: [], defaultTools: [], isBuiltin: false, editable: true, lifecycleStatus: "active", status: "idle", sessionCount: 0, activeSessions: 0, createdAt: "now", updatedAt: "now" };
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { vi.resetAllMocks(); __resetFormDirtyRegistryForTests(); __resetSessionDraftsForTests(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); vi.mocked(listNotes).mockResolvedValue({ items: [note, { ...note, noteId: "b", title: "Existing B" }] }); vi.mocked(listReminders).mockResolvedValue({ items: [] }); vi.mocked(fetchAgents).mockResolvedValue({ items: [agent, { ...agent, agentId: "b", name: "Existing B" }] }); vi.mocked(fetchAgent).mockImplementation(async id => ({ ...agent, agentId: id, name: id === "a" ? "Existing A" : "Existing B" })); });
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); __resetFormDirtyRegistryForTests(); __resetSessionDraftsForTests(); });
async function click(name: string) { const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => !item.closest('[aria-hidden="true"]') && (item.getAttribute("aria-label") ?? item.textContent) === name)!; expect(button).toBeTruthy(); await act(async () => button.click()); }
async function input(label: string, value: string) { const id = [...container.querySelectorAll("label")].find(item => item.textContent?.startsWith(label))!.htmlFor; const element = document.getElementById(id) as HTMLInputElement; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function render(kind: "notes" | "agents") { window.history.replaceState(null, "", `/library/${kind}?${kind === "notes" ? "noteId" : "agentId"}=a&shell=cockpit`); await act(async () => root.render(<QueryClientProvider client={client}><CockpitNavigationProvider>{kind === "notes" ? <LibraryNotesWorkspace workspaceId="one" /> : <LibraryAgentsWorkspace workspaceId="one" />}</CockpitNavigationProvider></QueryClientProvider>)); await vi.waitFor(() => expect(container.querySelector('[aria-label$="editor"] h2')?.textContent).toBe("Existing A")); }
it.each(["notes", "agents"] as const)("%s commits same-record and different-record selection after clean creation", async kind => {
  await render(kind); const create = kind === "notes" ? "New note" : "New agent profile";
  for (const suffix of ["A", "B"]) { await click(create); await click(`Open Existing ${suffix}`); await vi.waitFor(() => expect(container.querySelector('[aria-label$="editor"] h2')?.textContent).toBe(`Existing ${suffix}`)); expect(window.location.search).toContain(`Id=${suffix.toLowerCase()}`); }
});
it.each(["notes", "agents"] as const)("%s keeps dirty creation on Cancel, commits Keep without losing draft, and Discard clears only that draft", async kind => {
  await render(kind); const create = kind === "notes" ? "New note" : "New agent profile", field = kind === "notes" ? "Note title" : "Agent name";
  await click(create); await input(field, "Retained creation"); await click("Open Existing A"); await click("Cancel"); expect(container.querySelector('[aria-label$="editor"] h2')?.textContent).toBe(create);
  await click("Open Existing A"); await click("Keep draft and close"); await vi.waitFor(() => expect(container.querySelector('[aria-label$="editor"] h2')?.textContent).toBe("Existing A")); await click(create); expect([...container.querySelectorAll("input")].some(item => item.value === "Retained creation")).toBe(true);
  await click("Open Existing B"); await click("Discard changes"); await vi.waitFor(() => expect(container.querySelector('[aria-label$="editor"] h2')?.textContent).toBe("Existing B")); await click(create); expect([...container.querySelectorAll("input")].some(item => item.value === "Retained creation")).toBe(false);
});
it("commits an existing note selection after a successful create receipt closes", async () => {
  await render("notes"); await click("New note"); await input("Note title", "Created"); vi.mocked(createNote).mockResolvedValue({ ...note, noteId: "created", title: "Created" }); await click("Review note save"); await click("Confirm note save"); await click("Close dialog"); await click("Open Existing A"); await vi.waitFor(() => expect(container.querySelector('[aria-label="Note editor"] h2')?.textContent).toBe("Existing A")); expect(createNote).toHaveBeenCalledOnce();
});
it("commits an existing agent selection after a successful create receipt closes", async () => {
  await render("agents"); await click("New agent profile"); await input("Role ID", "created"); await input("Agent name", "Created"); await input("Agent title", "Role");
  const id = [...container.querySelectorAll("label")].find(item => item.textContent?.startsWith("Agent summary"))!.htmlFor; const area = document.getElementById(id)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "Summary"); area.dispatchEvent(new Event("input", { bubbles: true })); });
  vi.mocked(createAgentProfile).mockResolvedValue({ ...agent, agentId: "created", roleId: "created", name: "Created" }); await click("Review agent save"); await click("Confirm agent change"); await click("Close dialog"); await click("Open Existing A"); await vi.waitFor(() => expect(container.querySelector('[aria-label="Agent profile editor"] h2')?.textContent).toBe("Existing A")); expect(createAgentProfile).toHaveBeenCalledOnce();
});
it.each(["notes", "agents"] as const)("%s follows mounted clean Back and Forward between record and creation", async kind => {
  await render(kind); const create = kind === "notes" ? "New note" : "New agent profile";
  await click(create); await act(async () => { window.history.back(); });
  await vi.waitFor(() => expect(container.querySelector('[aria-label$="editor"] h2')?.textContent).toBe("Existing A"));
  await act(async () => { window.history.forward(); }); await vi.waitFor(() => expect(container.querySelector('[aria-label$="editor"] h2')?.textContent).toBe(create));
});
it.each(["notes", "agents"] as const)("%s holds dirty Back for Cancel and Keep, then restores retained creation on Forward", async kind => {
  await render(kind); const create = kind === "notes" ? "New note" : "New agent profile", field = kind === "notes" ? "Note title" : "Agent name";
  await click(create); await input(field, "History draft"); const creationUrl = window.location.href;
  await act(async () => { window.history.back(); }); await click("Cancel"); expect(window.location.href).toBe(creationUrl); expect(container.querySelector('[aria-label$="editor"] h2')?.textContent).toBe(create);
  await act(async () => { window.history.back(); }); await click("Keep draft and close"); await vi.waitFor(() => expect(container.querySelector('[aria-label$="editor"] h2')?.textContent).toBe("Existing A"));
  await act(async () => { window.history.forward(); }); await vi.waitFor(() => expect(container.querySelector('[aria-label$="editor"] h2')?.textContent).toBe(create)); expect([...container.querySelectorAll("input")].some(item => item.value === "History draft")).toBe(true);
  await act(async () => { window.history.back(); }); await click("Discard changes"); await act(async () => { window.history.forward(); }); await vi.waitFor(() => expect(container.querySelector('[aria-label$="editor"] h2')?.textContent).toBe(create)); expect([...container.querySelectorAll("input")].some(item => item.value === "History draft")).toBe(false);
});