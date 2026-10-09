// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentProfileRecord } from "@goatcitadel/contracts";
import { fetchAgent, createAgentProfile, updateAgentProfile, archiveAgentProfile } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { LibraryAgentEditor } from "./LibraryAgentEditor";
vi.mock("@goatcitadel/mission-control-shared/api/operators-agents-files", () => ({ fetchAgent: vi.fn(), createAgentProfile: vi.fn(), updateAgentProfile: vi.fn(), archiveAgentProfile: vi.fn(), restoreAgentProfile: vi.fn() }));
const agent: AgentProfileRecord = { agentId: "a", roleId: "custom", name: "Agent", title: "Role", summary: "Summary", specialties: ["testing"], aliases: [], defaultTools: [], isBuiltin: false, editable: true, lifecycleStatus: "active", status: "idle", sessionCount: 0, activeSessions: 0, createdAt: "now", updatedAt: "one" };
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { vi.resetAllMocks(); __resetSessionDraftsForTests(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); vi.mocked(fetchAgent).mockResolvedValue(agent); });
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); });
async function render(agentId: string | undefined = "a") { await act(async () => root.render(<QueryClientProvider client={client}><LibraryAgentEditor agentId={agentId} workspaceId="one" /></QueryClientProvider>)); await vi.waitFor(() => expect(container.querySelector("input")).toBeTruthy()); await vi.waitFor(() => expect(client.isFetching()).toBe(0)); }
async function click(name: string) { const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => !item.closest('[aria-hidden="true"]') && (item.getAttribute("aria-label") ?? item.textContent) === name)!; expect(button).toBeTruthy(); await act(async () => button.click()); }
it("preserves profile defaults while saving through the owner and retains its portal receipt after refresh", async () => {
  vi.mocked(updateAgentProfile).mockResolvedValue({ ...agent, updatedAt: "two" }); await render(); await click("Review agent save"); await click("Confirm agent change"); await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  expect(updateAgentProfile).toHaveBeenCalledExactlyOnceWith("a", { name: "Agent", title: "Role", summary: "Summary", specialties: ["testing"], aliases: [], defaultTools: [] });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("profile saved");
});
it("rejects a changed canonical profile before mutation and leaves settled feedback in the real portal", async () => {
  await render(); await click("Review agent save"); vi.mocked(fetchAgent).mockResolvedValue({ ...agent, updatedAt: "two" }); await click("Confirm agent change"); await act(async () => { await client.invalidateQueries(); });
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("changed during review"); expect(updateAgentProfile).not.toHaveBeenCalled();
});
it("archive and restore use owner receipts; cancellation performs no write", async () => {
  vi.mocked(archiveAgentProfile).mockResolvedValue({ ...agent, lifecycleStatus: "archived" }); await render(); await click("Review agent archive"); await click("Close dialog"); expect(archiveAgentProfile).not.toHaveBeenCalled(); await click("Review agent archive"); await click("Confirm agent change"); expect(archiveAgentProfile).toHaveBeenCalledExactlyOnceWith("a");
});
it("keeps noneditable built-in profiles locked", async () => {
  vi.mocked(fetchAgent).mockResolvedValue({ ...agent, isBuiltin: true, editable: false }); await render(); await click("Review agent save"); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(createAgentProfile).not.toHaveBeenCalled(); expect(updateAgentProfile).not.toHaveBeenCalled();
});
