// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitadelAccessSnapshot } from "@goatcitadel/contracts";
import { CitadelCouncilSettings } from "./CitadelCouncilSettings";
import { __resetCitadelAccessAttemptsForTests } from "../../../features/native-routes/library/citadel-access-state";
import { overviewStructure } from "../../../features/native-routes/library/citadel-overview.test-support";
const api = vi.hoisted(() => ({ getCitadelAccessSnapshot: vi.fn(), assignCitadelCouncilAgent: vi.fn(), unassignCitadelCouncilAgent: vi.fn(), fetchAgents: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => "http://one" }));
vi.mock("../../ui/Dialog", () => ({ Dialog: ({ open, title, children }: { open: boolean; title: string; children: React.ReactNode }) => open ? <section role="dialog" aria-label={title}>{children}</section> : null }));
let root: Root, container: HTMLDivElement, owner: CitadelAccessSnapshot;
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === name)!;
async function click(name: string) { await act(async () => button(name).click()); }
beforeEach(async () => {
  vi.resetAllMocks(); __resetCitadelAccessAttemptsForTests();
  owner = { citadelId: "one", revision: "a".repeat(64), structure: { ...overviewStructure(), citadelId: "one" }, council: [], wards: [], members: [], passages: [], integrations: [] };
  api.getCitadelAccessSnapshot.mockImplementation(async () => structuredClone(owner)); api.fetchAgents.mockResolvedValue({ items: [{ agentId: "research", name: "Research", lifecycleStatus: "active" }] });
  api.assignCitadelCouncilAgent.mockImplementation(async () => { owner = { ...owner, revision: "b".repeat(64), council: [{ agentId: "research", assignmentId: "seat", citadelId: "one", createdAt: "now" }] }; return structuredClone(owner); });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); await act(async () => root.render(<CitadelCouncilSettings citadelId="one" />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe("native Council review", () => {
  it("shows exact scope/revision and changes membership only after an explicit confirmation", async () => {
    await click("Review Council seat"); const dialog = container.querySelector('[role="dialog"][aria-label="Seat this agent?"]')!;
    expect(dialog.textContent).toContain("research"); expect(dialog.textContent).toContain("one"); expect(dialog.textContent).toContain("a".repeat(64)); expect(api.assignCitadelCouncilAgent).not.toHaveBeenCalled();
    await click("Cancel"); expect(api.assignCitadelCouncilAgent).not.toHaveBeenCalled(); await click("Review Council seat"); await click("Confirm Council seat");
    expect(api.assignCitadelCouncilAgent).toHaveBeenCalledWith("one", "research", "a".repeat(64)); expect(container.textContent).toContain("Agent seated in this Citadel."); expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
  it("offers exact removal for a saved seat with an unavailable agent profile", async () => {
    owner = { ...owner, revision: "b".repeat(64), council: [{ agentId: "gone", assignmentId: "gone-seat", citadelId: "one", createdAt: "now" }] }; api.fetchAgents.mockResolvedValue({ items: [] });
    await click("Refresh rules"); await click("Refresh agents"); await click("Inspect gone");
    const inspection = container.querySelector('[role="dialog"][aria-label="Council seat"]')!;
    await act(async () => [...inspection.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === "Review seat removal")!.click());
    const dialog = container.querySelector('[role="dialog"][aria-label="Remove Council seat?"]'); expect(dialog?.textContent).toContain("gone"); expect(dialog?.textContent).toContain("b".repeat(64)); expect(api.unassignCitadelCouncilAgent).not.toHaveBeenCalled();
  });
});
