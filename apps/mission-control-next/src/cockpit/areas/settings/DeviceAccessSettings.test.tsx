// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceAccessGrantRecord } from "@goatcitadel/contracts";
import type { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { __resetDeviceAccessRevocationsForTests } from "../../../features/native-routes/settings/use-device-access-revocation";
import { DeviceAccessSettings } from "./DeviceAccessSettings";

const api = vi.hoisted(() => ({ fetchDeviceAccessGrants: vi.fn(), revokeDeviceAccessGrant: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("./GatewayAuthSettings", () => ({ GatewayAuthSettings: () => <div>Gateway authentication panel</div> }));
let modal: ComponentProps<typeof ConfirmModal>;
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: ComponentProps<typeof ConfirmModal>) => {
    modal = props;
    return null;
  },
}));
let grants: DeviceAccessGrantRecord[];
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const grant = (id = "grant-1"): DeviceAccessGrantRecord => ({
  grantId: id,
  requestId: `request-${id}`,
  actorId: "device-operator",
  deviceLabel: "Test tablet",
  deviceType: "tablet",
  platform: "Windows",
  grantedBy: "operator",
  createdAt: "2026-09-01T12:00:00.000Z",
  metadata: {},
  principalPurpose: "general_companion",
});
const button = (text: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === text)!;
async function render(show = true) {
  await act(async () =>
    root.render(<QueryClientProvider client={client}>{show ? <DeviceAccessSettings /> : null}</QueryClientProvider>),
  );
  if (show) await vi.waitFor(() => expect(container.textContent).not.toContain("Loading device grants"));
}
async function review() {
  await act(async () => button("Revoke access").click());
}
async function confirm() {
  await act(async () => {
    modal.onConfirm();
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  grants = [grant()];
  api.fetchDeviceAccessGrants.mockImplementation(async () => ({ items: structuredClone(grants) }));
  api.revokeDeviceAccessGrant.mockImplementation(async (id: string) => {
    const record = grants.find((item) => item.grantId === id)!;
    record.revokedAt = "2026-09-30T12:00:00.000Z";
    return { grant: structuredClone(record) };
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
  __resetDeviceAccessRevocationsForTests();
});

describe("cockpit device access", () => {
  it("requires explicit named review and an exact revoked owner receipt", async () => {
    await render();
    await review();
    expect(modal.open).toBe(true);
    expect(modal.message).toContain("Test tablet");
    expect(modal.message).toContain("companion sessions and session controls");
    expect(api.revokeDeviceAccessGrant).not.toHaveBeenCalled();
    await confirm();
    await vi.waitFor(() => expect(container.textContent).toContain("Device access revoked."));
    expect(api.revokeDeviceAccessGrant).toHaveBeenCalledExactlyOnceWith("grant-1");
    expect(button("Revoke access").disabled).toBe(true);
  });
  it("cancels review without issuing a mutation", async () => {
    await render();
    await review();
    await act(async () => modal.onCancel());
    expect(modal.open).toBe(false);
    expect(api.revokeDeviceAccessGrant).not.toHaveBeenCalled();
  });
  it.each(["actorId", "requestId", "deviceLabel", "principalPurpose", "expiresAt"])(
    "rejects a changed %s before mutation",
    async (key) => {
      await render();
      await review();
      grants = [{ ...grants[0]!, [key]: key === "expiresAt" ? "2099-01-01T00:00:00.000Z" : "changed" }];
      await confirm();
      expect(api.revokeDeviceAccessGrant).not.toHaveBeenCalled();
      expect(container.textContent).toContain("device grant changed");
    },
  );
  it("allows a last-used timestamp update without changing the reviewed grant", async () => {
    await render();
    await review();
    grants[0]!.lastUsedAt = new Date().toISOString();
    await confirm();
    expect(api.revokeDeviceAccessGrant).toHaveBeenCalledOnce();
  });
  it("does not submit after navigation while the owner read is pending", async () => {
    await render();
    await review();
    const read = deferred<{ items: DeviceAccessGrantRecord[] }>();
    api.fetchDeviceAccessGrants.mockReturnValueOnce(read.promise);
    await confirm();
    await render(false);
    await act(async () => read.resolve({ items: grants }));
    expect(api.revokeDeviceAccessGrant).not.toHaveBeenCalled();
    await render();
    await vi.waitFor(() => expect(button("Revoke access").disabled).toBe(false));
  });
  it("retains pending and unknown result locks across navigation", async () => {
    await render();
    await review();
    const write = deferred<unknown>();
    api.revokeDeviceAccessGrant.mockReturnValueOnce(write.promise);
    await confirm();
    await render(false);
    await render();
    expect(button("Revoke access").disabled).toBe(true);
    await act(async () => write.reject(new Error("response lost")));
    await vi.waitFor(() => expect(container.textContent).toContain("Revocation outcome is uncertain"));
    await render(false);
    await render();
    expect(button("Revoke access").disabled).toBe(true);
    expect(api.revokeDeviceAccessGrant).toHaveBeenCalledOnce();
  });
  it("rejects a substituted receipt and withholds success", async () => {
    await render();
    await review();
    api.revokeDeviceAccessGrant.mockResolvedValueOnce({
      grant: { ...grant("another"), revokedAt: new Date().toISOString() },
    });
    await confirm();
    expect(container.textContent).toContain("Revocation outcome is uncertain");
    expect(container.textContent).not.toContain("Device access revoked.");
  });
  it("withholds cached device controls when refresh fails", async () => {
    await render();
    api.fetchDeviceAccessGrants.mockRejectedValue(new Error("offline"));
    await act(async () => button("Refresh devices").click());
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(button("Revoke access")).toBeUndefined();
  });
  it("bounds the displayed list and exposes more on demand", async () => {
    grants = Array.from({ length: 25 }, (_, index) => grant(`grant-${index}`));
    await render();
    expect(container.querySelectorAll("li")).toHaveLength(20);
    await act(async () => button("Show more devices (20 of 25)").click());
    expect(container.querySelectorAll("li")).toHaveLength(25);
  });
  it("does not offer expired or already revoked grants as active", async () => {
    grants = [
      { ...grant(), expiresAt: "2020-01-01T00:00:00.000Z" },
      { ...grant("revoked"), revokedAt: new Date().toISOString() },
    ];
    await render();
    expect(container.textContent).toContain("Expired");
    expect([...container.querySelectorAll("li button")].every((item) => (item as HTMLButtonElement).disabled)).toBe(
      true,
    );
  });
});

vi.mock("../../../app/use-current-access", () => ({
  useCurrentAccess: () => ({ isSuccess: true, data: { actorId: null, actorSource: "none", operatorAccess: true } }),
}));
