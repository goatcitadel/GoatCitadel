// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionProfileSnapshotRecord } from "@goatcitadel/contracts";
import { __resetPermissionActivationsForTests } from "../../../features/native-routes/settings/use-permission-profile-activation";
import { PermissionProfileSettings } from "./PermissionProfileSettings";
const switchShellMock = vi.hoisted(() => vi.fn<typeof import("../../../shell-preference").switchShell>());
vi.mock("../../../shell-preference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shell-preference")>()),
  switchShell: switchShellMock,
}));
const api = vi.hoisted(() => ({
  getGatewayApiBaseUrl: vi.fn(() => "http://gateway-a"),
  fetchActiveLocalOperatorOverrides: vi.fn(),
  fetchPermissionProfiles: vi.fn(),
  fetchEffectivePermissionProfile: vi.fn(),
  fetchSettings: vi.fn(),
  reviewPermissionProfileSelection: vi.fn(),
  activatePermissionProfile: vi.fn(),
  fetchAutonomousActivationGrants: vi.fn(),
  revokeAutonomousActivationGrant: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
const profile: PermissionProfileSnapshotRecord = {
  profileId: "safe",
  label: "Safe",
  revision: "a".repeat(64),
  status: "active",
  builtin: true,
  scope: "global",
  approvalMode: "approve_all",
  toolPatterns: ["*"],
  allow: [],
  deny: [],
  createdBy: "system",
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
};
let items: PermissionProfileSnapshotRecord[];
let client: QueryClient;
let view: ReactTestRenderer;
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const button = (label: string) => view.root.findAllByType("button").find((item) => text(item) === label)!;
async function mount(workspaceId = "work-a") {
  await act(async () => {
    const tree = (
      <QueryClientProvider client={client}>
        <PermissionProfileSettings workspaceId={workspaceId} />
      </QueryClientProvider>
    );
    if (view) view.update(tree);
    else view = create(tree);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function select() {
  await act(async () => view.root.findAllByProps({ type: "radio" })[0]!.props.onChange());
}
async function click(label: string) {
  await act(async () => button(label).props.onClick());
}
beforeEach(() => {
  vi.resetAllMocks();
  switchShellMock.mockResolvedValue("opened");
  __resetPermissionActivationsForTests();
  items = [profile];
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  api.fetchPermissionProfiles.mockImplementation(async () => ({ items }));
  api.fetchEffectivePermissionProfile.mockResolvedValue({
    permissionProfile: { profileId: "previous", label: "Previous" },
  });
  api.fetchSettings.mockResolvedValue({ deploymentProfile: "local_dev" });
  api.fetchActiveLocalOperatorOverrides.mockResolvedValue({ items: [] });
  api.fetchAutonomousActivationGrants.mockResolvedValue({ items: [] });
  api.getGatewayApiBaseUrl.mockReturnValue("http://gateway-a");
  api.reviewPermissionProfileSelection.mockImplementation(async (input) => ({
    input,
    profile,
    revision: "b".repeat(64),
    target: { workspaceId: input.workspaceId, operatorId: "operator" },
    activeProfiles: [],
  }));
  api.activatePermissionProfile.mockImplementation(async (input) => {
    api.fetchEffectivePermissionProfile.mockResolvedValue({ permissionProfile: profile });
    return {
      ...input,
      activationId: "new",
      active: true,
      operatorId: "operator",
      createdBy: "operator",
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  });
});
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  view = undefined as unknown as ReactTestRenderer;
  client.clear();
  __resetPermissionActivationsForTests();
});

describe("native Chat permission profile", () => {
  it("uses the guarded same-document compatibility handoff without changing policy", async () => {
    await mount("work-a");
    const anchor = view.root.findAllByType("a").find((item) => text(item) === "Open classic permission settings")!;
    const preventDefault = vi.fn();
    await act(async () => anchor.props.onClick({ button: 0, preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(switchShellMock).toHaveBeenCalledExactlyOnceWith("classic", {
      href: "/settings/permissions?shell=classic&shellScope=visit",
      isCurrent: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
    expect(switchShellMock.mock.calls[0]![1].isCurrent()).toBe(true);
    expect(api.activatePermissionProfile).not.toHaveBeenCalled();
    expect(api.revokeAutonomousActivationGrant).not.toHaveBeenCalled();
  });
  it("uses the exact selected workspace, cancels a review, then shows fresh effective owner state", async () => {
    await mount();
    expect(api.fetchEffectivePermissionProfile.mock.calls.map(([input]) => input)).toEqual(
      ["chat", "tools", "mcp", "cowork", "code"].map((surface) => ({ workspaceId: "work-a", surface })),
    );
    expect(text(view.root)).toContain("Previous");
    expect(api.activatePermissionProfile).not.toHaveBeenCalled();
    await select();
    await click("Review Chat profile selection");
    expect(text(view.root)).toContain("does not approve a tool execution");
    await click("Cancel selection");
    expect(api.activatePermissionProfile).not.toHaveBeenCalled();
    await click("Review Chat profile selection");
    await click("Apply reviewed Chat profile");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(api.activatePermissionProfile).toHaveBeenCalledExactlyOnceWith({
      profileId: "safe",
      workspaceId: "work-a",
      surface: "chat",
      expectedProfileRevision: profile.revision,
      expectedSelectionRevision: "b".repeat(64),
    });
    expect(text(view.root)).toContain("Current effective workspace Chat profile: Safe");
    expect(text(view.root)).toContain("Autonomous activation grants");
  });
  it("bounds the loaded list and excludes archived or foreign workspace profiles", async () => {
    items = [
      ...Array.from({ length: 35 }, (_, i) => ({ ...profile, profileId: String(i), label: `Profile ${i}` })),
      { ...profile, profileId: "foreign", scope: "workspace", scopeRef: "foreign" },
      { ...profile, profileId: "old", status: "archived" },
    ];
    await mount();
    expect(view.root.findAllByProps({ type: "radio" })).toHaveLength(30);
    await click("Show more profiles");
    expect(view.root.findAllByProps({ type: "radio" })).toHaveLength(35);
  });
  it.each([
    ["tools", "Direct tools"],
    ["mcp", "MCP"],
    ["all", "All policy contexts"],
    ["cowork", "Legacy Cowork compatibility"],
    ["code", "Legacy Code compatibility"],
  ])("reviews and applies exact %s context without broadening it", async (surface, label) => {
    await mount();
    await select();
    await act(async () =>
      view.root
        .findByProps({ "aria-label": "Selection policy context" })
        .props.onChange({ target: { value: surface } }),
    );
    await click(`Review ${label} profile selection`);
    expect(api.activatePermissionProfile).not.toHaveBeenCalled();
    expect(api.reviewPermissionProfileSelection).toHaveBeenLastCalledWith({
      operation: "activate",
      profileId: profile.profileId,
      workspaceId: "work-a",
      surface,
    });
    await click(`Apply reviewed ${label} profile`);
    expect(api.activatePermissionProfile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ surface, workspaceId: "work-a", expectedProfileRevision: profile.revision }),
    );
  });
  it("keeps failed context evidence unavailable while showing other exact owner contexts", async () => {
    api.fetchEffectivePermissionProfile.mockImplementation(async ({ surface }) => {
      if (surface === "mcp") throw new Error("MCP owner unavailable");
      return {
        permissionProfileId: `profile-${surface}`,
        permissionProfileLabel: `Policy ${surface}`,
        permissionProfileApprovalMode: "approve_all",
      };
    });
    await mount();
    expect(text(view.root)).toContain("Unavailable: MCP owner unavailable");
    expect(text(view.root)).toContain("Policy tools");
    expect(text(view.root)).toContain("Policy code");
    expect(text(view.root)).toContain("They do not govern current Chat");
  });
  it("invalidates an existing review when its selected context changes", async () => {
    await mount();
    await select();
    await click("Review Chat profile selection");
    const confirm = button("Apply reviewed Chat profile").props.onClick;
    await act(async () =>
      view.root.findByProps({ "aria-label": "Selection policy context" }).props.onChange({ target: { value: "mcp" } }),
    );
    await act(async () => {
      await confirm();
    });
    expect(api.activatePermissionProfile).not.toHaveBeenCalled();
    expect(text(view.root)).not.toContain("Reviewed Chat profile selection");
  });
  it("does not invent a default workspace or perform reads without selection", async () => {
    await mount("");
    expect(api.fetchPermissionProfiles).not.toHaveBeenCalled();
    expect(text(view.root)).toContain("Select a workspace");
  });
  it("clears the review on scope change and locks cached data during failed refresh", async () => {
    await mount();
    await select();
    await click("Review Chat profile selection");
    await mount("work-b");
    expect(view.root.findAllByProps({ "aria-label": "Reviewed Chat profile selection" })).toHaveLength(0);
    api.fetchPermissionProfiles.mockRejectedValueOnce(new Error("owner unavailable"));
    await click("Refresh permission profiles");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(view.root.findAllByProps({ type: "radio" })).toHaveLength(0);
    expect(api.activatePermissionProfile).not.toHaveBeenCalled();
    expect(text(view.root)).toContain("owner unavailable");
  });
});
