// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CuratorReviewItem, OperatorInboxItem, OperatorInboxResponse } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canDecideImprovementProposal, InboxImprovementProposalDetail } from "./InboxImprovementProposalDetail";

const api = vi.hoisted(() => ({
  fetchCuratorReviewItem: vi.fn(), approveImprovementCandidate: vi.fn(), rejectImprovementCandidate: vi.fn(), fetchOperatorInbox: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/improvement", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({ fetchOperatorInbox: api.fetchOperatorInbox }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }) }));

const item: OperatorInboxItem = {
  id: "improvement_proposal:candidate-a", kind: "improvement_proposal", group: "proposals", title: "Review improvement proposal",
  summary: "Improve routing", createdAt: "2026-09-28T00:00:00.000Z",
  source: { workspaceId: "workspace-a", proposalId: "candidate-a" }, href: "/library/curator?shell=classic",
};
const review = {
  candidate: { candidateId: "candidate-a", workspaceId: "workspace-a", currentRevisionId: "revision-a", summary: "Improve routing", status: "ready_for_approval", updatedAt: "2026-09-28T00:00:00.000Z" },
  currentRevision: { candidateId: "candidate-a", revisionId: "revision-a", changeHash: "hash-a" },
  reviewPrecondition: { workspaceId: "workspace-a", expectedStatus: "ready_for_approval", expectedRevisionId: "revision-a", expectedChangeHash: "hash-a" },
  evidence: [], risk: "low", callableImpact: "none", corruptionStatus: "clean",
  actionStatuses: { approve: "ready", reject: "ready" }, disabledReasons: {},
} as unknown as CuratorReviewItem;
const projection = { workspaceId: "workspace-a", items: [item] } as OperatorInboxResponse;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const button = (label: string) => {
  const found = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

beforeEach(() => {
  api.fetchCuratorReviewItem.mockReset().mockResolvedValue(review);
  api.fetchOperatorInbox.mockReset().mockResolvedValue(projection);
  api.approveImprovementCandidate.mockReset().mockResolvedValue({ action: "approve", status: "approved", review: { ...review, candidate: { ...review.candidate, status: "approved" } } });
  api.rejectImprovementCandidate.mockReset().mockResolvedValue({ action: "reject", status: "rejected", review: { ...review, candidate: { ...review.candidate, status: "rejected" } } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear(); });

async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><InboxImprovementProposalDetail item={item} workspaceId="workspace-a" /></QueryClientProvider>));
  await settle();
}

describe("Inbox improvement proposal review", () => {
  it("requires a current scoped, ready and clean owner record", () => {
    expect(canDecideImprovementProposal(item, review, "workspace-a", "approve")).toBe(true);
    expect(canDecideImprovementProposal(item, { ...review, candidate: { ...review.candidate, workspaceId: "workspace-b" } }, "workspace-a", "approve")).toBe(false);
    expect(canDecideImprovementProposal(item, { ...review, corruptionStatus: "corrupt" }, "workspace-a", "approve")).toBe(false);
    expect(canDecideImprovementProposal(item, { ...review, actionStatuses: { ...review.actionStatuses, approve: "blocked" } }, "workspace-a", "approve")).toBe(false);
  });

  it("confirms keep only after fresh Inbox and owner reads", async () => {
    await render();
    await act(async () => button("Keep proposal").click());
    expect(api.approveImprovementCandidate).not.toHaveBeenCalled();
    await act(async () => button("Confirm keep").click());
    await settle();
    expect(api.fetchOperatorInbox).toHaveBeenCalledTimes(2);
    expect(api.fetchCuratorReviewItem).toHaveBeenCalledTimes(2);
    expect(api.approveImprovementCandidate).toHaveBeenCalledWith("candidate-a", { reviewPrecondition: review.reviewPrecondition });
    expect(container.textContent).toContain("Activation is a separate governed action");
  });

  it("withholds a decision if the reviewed candidate changed", async () => {
    await render();
    api.fetchCuratorReviewItem.mockResolvedValueOnce({ ...review, candidate: { ...review.candidate, summary: "Changed" } });
    await act(async () => button("Discard proposal").click());
    await act(async () => button("Confirm discard").click());
    await settle();
    expect(api.rejectImprovementCandidate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("action readiness changed");
  });

  it("locks another decision after an uncertain owner response", async () => {
    await render();
    api.rejectImprovementCandidate.mockRejectedValueOnce(new Error("Network lost"));
    await act(async () => button("Discard proposal").click());
    await act(async () => button("Confirm discard").click());
    await settle();
    expect(container.textContent).toContain("Decision outcome is uncertain");
    expect(container.textContent).not.toContain("Discard proposal");
    expect(api.rejectImprovementCandidate).toHaveBeenCalledTimes(1);
  });

  it("keeps older Gateway records inspectable without offering unbound decisions", async () => {
    api.fetchCuratorReviewItem.mockResolvedValue({ ...review, reviewPrecondition: undefined });
    await render();
    expect(container.textContent).toContain("Improve routing");
    expect(container.textContent).toContain("Update the Gateway");
    expect([...container.querySelectorAll("button")].map((entry) => entry.textContent)).not.toContain("Keep proposal");
    expect([...container.querySelectorAll("button")].map((entry) => entry.textContent)).not.toContain("Discard proposal");
    expect(api.approveImprovementCandidate).not.toHaveBeenCalled();
    expect(api.rejectImprovementCandidate).not.toHaveBeenCalled();
  });

  it("withholds an owner binding that differs from the displayed candidate revision", () => {
    expect(canDecideImprovementProposal(item, { ...review, reviewPrecondition: { ...review.reviewPrecondition!, expectedChangeHash: "new-hash" } }, "workspace-a", "approve")).toBe(false);
    expect(canDecideImprovementProposal(item, { ...review, reviewPrecondition: { ...review.reviewPrecondition!, workspaceId: "workspace-b" } }, "workspace-a", "reject")).toBe(false);
  });

  it("locks a receipt for a different candidate revision without claiming the reviewed version was saved", async () => {
    api.approveImprovementCandidate.mockResolvedValue({ action: "approve", status: "approved", review: {
      ...review, candidate: { ...review.candidate, status: "approved", currentRevisionId: "revision-b" },
    } });
    await render();
    await act(async () => button("Keep proposal").click());
    await act(async () => button("Confirm keep").click());
    await settle();
    expect(container.textContent).toContain("Decision outcome is uncertain");
    expect(container.textContent).not.toContain("Gateway approved the reviewed candidate");
  });
});
