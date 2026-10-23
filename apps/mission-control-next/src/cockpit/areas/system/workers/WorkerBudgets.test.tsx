// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetWorkerBudgetAttemptsForTests } from "../../../../features/native-routes/ops/worker-budget-attempts";
import { __resetSessionDraftsForTests } from "../../../../features/native-routes/library/session-drafts";
import { WorkerBudgets } from "./WorkerBudgets";
import { workerItem } from "./workers.test-data";

const api = vi.hoisted(() => ({
  fetchRemoteWorkerBudgets: vi.fn(),
  authorizeRemoteWorkerBudget: vi.fn(),
  revokeRemoteWorkerBudget: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/remote-worker-budgets", () => api);
vi.mock("../../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));

const grant = (overrides: Record<string, unknown> = {}) => ({
  grant: {
    grantId: "grant-1",
    registryWorkspaceId: "ws",
    executionWorkspaceId: "ws",
    workerId: "w1",
    workerGeneration: 3,
    maxRequests: 10,
    maxCostMicrousd: 2_000_000,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    operatorId: "op",
    createdAt: "2026-10-23T08:00:00.000Z",
    revision: 1,
    ...overrides,
  },
  heldRequests: 0,
  heldCostMicrousd: 0,
  settledRequests: 1,
  settledCostMicrousd: 500_000,
  availableRequests: 9,
  availableCostMicrousd: 1_500_000,
});
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  __resetSessionDraftsForTests();
  resetWorkerBudgetAttemptsForTests();
  api.fetchRemoteWorkerBudgets.mockResolvedValue([grant()]);
  api.revokeRemoteWorkerBudget.mockResolvedValue({});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = async (worker = workerItem("w1")) => {
  await act(async () => root.render(<WorkerBudgets workspaceId="ws" workspaceName="Aurora" worker={worker} />));
};
const button = (label: string, scope: ParentNode = host) =>
  [...scope.querySelectorAll("button")].find((node) => node.textContent === label)!;
// happy-dom does not submit a form from its submit button; submit the form the button belongs to.
const review = async () => {
  expect(button("Review budget").type).toBe("submit");
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
};
const type = async (label: string, value: string) => {
  const field = [...host.querySelectorAll("label")].find((node) => node.textContent?.startsWith(label))!;
  const input = field.querySelector("input, select") as HTMLInputElement;
  await act(async () => {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};

it("authorizes only after the review, with the exact limits and generation, then reads budgets again", async () => {
  api.authorizeRemoteWorkerBudget.mockImplementation(async (request: Record<string, unknown>) => ({
    ...request,
    revision: 1,
  }));
  await render();
  await act(async () => button("New budget").click());
  await type("Provider request limit", "5");
  await type("Dollar limit", "1.25");
  await review();
  expect(api.authorizeRemoteWorkerBudget).not.toHaveBeenCalled();
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Aurora");
  await act(async () => button("Authorize budget", dialog).click());
  expect(api.authorizeRemoteWorkerBudget).toHaveBeenCalledWith(
    expect.objectContaining({ workerId: "w1", workerGeneration: 3, maxRequests: 5, maxCostMicrousd: 1_250_000 }),
  );
  await vi.waitFor(() => expect(api.fetchRemoteWorkerBudgets).toHaveBeenCalledTimes(2));
});

it("says budgets are unavailable when they cannot be read", async () => {
  api.fetchRemoteWorkerBudgets.mockRejectedValue(new Error("offline"));
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("budgets are unavailable"));
});

it("disables the budget form for a contained worker and says why", async () => {
  await render(workerItem("w1", { posture: "quarantined" }));
  await act(async () => button("New budget").click());
  expect(host.querySelector("fieldset")?.disabled).toBe(true);
  expect(host.textContent).toContain("Only an active worker can be given a spending budget.");
});

it("keeps an unconfirmed authorization across unmount and retries the same grant", async () => {
  api.authorizeRemoteWorkerBudget.mockRejectedValue(new Error("timeout"));
  await render();
  await act(async () => button("New budget").click());
  await type("Provider request limit", "5");
  await type("Dollar limit", "1");
  await review();
  await act(async () => button("Authorize budget", host.querySelector('[role="dialog"]')!).click());
  const first = api.authorizeRemoteWorkerBudget.mock.calls[0]![0];
  act(() => root.unmount());
  root = createRoot(host);
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Authorization outcome unconfirmed"));
  expect(button("New budget")).toBeUndefined();
  await act(async () => button("Review pending authorization").click());
  await act(async () => button("Authorize budget", host.querySelector('[role="dialog"]')!).click());
  expect(api.authorizeRemoteWorkerBudget.mock.calls[1]![0]).toEqual(first);
});

it("revokes a budget only after the danger confirmation", async () => {
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Authorized"));
  await act(async () => button("Revoke budget").click());
  expect(api.revokeRemoteWorkerBudget).not.toHaveBeenCalled();
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("cannot be undone here");
  await act(async () => button("Revoke budget", dialog).click());
  expect(api.revokeRemoteWorkerBudget).toHaveBeenCalledExactlyOnceWith("ws", "grant-1", 1);
});
