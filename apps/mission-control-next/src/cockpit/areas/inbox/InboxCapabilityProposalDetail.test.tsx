// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CapabilityProposalDetailRecord, OperatorInboxItem, OperatorInboxResponse } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentCapabilityProposal, InboxCapabilityProposalDetail } from "./InboxCapabilityProposalDetail";

const api = vi.hoisted(() => ({ fetchCapabilityProposal: vi.fn(), fetchOperatorInbox: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => ({ fetchCapabilityProposal: api.fetchCapabilityProposal }));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({ fetchOperatorInbox: api.fetchOperatorInbox }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }) }));

const item: OperatorInboxItem = {
  id: "capability_proposal:proposal-a", kind: "capability_proposal", group: "proposals",
  title: "Review skill proposal", summary: "A proposed skill", createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T01:00:00.000Z", source: { workspaceId: "workspace-a", proposalId: "proposal-a" },
  href: "/library/capabilities?shell=classic",
};
const detail: CapabilityProposalDetailRecord = {
  proposal: {
    proposalId: "proposal-a", proposalKind: "skill", status: "proposed", title: "Review skill proposal",
    summary: "A proposed skill", candidateId: "candidate-a", payload: { workspaceId: "workspace-a" },
    createdAt: item.createdAt, updatedAt: item.updatedAt!,
  },
  events: [],
};
const projection = { workspaceId: "workspace-a", items: [item] } as OperatorInboxResponse;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

beforeEach(() => {
  api.fetchCapabilityProposal.mockReset().mockResolvedValue(detail);
  api.fetchOperatorInbox.mockReset().mockResolvedValue(projection);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear(); });

async function render(selected = item) {
  await act(async () => root.render(<QueryClientProvider client={client}><InboxCapabilityProposalDetail item={selected} workspaceId="workspace-a" /></QueryClientProvider>));
  await settle();
}

describe("Inbox capability proposal detail", () => {
  it("shows current scoped owner metadata without offering an unsupported decision", async () => {
    await render();
    expect(api.fetchOperatorInbox).toHaveBeenCalledWith("workspace-a");
    expect(api.fetchCapabilityProposal).toHaveBeenCalledWith("proposal-a");
    expect(container.textContent).toContain("A candidate is linked to this proposal");
    expect(container.textContent).toContain("Decisions for this proposal are unavailable in Inbox");
    expect(container.textContent).not.toContain("workspace-a");
  });

  it("does not fetch global proposal detail for a foreign or missing Inbox item", async () => {
    api.fetchOperatorInbox.mockResolvedValueOnce({ ...projection, items: [] });
    await render();
    expect(api.fetchCapabilityProposal).not.toHaveBeenCalled();
    expect(container.textContent).toContain("no longer in the selected workspace Inbox");
  });

  it("hides foreign, resolved, and changed owner records", () => {
    expect(currentCapabilityProposal(item, projection, detail, "workspace-a")).toBe(detail);
    expect(currentCapabilityProposal(item, projection, { ...detail, proposal: { ...detail.proposal, payload: { workspaceId: "other" } } }, "workspace-a")).toBeNull();
    expect(currentCapabilityProposal(item, projection, { ...detail, proposal: { ...detail.proposal, status: "approved" } }, "workspace-a")).toBeNull();
    expect(currentCapabilityProposal(item, projection, { ...detail, proposal: { ...detail.proposal, updatedAt: "later" } }, "workspace-a")).toBeNull();
    expect(currentCapabilityProposal(item, { ...projection, items: [{ ...item, updatedAt: "later" }] }, detail, "workspace-a")).toBeNull();
    expect(currentCapabilityProposal(item, { ...projection, items: [{ ...item, source: { ...item.source, workspaceId: "other" } }] }, detail, "workspace-a")).toBeNull();
  });
});
