// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolGrantSettings } from "./ToolGrantSettings";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { SHELL_HISTORY_POSITION } from "../../../app/shell-transition";
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
vi.mock("../../data/use-workspace-name", () => ({
  useWorkspaceNameLookup: () => (workspaceId?: string) => (workspaceId === "workspace-b" ? "Research" : undefined),
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
      <CockpitNavigationProvider>
        <QueryClientProvider client={client}>
          <ToolGrantSettings workspaceId="workspace-a" />
          {withApproval ? (
            <SettingsApprovalOwnerAction
              owner="llama-setup"
              workspaceId="workspace-a"
              plan={awaitingLlamaApproval(llamaPlanFixture())}
            />
          ) : null}
        </QueryClientProvider>
      </CockpitNavigationProvider>,
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
  window.history.replaceState(
    { evidence: "grant-owner-handoff" },
    "",
    "/settings/safety?source=tool-grants&runId=run-grant&sessionId=session-grant&shell=cockpit#tool-grants",
  );
  api.fetchToolCatalog.mockResolvedValue({ items: [] });
  api.fetchToolGrants.mockResolvedValue({ items: [] });
});
afterEach(async () => {
  await act(async () => view?.unmount());
  view = undefined;
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  vi.restoreAllMocks();
});
it("shows exact editable labels and reviews a global scope without sending a grant on cancel", async () => {
  await render();
  await act(async () => input("Tool pattern").props.onChange({ target: { value: "session.status" } }));
  await act(async () => input("Scope").props.onChange({ target: { value: "global" } }));
  expect(input("Scope ID").props.disabled).toBe(true);
  await act(async () => button("Review new grant").props.onClick());
  const dialog = view!.root.findByProps({ role: "dialog", "aria-label": "Review new tool grant" });
  expect(dialog.findAllByType("dd").map((item) => item.children.join(""))).toContain("Global · all contexts");
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

it("names each grant's actions by its tool, decision and scope, never its ID", async () => {
  api.fetchToolGrants.mockResolvedValue({
    items: [
      {
        grantId: "grant-secret-id",
        toolPattern: "session.status",
        decision: "allow",
        scope: "workspace",
        scopeRef: "workspace-a",
        grantType: "persistent",
        createdBy: "operator",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
  });
  await render();
  const labels = view!.root.findAllByType("button").map((item) => String(item.props["aria-label"] ?? ""));
  expect(labels).toContain("Inspect grant: session.status · Allow · Workspace");
  expect(labels).toContain("Revoke grant: session.status · Allow · Workspace");
  expect(labels.some((label) => label.includes("grant-secret-id"))).toBe(false);
  // The row reads in operator words; the workspace ID stays in Inspect grant.
  const rowText = view!.root
    .findAllByType("li")
    .flatMap((item) => item.findAllByType("p"))
    .map((item) => item.children.join(""));
  expect(rowText).toContain("session.status · Allow · Workspace");
  expect(rowText.some((row) => row.includes("workspace-a"))).toBe(false);
  const links = view!.root.findAllByType("a");
  expect(links.some((link) => link.props.href === "/settings/safety#permission-profile")).toBe(true);
});

it("reviews a revocation in operator words: decision label, workspace name, no grant or scope ID", async () => {
  api.fetchToolGrants.mockResolvedValue({
    items: [
      {
        grantId: "grant-secret-id",
        toolPattern: "fs.write",
        decision: "deny",
        scope: "workspace",
        scopeRef: "workspace-b",
        grantType: "persistent",
        createdBy: "operator",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
  });
  await render();
  const row = view!.root.findAllByType("li").flatMap((item) => item.findAllByType("p"));
  expect(row.map((item) => item.children.join(""))).toContain("Workspace: Research · available");
  const revoke = view!.root
    .findAllByType("button")
    .find((item) => item.props["aria-label"] === "Revoke grant: fs.write · Deny · Workspace")!;
  await act(async () => revoke.props.onClick());
  const dialog = view!.root.findByProps({ role: "dialog", "aria-label": "Revoke tool grant" });
  const shown = dialog.findAllByType("p").map((item) => item.children.join(""));
  expect(shown).toContain("fs.write · Deny");
  expect(shown).toContain("Workspace: Research");
  expect(shown.some((line) => line.includes("grant-secret-id") || line.includes("workspace-b"))).toBe(false);
  expect(api.revokeToolGrant).not.toHaveBeenCalled();
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

async function readyDecision(label: string) {
  await vi.waitFor(() => expect(button(label)).toBeDefined());
  await act(async () => button(label).props.onClick());
}
function historyEntry() {
  return { href: window.location.href, state: structuredClone(window.history.state) };
}
async function expectHistoryTraversal(
  source: ReturnType<typeof historyEntry>,
  destination: ReturnType<typeof historyEntry>,
  dirty: boolean,
) {
  await act(async () => window.history.back());
  if (dirty) await readyDecision("Keep draft and close");
  await vi.waitFor(() => expect(window.location.href).toBe(source.href));
  expect(window.history.state).toEqual(source.state);
  await act(async () => window.history.forward());
  if (dirty) await readyDecision("Keep draft and close");
  await vi.waitFor(() => expect(window.location.href).toBe(destination.href));
  expect(window.history.state).toEqual(destination.state);
}
function expectNativeApproval() {
  const destination = new URL(window.location.href);
  expect(destination.pathname).toBe("/inbox");
  expect(destination.searchParams.get("workspaceId")).toBe("workspace-a");
  expect(destination.searchParams.get("source")).toBe("tool-grants");
  expect(destination.searchParams.get("runId")).toBe("run-grant");
  expect(destination.searchParams.get("sessionId")).toBe("session-grant");
  expect(destination.searchParams.get("shell")).toBe("cockpit");
  expect(destination.searchParams.getAll("approvalId")).toEqual(["approval-1"]);
  expect(destination.searchParams.has("shellScope")).toBe(false);
  expect(destination.hash).toBe("#tool-grants");
  expect(window.history.state).toEqual({ [SHELL_HISTORY_POSITION]: expect.any(Number) });
  return historyEntry();
}
it.each(["Keep draft and close", "Discard changes"])(
  "guards the actual grant draft before an exact approval owner handoff: %s",
  async (decision) => {
    await render(true);
    const sourceEntry = historyEntry();
    expect(sourceEntry.state).toMatchObject({ evidence: "grant-owner-handoff" });
    await act(async () => input("Tool pattern").props.onChange({ target: { value: "session.status" } }));
    const nativeNavigation = vi.spyOn(window.history, "pushState");
    const click = () =>
      view!.root
        .findAllByType("a")
        .find((item) => item.children.join("") === "Review required approval")!
        .props.onClick({ button: 0, preventDefault: vi.fn() });
    await act(async () => click());
    expect(viewState.open).not.toHaveBeenCalled();
    expect(nativeNavigation).not.toHaveBeenCalled();
    await readyDecision("Cancel");
    expect(nativeNavigation).not.toHaveBeenCalled();
    expect(window.location.href).toBe(sourceEntry.href);
    expect(window.history.state).toEqual(sourceEntry.state);
    expect(input("Tool pattern").props.value).toBe("session.status");
    await act(async () => click());
    await readyDecision(decision);
    expect(viewState.open).not.toHaveBeenCalled();
    expect(nativeNavigation).toHaveBeenCalledOnce();
    const destinationEntry = expectNativeApproval();
    await expectHistoryTraversal(sourceEntry, destinationEntry, decision === "Keep draft and close");
    expect(nativeNavigation).toHaveBeenCalledOnce();
    expect(input("Tool pattern").props.value).toBe(decision === "Discard changes" ? "" : "session.status");
    expect(api.createToolGrant).not.toHaveBeenCalled();
    expect(api.revokeToolGrant).not.toHaveBeenCalled();
  },
);

it("retains an unconfirmed grant write and its input across the guarded handoff and remount", async () => {
  api.createToolGrant.mockRejectedValue(new Error("transport ended after dispatch"));
  await render(true);
  const sourceEntry = historyEntry();
  expect(sourceEntry.state).toMatchObject({ evidence: "grant-owner-handoff" });
  await act(async () => input("Tool pattern").props.onChange({ target: { value: "session.status" } }));
  await act(async () => button("Review new grant").props.onClick());
  await act(async () => button("Create reviewed grant").props.onClick());
  expect(api.createToolGrant).toHaveBeenCalledOnce();
  expect(button("Review new grant").props.disabled).toBe(true);
  const nativeNavigation = vi.spyOn(window.history, "pushState");
  await act(async () =>
    view!.root
      .findAllByType("a")
      .find((item) => item.children.join("") === "Review required approval")!
      .props.onClick({ button: 0, preventDefault: vi.fn() }),
  );
  await readyDecision("Keep draft and close");
  expect(viewState.open).not.toHaveBeenCalled();
  expect(nativeNavigation).toHaveBeenCalledOnce();
  const destinationEntry = expectNativeApproval();
  await expectHistoryTraversal(sourceEntry, destinationEntry, true);
  expect(nativeNavigation).toHaveBeenCalledOnce();
  expect(api.createToolGrant).toHaveBeenCalledOnce();
  expect(api.revokeToolGrant).not.toHaveBeenCalled();
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
