import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteRecord } from "@goatcitadel/contracts";
import { archiveNote, createNote, listNotes, listNoteRevisions, updateNote } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { LibraryNoteEditor } from "./LibraryNoteEditor";
vi.mock("@goatcitadel/mission-control-shared/api/personal-ops", () => ({ archiveNote: vi.fn(), createNote: vi.fn(), listNotes: vi.fn(), listNoteRevisions: vi.fn(), updateNote: vi.fn() }));
const note: NoteRecord = { noteId: "a", workspaceId: "one", title: "Original", body: "Original body", revision: 1, lifecycleStatus: "active", tags: [], sourceRefs: ["source-a"], createdAt: "now", updatedAt: "now" };
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { vi.resetAllMocks(); __resetApprovalOperationAttemptsForTests(); __resetSessionViewStateForTests(); __resetSessionDraftsForTests(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); vi.mocked(listNotes).mockResolvedValue({ items: [note] }); });
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); });
async function render(value: NoteRecord | undefined = note) { await act(async () => root.render(<QueryClientProvider client={client}><LibraryNoteEditor note={value} workspaceId="one" available onClose={vi.fn()} /></QueryClientProvider>)); }
async function click(name: string) { const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => !item.closest('[aria-hidden="true"]') && (item.getAttribute("aria-label") ?? item.textContent) === name)!; expect(button).toBeTruthy(); await act(async () => button.click()); }
async function title(value: string) { const input = container.querySelector("input")!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
it("saves the exact reviewed revision and retains success inside the real dialog after canonical refresh", async () => {
  const saved = { ...note, title: "Edited", revision: 2 }; vi.mocked(updateNote).mockResolvedValue(saved);
  await render(); await title("Edited"); await click("Review note save"); await click("Confirm note save");
  expect(updateNote).toHaveBeenCalledExactlyOnceWith("a", { workspaceId: "one", title: "Edited", body: "Original body", expectedRevision: 1 });
  await render(saved); await act(async () => { await client.invalidateQueries(); });
  expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toContain("Canonical version 2");
});
it("blocks stale preflight, preserves dirty input and keeps error through refreshed props", async () => {
  await render(); await title("My draft"); await click("Review note save");
  vi.mocked(listNotes).mockResolvedValue({ items: [{ ...note, revision: 2, title: "Someone else" }] });
  await click("Confirm note save"); await render({ ...note, revision: 2, title: "Someone else" });
  await act(async () => { await client.invalidateQueries(); });
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("changed during review");
  expect(updateNote).not.toHaveBeenCalled(); await click("Close dialog");
  expect(container.querySelector("input")?.value).toBe("My draft");
  await click("Discard note changes"); expect(container.querySelector("input")?.value).toBe("Someone else");
});
it("archive confirms the target and requires the canonical archived receipt", async () => {
  vi.mocked(archiveNote).mockResolvedValue({ ...note, lifecycleStatus: "archived", revision: 2 });
  await render(); await click("Review archive"); await click("Confirm archive");
  expect(archiveNote).toHaveBeenCalledExactlyOnceWith("a", "one");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Original archived");
});
it("cancelling review writes nothing and history renders owner provenance", async () => {
  vi.mocked(listNoteRevisions).mockResolvedValue({ items: [{ ...note, source: "operator", actorId: "operator-a", contentHash: "hash-a" }] });
  await render(); await click("Review note save"); await click("Close dialog"); expect(updateNote).not.toHaveBeenCalled(); expect(createNote).not.toHaveBeenCalled();
  await click("Note history"); await vi.waitFor(() => expect(container.textContent).toContain("operator-a"));
  expect(listNoteRevisions).toHaveBeenCalledExactlyOnceWith("a", "one"); expect(container.textContent).not.toContain("hash-a");
});
