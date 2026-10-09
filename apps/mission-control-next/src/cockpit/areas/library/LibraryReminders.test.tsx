import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteRecord } from "@goatcitadel/contracts";
import { completeReminder, createReminder, listReminders } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { LibraryReminders } from "./LibraryReminders";
vi.mock("@goatcitadel/mission-control-shared/api/personal-ops", () => ({ completeReminder: vi.fn(), createReminder: vi.fn(), listReminders: vi.fn() }));
const note: NoteRecord = { noteId: "note-a", workspaceId: "one", title: "Linked note", body: "", tags: [], sourceRefs: [], revision: 1, lifecycleStatus: "active", createdAt: "now", updatedAt: "now" };
const reminder = { reminderId: "r-a", workspaceId: "one", title: "Review note", dueAt: "2026-10-10T12:00:00Z", status: "scheduled" as const, createdAt: "now", updatedAt: "now" };
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { vi.resetAllMocks(); __resetApprovalOperationAttemptsForTests(); __resetSessionViewStateForTests(); __resetSessionDraftsForTests(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); vi.mocked(listReminders).mockResolvedValue({ items: [reminder] }); });
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); });
async function render() { await act(async () => root.render(<QueryClientProvider client={client}><LibraryReminders workspaceId="one" note={note} /></QueryClientProvider>)); await vi.waitFor(() => expect(container.textContent).toContain("Complete Review note")); }
async function click(name: string) { const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === name)!; await act(async () => button.click()); }
it("creates a note-associated reminder with UTC conversion and recurrence preserved", async () => {
  vi.mocked(createReminder).mockResolvedValue(reminder); await render(); const values = ["Review note", "2026-10-10T12:30", "FREQ=DAILY"];
  for (const [index, input] of [...container.querySelectorAll("input")].entries()) await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, values[index]); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await click("Schedule reminder"); expect(createReminder).toHaveBeenCalledExactlyOnceWith({ workspaceId: "one", title: "Review note", dueAt: new Date("2026-10-10T12:30").toISOString(), recurrenceRule: "FREQ=DAILY", sourceRef: "/library/notes?noteId=note-a&shell=cockpit" });
});
it("checks current scheduled state and rejects inconsistent completion receipts", async () => {
  vi.mocked(completeReminder).mockResolvedValue({ ...reminder, workspaceId: "other", status: "completed" }); await render(); await click("Complete Review note"); expect(completeReminder).toHaveBeenCalledExactlyOnceWith("r-a"); expect(container.textContent).toContain("Completion is not confirmed");
});
