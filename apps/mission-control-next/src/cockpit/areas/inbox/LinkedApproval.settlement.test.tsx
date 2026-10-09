// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { LinkedApproval } from "./LinkedApproval";
import { InboxApprovalDetail } from "./InboxApprovalDetail";
const api = vi.hoisted(() => ({ read: vi.fn(), replay: vi.fn(), run: vi.fn(), lifecycle: vi.fn(), resolve: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: api.read,
  fetchApprovalReplay: api.replay,
  resolveApproval: api.resolve,
}));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({ fetchDurableRun: api.run }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({fetchApprovalReplay:api.replay,fetchRuntimeLifecycle:api.lifecycle,fetchDurableRun:api.run,resolveApproval:api.resolve}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "active" }),
}));
let root: Root, host: HTMLDivElement, client: QueryClient;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  client?.clear();
});
it("keeps the current canonical decision and linked execution visible after leaving the pending projection", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.history.replaceState(null, "", "/inbox?approvalId=a");
  const approval = {
    approvalId: "a",
    status: "pending",
    kind: "tool_invoke",
    riskLevel: "caution",
    payload: {},
    createdAt: "2026-10-05T00:00:00Z",
    linkage: { workspaceId: "active", durableRunId: "original-run" },
  };
  api.read.mockResolvedValue(approval);
  const render = async (queued: boolean) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          {queued ? (
            <InboxApprovalDetail
              workspaceId="active"
              item={{
                id: "approval:a",
                kind: "approval",
                group: "needs_decision",
                title: "Current action",
                summary: "",
                createdAt: approval.createdAt,
                source: { workspaceId: "active", approvalId: "a" },
                href: "/inbox?approvalId=a",
              }}
            />
          ) : (
            <LinkedApproval approvalId="a" />
          )}
        </QueryClientProvider>,
      ),
    );
  await render(true);
  await vi.waitFor(() => expect(host.textContent).toContain("Current approval"));
  const settled = { ...approval, status: "approved", followUp: { status: "completed" } };
  api.read.mockResolvedValue(settled);
  api.replay.mockResolvedValue({ approval: settled, effects: [], events: [], durableRunId: "wait" });
  api.lifecycle.mockResolvedValue({approval:settled,canonical:{approvalId:"a",runId:"original-run"},turns:[]});
  api.run.mockImplementation(async id => id === "wait" ? {runId:"wait",workflowKey:"approval.wait",payload:{approvalId:"a"},status:"completed"} : {runId:"original-run",workflowKey:"orchestration.plan.execute",payload:{workspaceId:"active"},status:"completed"});
  // InboxArea switches to LinkedApproval when the refreshed pending projection removes this selection.
  await render(false);
  await vi.waitFor(() => expect(host.textContent).toContain("Original linked work: completed"));
  expect(host.textContent).toContain("Decision recorded: approved");
  expect(host.textContent).not.toContain("requires the full approval view");
  expect(api.read).toHaveBeenCalledWith("a", expect.objectContaining({ workspaceId: "active" }));
  expect(api.replay).toHaveBeenCalledWith("a");
  expect(api.run).toHaveBeenCalledWith("original-run");
  expect(api.resolve).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Approval wait settlement: completed");
  api.lifecycle.mockResolvedValue({approval:settled,canonical:{approvalId:"a",runId:"wait"},resolution:{runIdSource:"approval_wait_run"},turns:[]});
  await act(async()=>{await client.invalidateQueries({queryKey:["approval-settlement"]});});
  await vi.waitFor(()=>expect(host.textContent).toContain("No original durable execution was returned"));
  expect(host.textContent).not.toContain("Original linked work: completed");
});
