// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchImportedAgentCatalog, importAgencyAgentCatalog } from "@goatcitadel/mission-control-shared/api/agent-catalog";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { fetchTraceMemoryCandidates, fetchTraceMemoryCandidate, promoteTraceMemoryCandidate } from "@goatcitadel/mission-control-shared/api/memory";
import { LibraryImportedAgents } from "./LibraryImportedAgents";
import { LibraryMemoryProposals } from "./LibraryMemoryProposals";
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ search: "", navigate: vi.fn() }) }));
vi.mock("@goatcitadel/mission-control-shared/api/agent-catalog", () => ({ fetchImportedAgentCatalog: vi.fn(), fetchImportedAgentCatalogEntry: vi.fn(), importAgencyAgentCatalog: vi.fn(), patchImportedAgentCatalogState: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/settings", () => ({ fetchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/memory", () => ({ fetchTraceMemoryCandidates: vi.fn(), fetchTraceMemoryCandidate: vi.fn(), promoteTraceMemoryCandidate: vi.fn(), rejectTraceMemoryCandidate: vi.fn() }));
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { vi.resetAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); });
async function render(child: ReactNode) { await act(async () => root.render(<QueryClientProvider client={client}>{child}</QueryClientProvider>)); }
function button(name: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => !item.closest('[aria-hidden="true"]') && (item.getAttribute("aria-label") ?? item.textContent) === name)!; }
async function click(name: string) { expect(button(name)).toBeTruthy(); await act(async () => button(name).click()); }
it("retains canonical catalog import receipt after settled invalidation without claiming session activation", async () => {
  vi.mocked(fetchImportedAgentCatalog).mockResolvedValue({ workspaceId: "one", divisions: [], items: [] });
  vi.mocked(importAgencyAgentCatalog).mockResolvedValue({ workspaceId: "one", importedCount: 2, repoUrl: "https://example.test/catalog", ref: "main", parseCounts: { unsupported: 1 } } as Awaited<ReturnType<typeof importAgencyAgentCatalog>>);
  await render(<LibraryImportedAgents workspaceId="one" />); await vi.waitFor(() => expect(button("Review catalog import").disabled).toBe(false));
  await click("Review catalog import"); await click("Confirm catalog request"); await act(async () => { await client.invalidateQueries(); });
  expect(importAgencyAgentCatalog).toHaveBeenCalledExactlyOnceWith({ workspaceId: "one" }); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Import does not activate a Chat specialist");
});
it("retains an uncertain catalog failure and cancels a later review without repeating the owner call", async () => {
  vi.mocked(fetchImportedAgentCatalog).mockResolvedValue({ workspaceId: "one", divisions: [], items: [] }); vi.mocked(importAgencyAgentCatalog).mockRejectedValue(new Error("Connection lost"));
  await render(<LibraryImportedAgents workspaceId="one" />); await vi.waitFor(() => expect(button("Review catalog import").disabled).toBe(false)); await click("Review catalog import"); await click("Confirm catalog request");
  await act(async () => { await client.invalidateQueries(); }); expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("not confirmed"); await click("Close dialog"); await click("Review catalog import"); await click("Close dialog"); expect(importAgencyAgentCatalog).toHaveBeenCalledOnce();
});
it("blocks promotion when canonical proposal changed and keeps the reviewed insight in its portal", async () => {
  const candidate = { candidateId: "candidate-a", workspaceId: "one", status: "proposed", proposedInsight: "Reviewed insight", authority: "operator", sourceRefs: [] } as unknown as Awaited<ReturnType<typeof fetchTraceMemoryCandidate>>;
  vi.mocked(fetchSettings).mockResolvedValue({ features: { memoryLifecycleAdminV1Enabled: true } } as Awaited<ReturnType<typeof fetchSettings>>);
  vi.mocked(fetchTraceMemoryCandidates).mockResolvedValue({ items: [candidate] }); vi.mocked(fetchTraceMemoryCandidate).mockResolvedValue({ ...candidate, proposedInsight: "Changed insight" });
  await render(<LibraryMemoryProposals workspaceId="one" />); await vi.waitFor(() => expect(button("Review promotion")?.disabled).toBe(false)); await click("Review promotion"); await click("Confirm memory promotion"); await act(async () => { await client.invalidateQueries(); });
  expect(promoteTraceMemoryCandidate).not.toHaveBeenCalled(); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Reviewed insight"); expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("changed during review");
});