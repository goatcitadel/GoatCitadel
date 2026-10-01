// @vitest-environment happy-dom
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PermissionProfileSnapshotRecord } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
import { __resetPermissionManagementForTests } from "../../../features/native-routes/settings/use-permission-management";
import { gatewayAuthSettingsFixture } from "../../../features/native-routes/settings/gateway-auth.test-support";
import { permissionProfileFixture as profile, permissionOverrideFixture as override } from "../../../features/native-routes/settings/permission-management.test-support";
import { PermissionProfileEditor } from "./PermissionProfileEditor";
import { LocalOperatorOverrides } from "./LocalOperatorOverrides";

const api = vi.hoisted(() => ({ getGatewayApiBaseUrl: vi.fn(), fetchSettings: vi.fn(), fetchPermissionProfiles: vi.fn(),
  fetchActiveLocalOperatorOverrides: vi.fn(), reviewPermissionProfileSelection: vi.fn(), createPermissionProfile: vi.fn(),
  updatePermissionProfile: vi.fn(), archivePermissionProfile: vi.fn(), createLocalOperatorOverride: vi.fn(), revokeLocalOperatorOverride: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
let view: ReactTestRenderer | undefined;
let profiles: PermissionProfileSnapshotRecord[];
let client: QueryClient;
let surface: "profiles" | "overrides";
const text = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(text).join("");
const button = (label: string) => view!.root.findAllByType("button").find((node) => text(node) === label)!;
function field(label: string, type: "input" | "textarea" = "input") {
  return view!.root.findAllByType("label").find((node) => text(node).startsWith(label))!.findByType(type);
}
async function click(label: string) { await act(async () => { button(label).props.onClick(); await new Promise((resolve) => setTimeout(resolve, 10)); }); }
async function change(label: string, value: string, type: "input" | "textarea" = "input") { await act(async () => field(label, type).props.onChange({ target: { value } })); }
function element() {
  return <QueryClientProvider client={client}>{surface === "profiles"
    ? <PermissionProfileEditor workspaceId="work-a" profiles={profiles} available deploymentProfile="local_dev" reload={async () => { view?.update(element()); }} />
    : <LocalOperatorOverrides workspaceId="work-a" />}</QueryClientProvider>;
}
async function render() {
  await act(async () => {
    if (view) view.update(element()); else view = create(element());
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}
beforeEach(() => {
  vi.resetAllMocks(); __resetPermissionManagementForTests(); __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  surface = "profiles"; profiles = [];
  api.getGatewayApiBaseUrl.mockReturnValue("http://gateway-a"); api.fetchSettings.mockResolvedValue(gatewayAuthSettingsFixture());
  api.fetchPermissionProfiles.mockImplementation(async () => ({ items: profiles }));
  api.fetchActiveLocalOperatorOverrides.mockResolvedValue({ items: [] });
  api.createPermissionProfile.mockImplementation(async () => { profiles = [profile]; return profile; });
});
afterEach(async () => { if (view) await act(async () => view?.unmount()); view = undefined; client.clear(); __resetPermissionManagementForTests(); __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests(); });

it("shows exact native profile fields and an explicit cancelable review before creation", async () => {
  await render(); await click("New permission profile"); await change("Profile name", profile.label);
  await click("Review profile change");
  expect(text(view!.root)).toContain("Hard denies, auth, path jails"); expect(text(view!.root)).toContain("work-a");
  expect(button("Apply reviewed permission change").props.className).toContain("bg-accent");
  expect(button("Cancel permission change").props.className).toContain("border-line");
  expect(api.createPermissionProfile).not.toHaveBeenCalled();
  await click("Cancel permission change"); expect(field("Profile name").props.value).toBe(profile.label);
  await click("Review profile change"); await click("Apply reviewed permission change");
  expect(api.createPermissionProfile).toHaveBeenCalledOnce(); expect(text(view!.root)).toContain(`Edit ${profile.label}`);
});

it("makes retained legacy defaults inspectable for a new profile without silently enabling them", async () => {
  await render(); await click("New permission profile");
  const legacy = view!.root.findAllByType("details").find(node => text(node).includes("Retained legacy contexts"))!;
  expect(text(legacy)).toContain("do not govern current Chat");
  expect(legacy.findAllByType("input").map(input => input.props.checked)).toEqual([false, false]);
  await act(async () => legacy.findAllByType("input")[0]!.props.onChange({ target: { checked: true } }));
  expect(legacy.findAllByType("input").map(input => input.props.checked)).toEqual([true, false]);
  expect(api.createPermissionProfile).not.toHaveBeenCalled();
});

it("pages active override records without losing access to later exact targets", async () => {
  surface = "overrides";
  api.fetchActiveLocalOperatorOverrides.mockResolvedValue({ items: Array.from({ length: 35 }, (_, index) => ({ ...override, overrideId: `override-${index}` })) });
  await render();
  expect(view!.root.findAllByType("li")).toHaveLength(30);
  await click("Show more temporary overrides");
  expect(view!.root.findAllByType("li")).toHaveLength(35);
  expect(text(view!.root)).toContain("override-34");
  expect(api.revokeLocalOperatorOverride).not.toHaveBeenCalled();
});

it("input edits synchronously invalidate the native reviewed profile", async () => {
  profiles = [profile]; await render(); await click(`Edit ${profile.label}`); await click("Review profile change");
  const confirm = button("Apply reviewed permission change").props.onClick;
  await change("Profile name", "Newer draft"); await act(async () => confirm());
  expect(api.updatePermissionProfile).not.toHaveBeenCalled(); expect(field("Profile name").props.value).toBe("Newer draft");
});

it("retains a native unknown write and its dirty draft after remount", async () => {
  profiles = [profile]; api.updatePermissionProfile.mockRejectedValue(new Error("response lost"));
  await render(); await click(`Edit ${profile.label}`); await change("Profile name", "Uncertain draft");
  await click("Review profile change"); await click("Apply reviewed permission change");
  await act(async () => view?.unmount()); view = undefined; await render(); await click(`Edit ${profile.label}`);
  expect(field("Profile name").props.value).toBe("Uncertain draft"); expect(text(view!.root)).toContain("Unsaved");
  expect(text(view!.root)).toContain("Retry is locked"); expect(button("Review profile change").props.disabled).toBe(true);
  expect(button("Review profile archive").props.disabled).toBe(true); expect(api.updatePermissionProfile).toHaveBeenCalledOnce();
});

it("reviews temporary scope, expiry and no-CAS limits, with zero writes after cancel", async () => {
  surface = "overrides"; await render(); await change("Override reason", override.reason, "textarea");
  await act(async () => view!.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }));
  await click("Review temporary override");
  expect(text(view!.root)).toContain("The override API has no revision token"); expect(text(view!.root)).toContain("600 seconds");
  await click("Cancel permission change"); expect(api.createLocalOperatorOverride).not.toHaveBeenCalled();
  expect(field("Override reason", "textarea").props.value).toBe(override.reason);
});

it("uses the exact current override record when reviewing an end request", async () => {
  surface = "overrides"; api.fetchActiveLocalOperatorOverrides.mockResolvedValue({ items: [override] });
  await render(); await click("Review ending override");
  expect(text(view!.root)).toContain(override.reason); expect(text(view!.root)).toContain("End a temporary override");
  await click("Cancel permission change"); expect(api.revokeLocalOperatorOverride).not.toHaveBeenCalled();
});
