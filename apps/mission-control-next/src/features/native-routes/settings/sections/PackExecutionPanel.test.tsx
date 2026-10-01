// @vitest-environment happy-dom
import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PackExecutionPanel } from "./PackExecutionPanel";
import { PortablePackSetup } from "../../../../cockpit/areas/settings/PortablePackSetup";
import { packManifest, packPreview, packPlan } from "./pack-execution.test-support";
import { __resetPackAttemptsForTests } from "./pack-mutation-state";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";
const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  preview: vi.fn(),
  verify: vi.fn(),
  create: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  respond: vi.fn(),
  rollback: vi.fn(),
  approval: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChangePlans: api.list,
  fetchChangePlan: api.get,
  fetchCapabilityPackPreview: api.preview,
  verifyChangePlan: api.verify,
  createChangePlan: api.create,
  confirmChangePlan: api.confirm,
  cancelChangePlan: api.cancel,
  respondToChangePlan: api.respond,
  requestChangePlanRollback: api.rollback,
  fetchApprovalReplay: api.approval,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://fixture",
}));
vi.mock("../../../../cockpit/ui/Dialog", () => ({
  Dialog: ({
    open,
    title,
    description,
    children,
  }: {
    open: boolean;
    title: string;
    description?: string;
    children: React.ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <p>{description}</p>
        {children}
      </div>
    ) : null,
}));
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: ({
    open,
    title,
    message,
    confirmLabel,
    cancelLabel,
    onConfirm,
    onCancel,
    confirmDisabled,
  }: {
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
    confirmDisabled?: boolean;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <p>{message}</p>
        <button type="button" disabled={confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    ) : null,
}));
let root: ReturnType<typeof createRoot>,
  host: HTMLDivElement,
  saved = packPlan();
const inspect = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  __resetPackAttemptsForTests();
  __resetSessionDraftsForTests();
  saved = packPlan();
  api.list.mockResolvedValue({ items: [] });
  api.get.mockImplementation(async () => saved);
  api.preview.mockResolvedValue(packPreview);
  api.create.mockImplementation(async () => saved);
  api.verify.mockImplementation(
    async () =>
      (saved = {
        ...saved,
        status: "completed",
        revision: saved.revision + 1,
        phase: "terminal",
        requiredAction: undefined,
      }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});
async function render(native: boolean) {
  await act(async () =>
    root.render(
      <StrictMode>
        {native ? (
          <PortablePackSetup manifest={packManifest} workspaceId="a" onInspect={inspect} />
        ) : (
          <PackExecutionPanel
            manifest={packManifest}
            workspaceId="a"
            navigate={vi.fn()}
            route={{ area: "settings", section: "addons", theme: "dark" }}
          />
        )}
      </StrictMode>,
    ),
  );
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
it.each([false, true])("%s shell separates read refresh from reviewed owner verification", async (native) => {
  saved = packPlan({ status: "monitoring", requiredAction: undefined, revision: 5 });
  api.list.mockImplementation(async () => ({ items: [saved] }));
  await render(native);
  expect(api.verify).not.toHaveBeenCalled();
  await click("Refresh setup records");
  expect(api.verify).not.toHaveBeenCalled();
  await click("Verify current owner evidence");
  expect(host.textContent).toContain("not a read-only refresh");
  await click("Cancel plan review");
  expect(api.verify).not.toHaveBeenCalled();
  await click("Verify current owner evidence");
  await click("Submit reviewed plan action");
  expect(api.verify).toHaveBeenCalledWith("plan", { workspaceId: "a" }, 5);
  expect(host.textContent).toContain("completed");
  if (native) expect(host.querySelector('[class*="mc-next"]')).toBeNull();
});
it.each([false, true])(
  "%s shell cancels setup review without writes and creates only the reviewed plan",
  async (native) => {
    await render(native);
    await click("Review setup plan");
    expect(host.textContent).toContain("pinned server package");
    expect(api.create).not.toHaveBeenCalled();
    await click("Cancel setup review");
    expect(api.create).not.toHaveBeenCalled();
    await click("Review setup plan");
    await click("Create reviewed setup plan");
    expect(api.create).toHaveBeenCalledWith({ workspaceId: "a", surface: "settings", request: saved.request });
    expect(api.confirm).not.toHaveBeenCalled();
    expect(host.textContent).toContain("awaiting confirmation");
  },
);
it("native child inspection hands off only the canonical linked proposal and current workspace", async () => {
  saved = packPlan({ status: "monitoring", requiredAction: undefined, evidenceRefs: ["change_plan:child"] });
  const child = packPlan({
    planId: "child",
    kind: "capability_candidate",
    request: { kind: "capability_candidate", proposalId: "proposal" },
    evidenceRefs: ["capability_proposal:proposal"],
  });
  api.list.mockResolvedValue({ items: [saved] });
  api.get.mockResolvedValue(child);
  await render(true);
  await click("Inspect linked owner");
  expect(inspect).toHaveBeenCalledWith("/inbox?item=capability_proposal%3Aproposal&workspaceId=a");
  expect(api.respond).not.toHaveBeenCalled();
  expect(api.confirm).not.toHaveBeenCalled();
});
it("unknown outcome remains explicit and disables repeat setup action", async () => {
  api.create.mockRejectedValue(new Error("Lost response"));
  await render(true);
  await click("Review setup plan");
  await click("Create reviewed setup plan");
  expect(host.textContent).toContain("Pack action outcome is unconfirmed");
  expect(
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Review setup plan")?.disabled,
  ).toBe(true);
  expect(api.create).toHaveBeenCalledTimes(1);
});
