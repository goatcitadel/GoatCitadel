// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { __resetApprovalOperationAttemptsForTests } from "./approval-operation-attempts";
import { ApprovalAuditRecovery } from "./ApprovalAuditRecovery";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { refuseNetwork } from "../../../test/refuse-network";
const api = vi.hoisted(() => ({
  replay: vi.fn(),
  lifecycle: vi.fn(),
  run: vi.fn(),
  timeline: vi.fn(),
  resume: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchApprovalReplay: api.replay,
  fetchRuntimeLifecycle: api.lifecycle,
  fetchDurableRun: api.run,
  fetchDurableRunTimeline: api.timeline,
  resumeDurableRun: api.resume,
  fetchDevDiagnostics: vi.fn(),
}));
// The recovery names its workspace from the workspace list.
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: vi.fn(async () => ({ items: [] })),
}));
refuseNetwork();
const approval = {
  approvalId: "approval",
  kind: "tool.invoke",
  status: "approved",
  payload: {},
  preview: {},
  linkage: { workspaceId: "one", durableRunId: "original" },
  createdAt: "now",
} as ApprovalRequest;
const run = {
  runId: "original",
  workflowKey: "orchestration.plan.execute",
  status: "paused",
  version: 2,
  payload: { workspaceId: "one" },
  updatedAt: "now",
};
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  __resetApprovalOperationAttemptsForTests();
  api.replay.mockResolvedValue({ approval, events: [], effects: [] });
  api.lifecycle.mockResolvedValue({ approval, canonical: { approvalId: "approval", runId: "original" }, linked: {} });
  api.run.mockResolvedValue(run);
  api.timeline.mockResolvedValue({ items: [] });
  api.resume.mockResolvedValue(run);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalAuditRecovery approval={approval} workspaceId="one" />
      </QueryClientProvider>,
    ),
  );
  await click("Audit and recovery");
  await vi.waitFor(() => expect(host.textContent).toContain("Original linked work: Paused"));
}
async function click(name: string) {
  const button = [...document.querySelectorAll("button")].find(
    (item) => !item.closest('[aria-hidden="true"]') && item.textContent === name,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
it("rechecks the original canonical checkpoint, Cancel has no effect, and resume receipt remains distinct from resumed work", async () => {
  await render();
  await click("Resume paused run");
  await click("Cancel");
  expect(api.resume).not.toHaveBeenCalled();
  await click("Resume paused run");
  await click("Confirm resume");
  expect(api.resume).toHaveBeenCalledExactlyOnceWith("original", "operator");
  expect(host.textContent).toContain("Original linked work: Paused");
  expect(host.textContent).toContain("Resume requested");
});
it("blocks stale checkpoint and current scope changes", async () => {
  await render();
  await click("Resume paused run");
  api.run.mockResolvedValue({ ...run, version: 3 });
  await click("Confirm resume");
  expect(api.resume).not.toHaveBeenCalled();
  expect(host.textContent).toContain("checkpoint changed");
  await act(async () => notifyGatewayAccessChanged());
  expect(host.textContent).not.toContain("Original linked work");
});
it("retains uncertainty on lost resume response and never retries automatically", async () => {
  await render();
  api.resume.mockRejectedValue(new Error("response lost"));
  await click("Resume paused run");
  await click("Confirm resume");
  expect(host.textContent).toContain("Resume outcome is uncertain");
  expect(api.resume).toHaveBeenCalledTimes(1);
  expect(
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Resume paused run")?.disabled,
  ).toBe(true);
  await act(async () => root.render(null));
  await render();
  await click("Refresh audit and recovery");
  await click("Resume paused run");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).toContain("Resume outcome is uncertain");
  expect(api.resume).toHaveBeenCalledOnce();
});

it("does not lock after the owner refuses the resume request", async () => {
  await render();
  api.resume
    .mockRejectedValueOnce(
      new ApiRequestError("API error 409", { kind: "http", method: "POST", path: "/x", status: 409 }),
    )
    .mockResolvedValue(run);
  await click("Resume paused run");
  await click("Confirm resume");
  expect(host.textContent).toContain("This changed somewhere else");
  expect(host.textContent).not.toContain("uncertain");
  await click("Refresh audit and recovery");
  await click("Resume paused run");
  await click("Confirm resume");
  expect(api.resume).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Resume requested");
});

it.each(["changed", "unavailable"])(
  "permits explicit healthy refresh after an unsent %s preflight",
  async (failure) => {
    await render();
    await click("Resume paused run");
    if (failure === "changed") api.run.mockResolvedValue({ ...run, version: 3 });
    else api.run.mockRejectedValueOnce(new Error("Temporary read failure"));
    await click("Confirm resume");
    expect(api.resume).not.toHaveBeenCalled();
    await click("Refresh audit and recovery");
    await click("Resume paused run");
    await click("Confirm resume");
    expect(api.resume).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Resume requested");
  },
);

it("records a late lost response for the original scope after unmount", async () => {
  await render();
  let fail!: (error: Error) => void;
  api.resume.mockImplementation(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  await click("Resume paused run");
  await click("Confirm resume");
  await act(async () => root.render(null));
  await act(async () => fail(new Error("late lost response")));
  await render();
  await click("Resume paused run");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(api.resume).toHaveBeenCalledOnce();
});
it("describes decision history in plain words without actor ids, raw events or ISO times", async () => {
  api.replay.mockResolvedValue({
    approval,
    events: [
      {
        eventId: "e1",
        approvalId: "approval",
        eventType: "resolved",
        actorId: "operator:ana",
        timestamp: "2026-01-01T10:00:00.000Z",
        payload: {},
      },
    ],
    effects: [{ effectId: "f1", effectKind: "approval_wait_wake", status: "failed", lastError: "Run is gone" }],
  });
  await render();
  const text = host.textContent ?? "";
  expect(text).toContain("Decision recorded · An operator ·");
  expect(text).toContain("Follow-on work: Wake the waiting run · Failed · Run is gone");
  expect(text).toContain("Pending action: No pending action record");
  expect(text).not.toContain("operator:ana");
  expect(text).not.toContain("2026-01-01T10:00:00.000Z");
  expect(text).not.toContain("approval_wait_wake");
});
