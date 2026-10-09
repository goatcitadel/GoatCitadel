// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import type { ToolApprovalMode } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { __resetApprovalModeUncertaintyForTests } from "./approval-mode-state";
import { ApprovalModeControl } from "./ApprovalModeControl";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn(), patchSettings: vi.fn(), fetchChangePlan: vi.fn() }));
const switchShellMock = vi.hoisted(() => vi.fn<typeof import("../../../shell-preference").switchShell>());
vi.mock("../../../shell-preference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shell-preference")>()),
  switchShell: switchShellMock,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));
let confirmation: ComponentProps<typeof ConfirmModal>;
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: ComponentProps<typeof ConfirmModal>) => {
    confirmation = props;
    return null;
  },
}));
let owner: { revision: number; toolApprovalMode: ToolApprovalMode; deploymentProfile?: string };
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalModeControl />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).not.toContain("Loading approval settings"));
}
async function choose(mode: string) {
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = mode;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function pending(mode: ToolApprovalMode) {
  const receipt = {
    planId: "approval-plan",
    status: "awaiting_approval",
    revision: 2,
    risk: "danger",
    summary: "Approval required",
    requiredAction: { kind: "approval", approvalId: "approval-1", title: "Review the rule" },
  };
  api.patchSettings.mockResolvedValue({ ...owner, changePlanReceipt: receipt });
  const canonical = {
    ...receipt,
    kind: "runtime_configuration",
    origin: { workspaceId: "default", surface: "settings" },
    request: { kind: "runtime_configuration", change: { operation: "tool_approval_mode", mode } },
    target: { ownerId: "runtime_settings", resourceId: "tool_approval_mode", expectedRevision: 2 },
  };
  api.fetchChangePlan.mockResolvedValue(canonical);
  return canonical;
}
beforeEach(() => {
  vi.resetAllMocks();
  switchShellMock.mockResolvedValue("cancelled");
  owner = { revision: 2, toolApprovalMode: "approve_all", deploymentProfile: "trusted_local" };
  api.fetchSettings.mockImplementation(async () => ({ ...owner }));
  api.patchSettings.mockImplementation(async (input: { toolApprovalMode: ToolApprovalMode }) => {
    owner = { ...owner, revision: owner.revision + 1, toolApprovalMode: input.toolApprovalMode };
    return { ...owner };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  __resetApprovalModeUncertaintyForTests();
});

describe("cockpit tool approval rule", () => {
  it("submits only the reviewed mode and current revision and requires canonical acknowledgement", async () => {
    await render();
    await choose("approve_risky");
    await click("Save approval rule");
    expect(api.patchSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 2,
      toolApprovalMode: "approve_risky",
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Tool approval rule saved and confirmed"));
    expect(container.textContent).not.toContain("Unsaved approval rule draft");
    expect(container.textContent).toContain(
      "Tool grants, deny rules, and required high-risk approvals remain authoritative",
    );
  });

  it("retains a pending owner approval and exposes its exact approval link without claiming saved", async () => {
    pending("approve_risky");
    await render();
    await choose("approve_risky");
    await click("Save approval rule");
    await vi.waitFor(() =>
      expect(api.fetchChangePlan).toHaveBeenCalledWith("approval-plan", { workspaceId: "default" }),
    );
    expect(container.textContent).toContain("draft remains unsaved");
    expect(container.textContent).not.toContain("Tool approval rule saved");
    expect(button("Save approval rule").disabled).toBe(true);
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="/ops/approvals?shell=classic&approvalId=approval-1&shellScope=visit"]',
    )!;
    expect(link).not.toBeNull();
    expect(container.querySelector('a[href^="/inbox?approvalId"]')).toBeNull();
    await act(async () => {
      link.click();
    });
    expect(switchShellMock).not.toHaveBeenCalled();
    const keep = [...document.querySelectorAll("button")].find((item) => item.textContent === "Keep draft and close");
    expect(keep).toBeDefined();
    await act(async () => {
      keep!.click();
    });
    expect(switchShellMock).toHaveBeenCalledExactlyOnceWith(
      "classic",
      expect.objectContaining({
        href: "/ops/approvals?shell=classic&approvalId=approval-1&shellScope=visit",
        isCurrent: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(switchShellMock.mock.calls[0]![1].isCurrent()).toBe(true);
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
    expect(button("Save approval rule").disabled).toBe(true);
  });

  it("rejects a change plan for a different approval mode", async () => {
    pending("bypass");
    await render();
    await choose("approve_risky");
    await click("Save approval rule");
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Change evidence does not match this Settings save"),
    );
    expect(button("Save approval rule").disabled).toBe(true);
    expect(container.textContent).toContain("Unsaved approval rule draft");
  });

  it("removes submitted and approval-action hints only after canonical settings settlement", async () => {
    const canonical = pending("approve_risky");
    await render();
    await choose("approve_risky");
    await click("Save approval rule");
    await vi.waitFor(() => expect(container.textContent).toContain("Change submitted."));
    owner = { ...owner, revision: 3, toolApprovalMode: "approve_risky" };
    api.fetchChangePlan.mockResolvedValue({
      ...canonical,
      status: "completed",
      revision: 4,
      requiredAction: undefined,
    });
    await click("Refresh approval change");
    await vi.waitFor(() => expect(container.textContent).toContain("Change saved and confirmed."));
    expect(container.textContent).not.toContain("Change submitted.");
    expect(container.textContent).not.toContain("Continue approved change");
    expect(container.textContent).not.toContain("Review required approval");
  });

  it("re-reads the revision before mutation and preserves a stale draft", async () => {
    await render();
    await choose("approve_risky");
    owner = { ...owner, revision: 3 };
    await click("Save approval rule");
    expect(api.patchSettings).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(container.textContent).toContain("Approval settings changed"));
    expect(container.querySelector("select")!.value).toBe("approve_risky");
    expect(button("Save approval rule").disabled).toBe(true);
    await click("Review draft against current revision");
    await click("Save approval rule");
    expect(api.patchSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 3,
      toolApprovalMode: "approve_risky",
    });
  });

  it("requires a dangerous, revision-bound confirmation before requesting bypass", async () => {
    pending("bypass");
    await render();
    await choose("bypass");
    await click("Review prompt skipping");
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(confirmation).toMatchObject({ open: true, danger: true, confirmDisabled: false });
    expect(confirmation.message).toContain("settings revision 2");
    expect(confirmation.message).toContain("Deny rules, Critical risk and risky-shell approvals");
    await act(async () => confirmation.onConfirm());
    expect(api.patchSettings).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 2, toolApprovalMode: "bypass" });
    expect(container.textContent).toContain("draft remains unsaved");
  });

  it("does not mutate when bypass review is cancelled", async () => {
    await render();
    await choose("bypass");
    await click("Review prompt skipping");
    await act(async () => confirmation.onCancel());
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(confirmation.open).toBe(false);
  });

  it("invalidates bypass confirmation when the canonical revision changes", async () => {
    await render();
    await choose("bypass");
    await click("Review prompt skipping");
    owner = { ...owner, revision: 3, deploymentProfile: "remote_hardened" };
    await act(async () => {
      client.setQueryData(["system", "settings-approval-mode"], { ...owner });
    });
    await vi.waitFor(() => expect(confirmation.confirmDisabled).toBe(true));
    await act(async () => confirmation.onConfirm());
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("keeps bypass unavailable for Remote Hardened even if a select event is forced", async () => {
    owner.deploymentProfile = "remote_hardened";
    await render();
    expect(container.querySelector<HTMLOptionElement>('option[value="bypass"]')!.disabled).toBe(true);
    await choose("bypass");
    expect(button("Review prompt skipping").disabled).toBe(true);
    await click("Review prompt skipping");
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("fails closed when the owner profile is missing", async () => {
    delete owner.deploymentProfile;
    await render();
    expect(container.textContent).toContain("Gateway approval mode, deployment profile, or revision is unavailable");
    expect(container.querySelector("select")).toBeNull();
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("retains the unknown-write lock across navigation and refresh", async () => {
    api.patchSettings.mockRejectedValue(new Error("Network error"));
    await render();
    await choose("approve_risky");
    await click("Save approval rule");
    expect(container.textContent).toContain("Save outcome is uncertain");
    await act(async () => root.render(null));
    await render();
    await click("Refresh approval settings");
    expect(container.textContent).toContain("Save outcome is uncertain");
    expect(button("Save approval rule").disabled).toBe(true);
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
  });

  it("locks mismatched completed settings instead of claiming success", async () => {
    api.patchSettings.mockResolvedValue({ ...owner, revision: 3 });
    await render();
    await choose("approve_risky");
    await click("Save approval rule");
    expect(container.textContent).toContain("Save outcome is uncertain");
    expect(container.textContent).not.toContain("Tool approval rule saved");
  });

  it("allows explicit rebase only for an owner-authored revision rejection", async () => {
    api.patchSettings.mockImplementationOnce(async () => {
      owner = { ...owner, revision: 3 };
      throw { status: 409, body: { code: "STATE_CONFLICT", details: { expectedRevision: 2, currentRevision: 3 } } };
    });
    await render();
    await choose("approve_risky");
    await click("Save approval rule");
    expect(container.textContent).toContain("Gateway rejected the stale settings revision");
    expect(container.textContent).not.toContain("Save outcome is uncertain");
    await click("Review draft against current revision");
    await click("Save approval rule");
    expect(api.patchSettings).toHaveBeenLastCalledWith({ expectedRevision: 3, toolApprovalMode: "approve_risky" });
  });
});
