import { resetWorkerBudgetAttemptsForTests } from "./worker-budget-attempts";
import { __resetSessionDraftsForTests } from "../library/session-drafts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteWorkerRegistryItem } from "@goatcitadel/contracts";
import { RemoteWorkerBudgetPanel } from "./RemoteWorkerBudgetPanel";
import {
  authorizeRemoteWorkerBudget,
  fetchRemoteWorkerBudgets,
} from "@goatcitadel/mission-control-shared/api/remote-worker-budgets";

vi.mock("@goatcitadel/mission-control-shared/api/remote-worker-budgets", () => ({
  fetchRemoteWorkerBudgets: vi.fn(async () => []),
  authorizeRemoteWorkerBudget: vi.fn(async (input) => ({
    ...input,
    revision: 1,
    operatorId: "operator",
    createdAt: new Date().toISOString(),
  })),
  revokeRemoteWorkerBudget: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/components/ui/GCModal", () => ({
  GCModal: (props: { open: boolean; onConfirm: () => void }) =>
    props.open ? (
      <button type="button" data-confirm="budget" onClick={props.onConfirm}>
        Authorize budget
      </button>
    ) : null,
}));
const worker = {
  workerId: "worker-a",
  admission: { value: { workerLabel: "Mini PC", workerGeneration: 3 } },
  posture: { value: "active" },
} as RemoteWorkerRegistryItem;
let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  __resetSessionDraftsForTests();
  resetWorkerBudgetAttemptsForTests();
  vi.clearAllMocks();
});

describe("worker budget panel", () => {
  it("requires review and explicit authorization of exact limits and worker generation", async () => {
    await act(async () => {
      renderer = create(<RemoteWorkerBudgetPanel workspaceId="workspace-a" worker={worker} />);
    });
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((node) => node.children.includes("New budget"))!
        .props.onClick();
    });
    const inputs = renderer.root.findAllByType("input");
    await act(async () => {
      inputs[0]!.props.onChange({ target: { value: "40" } });
      inputs[1]!.props.onChange({ target: { value: "5" } });
    });
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(authorizeRemoteWorkerBudget).not.toHaveBeenCalled();
    await act(async () => renderer.root.findByProps({ "data-confirm": "budget" }).props.onClick());
    expect(authorizeRemoteWorkerBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        registryWorkspaceId: "workspace-a",
        executionWorkspaceId: "workspace-a",
        workerId: "worker-a",
        workerGeneration: 3,
        maxRequests: 40,
        maxCostMicrousd: 5_000_000,
      }),
    );
    expect(fetchRemoteWorkerBudgets).toHaveBeenCalledTimes(2);
  });

  it("shows unknown balances on errors and disables grants for quarantined workers", async () => {
    vi.mocked(fetchRemoteWorkerBudgets).mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      renderer = create(
        <RemoteWorkerBudgetPanel
          workspaceId="workspace-a"
          worker={{ ...worker, posture: { ...worker.posture, value: "quarantined" } }}
        />,
      );
    });
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((node) => node.children.includes("New budget"))!
        .props.onClick();
    });
    expect(renderer.root.findByType("fieldset").props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("budgets are unavailable");
    expect(authorizeRemoteWorkerBudget).not.toHaveBeenCalled();
  });
  it("retains the same uncertain authorization through unmount and does not authorize a replacement", async () => {
    vi.mocked(authorizeRemoteWorkerBudget).mockRejectedValueOnce(new Error("lost response"));
    await act(async () => {
      renderer = create(<RemoteWorkerBudgetPanel workspaceId="workspace-a" worker={worker} />);
    });
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((node) => node.children.includes("New budget"))!
        .props.onClick();
    });
    await act(async () => {
      const inputs = renderer.root.findAllByType("input");
      inputs[0]!.props.onChange({ target: { value: "40" } });
      inputs[1]!.props.onChange({ target: { value: "5" } });
    });
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    await act(async () => renderer.root.findByProps({ "data-confirm": "budget" }).props.onClick());
    const first = vi.mocked(authorizeRemoteWorkerBudget).mock.calls[0]![0];
    await act(async () => renderer.unmount());
    await act(async () => {
      renderer = create(<RemoteWorkerBudgetPanel workspaceId="workspace-a" worker={worker} />);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("outcome unconfirmed");
    expect(renderer.root.findAllByType("button").some((node) => node.children.includes("New budget"))).toBe(false);
    await act(async () =>
      renderer.root
        .findAllByType("button")
        .find((node) => node.children.includes("Review pending authorization"))!
        .props.onClick(),
    );
    await act(async () => renderer.root.findByProps({ "data-confirm": "budget" }).props.onClick());
    expect(vi.mocked(authorizeRemoteWorkerBudget).mock.calls[1]![0]).toEqual(first);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("outcome unconfirmed");
  });
});
