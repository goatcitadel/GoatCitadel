// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { AutonomousActivationGrantRecord, ChatProjectRecord } from "@goatcitadel/contracts";
import { notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
import { ProjectFanout } from "./ProjectFanout";
const preferences = vi.hoisted(() => ({ showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));
const api = vi.hoisted(() => ({ list: vi.fn(), projects: vi.fn(), create: vi.fn(), revoke: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchAutonomousActivationGrants: api.list,
  fetchChatProjects: api.projects,
  createAutonomousActivationGrant: api.create,
  revokeAutonomousActivationGrant: api.revoke,
}));
let root: Root, host: HTMLDivElement;
const project = (projectId = "project-a", revision = 2): ChatProjectRecord => ({
  projectId,
  revision,
  workspaceId: "workspace-a",
  name: projectId,
  description: "",
  workspacePath: "F:/authorized/project",
  lifecycleStatus: "active",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});
const grant = (projectId = "project-a"): AutonomousActivationGrantRecord => ({
  grantId: "grant-a",
  projectId,
  workspaceId: "workspace-a",
  status: "active",
  activationKinds: ["subagent_fanout"],
  surfaces: ["chat"],
  toolPatterns: ["agent.fanout"],
  capabilityPatterns: ["agent.fanout"],
  maxRiskLevel: "caution",
  usedActivations: 0,
  maxActivations: 3,
  usedBudgetUsd: 0,
  budgetUsd: 0.75,
  grantor: "server-stamped-caller",
  reason: "Synthetic grant",
  expiresAt: "2099-01-01T00:00:00Z",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});
async function render(value = project()) {
  await act(async () => root.render(<ProjectFanout project={value} workspaceId="workspace-a" citadelId="citadel-a" />));
}
async function click(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  expect(node, label).toBeDefined();
  await act(async () => node!.click());
}
beforeEach(() => {
  vi.clearAllMocks();
  preferences.showTechnicalDetails = false;
  api.list.mockResolvedValue({ items: [] });
  api.projects.mockResolvedValue({ items: [project()] });
  api.create.mockResolvedValue(grant());
  api.revoke.mockResolvedValue({ ...grant(), status: "revoked" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it("defaults to one hour and reviews exact scope/limits/expiry with Cancel0 and confirm1", async () => {
  const start = Date.now();
  await render();
  const input = host.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
  expect(Date.parse(input.value) - start).toBeGreaterThan(59 * 60_000);
  expect(Date.parse(input.value) - start).toBeLessThanOrEqual(60 * 60_000);
  await click("Review automatic fan-out");
  expect(api.create).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Medium risk");
  expect(document.body.textContent).not.toContain("Revision 2");
  expect(document.body.textContent).toContain("F:/authorized/project");
  preferences.showTechnicalDetails = true;
  await render();
  expect(document.body.textContent).toContain("agent.fanout");
  expect(document.body.textContent).toContain("Revision 2");
  expect(document.body.textContent).toContain("$0.75");
  await click("Cancel");
  expect(api.create).not.toHaveBeenCalled();
  await click("Review automatic fan-out");
  const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === "Confirm automatic fan-out",
  )!;
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  expect(api.projects).toHaveBeenCalledWith(
    "all",
    300,
    "workspace-a",
    "citadel-a",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(api.create).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "workspace-a",
    projectId: "project-a",
    surfaces: ["chat"],
    activationKinds: ["subagent_fanout"],
    capabilityPatterns: ["agent.fanout"],
    toolPatterns: ["agent.fanout"],
    maxRiskLevel: "caution",
    maxActivations: 3,
    budgetUsd: 0.75,
    grantor: "operator",
    reason: "Temporary automatic fan-out for this project.",
    expiresAt: new Date(input.value).toISOString(),
  });
});
it("validates an empty date before conversion and performs no write", async () => {
  await render();
  const input = host.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Review automatic fan-out");
  expect(host.textContent).toContain("Choose a future expiry");
  expect(api.create).not.toHaveBeenCalled();
});
it("rejects a canonical revision change discovered during confirmation", async () => {
  await render();
  await click("Review automatic fan-out");
  api.projects.mockResolvedValueOnce({ items: [project("project-a", 3)] });
  await click("Confirm automatic fan-out");
  expect(api.create).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Project changed during review");
});
it("rejects newly overlapping authority found during confirmation", async () => {
  await render();
  await click("Review automatic fan-out");
  api.list.mockResolvedValueOnce({ items: [grant()] });
  await click("Confirm automatic fan-out");
  expect(api.create).not.toHaveBeenCalled();
  expect(host.textContent).toContain("active grant now exists");
});
it("invalidates a reviewed grant on access change", async () => {
  await render();
  await click("Review automatic fan-out");
  await act(async () => notifyGatewayAccessChanged());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(api.create).not.toHaveBeenCalled();
});
it("does not display a late list or write from another project", async () => {
  let complete!: (value: { items: AutonomousActivationGrantRecord[] }) => void;
  api.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render();
  await render(project("project-b"));
  await act(async () => complete({ items: [grant()] }));
  expect(host.textContent).not.toContain("Synthetic grant");
  await render();
  await click("Review automatic fan-out");
  let finish!: (value: AutonomousActivationGrantRecord) => void;
  api.create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click("Confirm automatic fan-out");
  await render(project("project-b"));
  await act(async () => finish(grant()));
  expect(host.textContent).not.toContain("now available");
  expect(host.textContent).not.toContain("Synthetic grant");
});
it("shows canonical grant history and revokes its exact identity", async () => {
  api.list.mockResolvedValueOnce({ items: [grant()] });
  await render();
  expect(host.textContent).toContain("server-stamped-caller");
  await click("Revoke now");
  expect(api.revoke).toHaveBeenCalledExactlyOnceWith("grant-a", {
    revokedBy: "operator",
    reason: "Revoked from the project automatic fan-out control.",
  });
});
