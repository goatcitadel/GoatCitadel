// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolGrantSettings } from "./ToolGrantSettings";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import {
  awaitingLlamaApproval,
  llamaPlanFixture,
} from "../../../features/native-routes/settings/llama-setup.test-support";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
const viewState = vi.hoisted(() => ({ installation: "http://gateway-a", open: vi.fn() }));
vi.mock("../../../shell-preference", () => ({ switchShell: viewState.open, writeShellPreference: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client-core")>()),
  getGatewayApiBaseUrl: () => viewState.installation,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "citadel-a", activeWorkspaceId: "workspace-a" }),
}));
import { __resetToolGrantActionsForTests } from "../../../features/native-routes/settings/use-tool-grant-actions";

const api = vi.hoisted(() => ({
  fetchToolCatalog: vi.fn(),
  fetchToolGrants: vi.fn(),
  createToolGrant: vi.fn(),
  revokeToolGrant: vi.fn(),
  isApiRequestError: () => false,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: React.ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));
let view: ReactTestRenderer | undefined;
const button = (label: string) => view!.root.findAllByType("button").find((item) => item.children.join("") === label)!;
const input = (label: string) => {
  const labelNode = view!.root.findAllByType("label").find((item) => item.children[0] === label)!;
  return view!.root.findAll(
    (item) => item.props.id === labelNode.props.htmlFor && ["input", "select"].includes(String(item.type)),
  )[0]!;
};
async function render(withApproval = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    view = create(
      <QueryClientProvider client={client}>
        <ToolGrantSettings workspaceId="workspace-a" />
        {withApproval ? (
          <SettingsApprovalOwnerAction
            owner="llama-setup"
            workspaceId="workspace-a"
            plan={awaitingLlamaApproval(llamaPlanFixture())}
          />
        ) : null}
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetToolGrantActionsForTests();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  viewState.installation = "http://gateway-a";
  viewState.open.mockResolvedValue("cancelled");
  window.history.replaceState(null, "", "/settings/safety?shell=cockpit#tool-grants");
  api.fetchToolCatalog.mockResolvedValue({ items: [] });
  api.fetchToolGrants.mockResolvedValue({ items: [] });
});
afterEach(async () => {
  await act(async () => view?.unmount());
  view = undefined;
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
});
it("shows exact editable labels and reviews a global scope without sending a grant on cancel", async () => {
  await render();
  await act(async () => input("Tool pattern").props.onChange({ target: { value: "session.status" } }));
  await act(async () => input("Scope").props.onChange({ target: { value: "global" } }));
  expect(input("Scope ID").props.disabled).toBe(true);
  await act(async () => button("Review new grant").props.onClick());
  const dialog = view!.root.findByProps({ role: "dialog", "aria-label": "Review new tool grant" });
  expect(dialog.findAllByType("dd").map((item) => item.children.join(""))).toContain("global · all contexts");
  await act(async () => button("Cancel").props.onClick());
  expect(api.createToolGrant).not.toHaveBeenCalled();
  expect(input("Tool pattern").props.value).toBe("session.status");
});
it("does not show zero grants or allow a write when the bounded grant owner is unavailable", async () => {
  api.fetchToolGrants.mockRejectedValue(new Error("owner unavailable"));
  await render();
  expect(button("Review new grant").props.disabled).toBe(true);
  expect(
    view!.root.findAllByType("p").some((item) => item.children.join("") === "No recorded grants match this view."),
  ).toBe(false);
  expect(
    view!.root.findAllByProps({ role: "status" }).some((item) => item.children.join("").includes("Tool grants")),
  ).toBe(true);
});

it("keeps separate unsent drafts for the same workspace/tool across installations", async () => {
  await render();
  await act(async () => input("Tool pattern").props.onChange({ target: { value: "installation-a.*" } }));
  await act(async () => view!.unmount());
  viewState.installation = "http://gateway-b";
  await render();
  expect(input("Tool pattern").props.value).toBe("");
  await act(async () => input("Tool pattern").props.onChange({ target: { value: "installation-b.*" } }));
  await act(async () => view!.unmount());
  viewState.installation = "http://gateway-a";
  await render();
  expect(input("Tool pattern").props.value).toBe("installation-a.*");
  expect(api.createToolGrant).not.toHaveBeenCalled();
  expect(api.revokeToolGrant).not.toHaveBeenCalled();
});

it.each(["Keep draft and close", "Discard changes"])(
  "guards the actual grant draft before an exact approval owner handoff: %s",
  async (decision) => {
    await render(true);
    await act(async () => input("Tool pattern").props.onChange({ target: { value: "session.status" } }));
    const click = () =>
      view!.root
        .findAllByType("a")
        .find((item) => item.props["aria-label"] === "Review required approval")!
        .props.onClick({ button: 0, preventDefault: vi.fn() });
    await act(async () => click());
    expect(viewState.open).not.toHaveBeenCalled();
    await act(async () => button("Cancel").props.onClick());
    expect(input("Tool pattern").props.value).toBe("session.status");
    await act(async () => click());
    await act(async () => button(decision).props.onClick());
    expect(viewState.open).toHaveBeenCalledExactlyOnceWith(
      "classic",
      expect.objectContaining({
        href: "/ops/approvals?approvalId=approval-1&shell=classic&shellScope=visit",
        isCurrent: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(input("Tool pattern").props.value).toBe(decision === "Discard changes" ? "" : "session.status");
    expect(api.createToolGrant).not.toHaveBeenCalled();
    expect(api.revokeToolGrant).not.toHaveBeenCalled();
  },
);

it("retains an unconfirmed grant write and its input across the guarded handoff and remount", async () => {
  api.createToolGrant.mockRejectedValue(new Error("transport ended after dispatch"));
  await render(true);
  await act(async () => input("Tool pattern").props.onChange({ target: { value: "session.status" } }));
  await act(async () => button("Review new grant").props.onClick());
  await act(async () => button("Create reviewed grant").props.onClick());
  expect(api.createToolGrant).toHaveBeenCalledOnce();
  expect(button("Review new grant").props.disabled).toBe(true);
  await act(async () =>
    view!.root
      .findAllByType("a")
      .find((item) => item.props["aria-label"] === "Review required approval")!
      .props.onClick({ button: 0, preventDefault: vi.fn() }),
  );
  await act(async () => button("Keep draft and close").props.onClick());
  expect(viewState.open).toHaveBeenCalledOnce();
  await act(async () => view!.unmount());
  await render(true);
  expect(input("Tool pattern").props.value).toBe("session.status");
  expect(button("Review new grant").props.disabled).toBe(true);
  expect(api.createToolGrant).toHaveBeenCalledOnce();
});

it("defaults a new grant to an expiring one-hour grant and preserves until-revoked choices", async () => {
  const now = Date.now();
  await render();
  expect(input("Grant type").props.value).toBe("ttl");
  expect(Date.parse(input("Expires at").props.value) - now).toBeGreaterThan(3_500_000);
  expect(Date.parse(input("Expires at").props.value) - now).toBeLessThan(3_700_000);
  await act(async () => input("Grant type").props.onChange({ target: { value: "persistent" } }));
  expect(input("Grant type").props.value).toBe("persistent");
  expect(api.createToolGrant).not.toHaveBeenCalled();
});
