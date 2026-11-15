// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetInboxApprovalAttemptsForTests } from "../inbox/inbox-approval-attempts";
import { refuseNetwork } from "../../../test/refuse-network";
import { __resetSettingsApprovalDialogsForTests, SettingsApprovalDialog } from "./SettingsApprovalDialog";

// The real dialog and the real decision bar: only the Gateway reads and the decision call are faked.
const api = vi.hoisted(() => ({ fetchApproval: vi.fn(), resolveApproval: vi.fn() }));
const preferences = vi.hoisted(() => ({ activeWorkspaceId: "default", showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ resolveApproval: api.resolveApproval }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: api.fetchApproval }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: vi.fn(async () => ({ items: [] })),
}));
vi.mock("../../../features/native-routes/projects/use-project-access", () => ({
  useProjectAccess: () => ({ identity: "access-1", current: () => true }),
}));
refuseNetwork();

const approval = (riskLevel: string): ApprovalRequest =>
  ({
    approvalId: "approval-a",
    kind: "file.write",
    riskLevel,
    status: "pending",
    payload: {},
    preview: { title: "Install Asana", summary: "Allow a host.", targets: ["workspace/note.txt"] },
    createdAt: "2026-09-28T00:00:00Z",
    explanationStatus: "pending",
  }) as ApprovalRequest;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const buttons = () =>
  [...document.body.querySelectorAll("button")].filter((entry) => !entry.closest('[aria-hidden="true"]'));
const button = (label: string) => buttons().find((entry) => entry.textContent?.trim() === label);
const labels = () => buttons().map((entry) => entry.textContent?.trim());

async function open(riskLevel: string, dangerReview: boolean) {
  api.fetchApproval.mockResolvedValue(approval(riskLevel));
  api.resolveApproval.mockResolvedValue({ approval: { ...approval(riskLevel), status: "approved" }, effects: [] });
  const onResolved = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SettingsApprovalDialog approvalId="approval-a" dangerReview={dangerReview} onResolved={onResolved} />
      </QueryClientProvider>,
    ),
  );
  for (let tick = 0; tick < 8; tick += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return onResolved;
}

beforeEach(() => {
  __resetInboxApprovalAttemptsForTests();
  __resetSettingsApprovalDialogsForTests();
  api.fetchApproval.mockReset();
  api.resolveApproval.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("a dialog that keeps the two-step review for danger", () => {
  it("shows the review button for a danger approval and decides nothing until the second click", async () => {
    const onResolved = await open("danger", true);
    expect(labels()).toContain("Review danger approval");
    expect(labels()).not.toContain("Approve once");
    await act(async () => button("Review danger approval")!.click());
    expect(api.resolveApproval).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(button("Approve once")).toBeDefined());
    expect(api.resolveApproval).not.toHaveBeenCalled();
    await act(async () => button("Approve once")!.click());
    await vi.waitFor(() => expect(api.resolveApproval).toHaveBeenCalledTimes(1));
    expect(api.resolveApproval.mock.calls[0]![0]).toBe("approval-a");
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it("keeps a caution approval to one click", async () => {
    const onResolved = await open("caution", true);
    expect(labels()).not.toContain("Review danger approval");
    await act(async () => button("Approve once")!.click());
    await vi.waitFor(() => expect(api.resolveApproval).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it("still asks for the typed confirmation on a nuclear approval", async () => {
    await open("nuclear", true);
    expect(labels()).toContain("Review nuclear approval");
    await act(async () => button("Review nuclear approval")!.click());
    await vi.waitFor(() => expect(document.body.querySelector("input")).not.toBeNull());
    expect(api.resolveApproval).not.toHaveBeenCalled();
    expect(button("Approve once")?.disabled ?? true).toBe(true);
  });

  it("leaves dialogs that did not ask for it as they were: danger approves in one click", async () => {
    await open("danger", false);
    expect(labels()).not.toContain("Review danger approval");
    expect(labels()).toContain("Approve once");
  });
});
