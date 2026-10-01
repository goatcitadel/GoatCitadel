import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddonStatusRecord } from "@goatcitadel/contracts";
import { useAddonSettings } from "./use-addon-settings";
import { __resetAddonAttemptsForTests } from "./addon-lifecycle";
import { __resetSessionViewStateForTests } from "../../../../hooks/use-session-view-state";

const api = vi.hoisted(() => ({
  fetchAddonsCatalog: vi.fn(),
  fetchInstalledAddons: vi.fn(),
  fetchAddonStatus: vi.fn(),
  installAddon: vi.fn(),
  updateAddon: vi.fn(),
  enableAddon: vi.fn(),
  disableAddon: vi.fn(),
  launchAddon: vi.fn(),
  stopAddon: vi.fn(),
  uninstallAddon: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://addon-view",
}));
const initial: AddonStatusRecord = {
  addon: {
    addonId: "arena",
    label: "Arena",
    description: "Display fixture",
    owner: "publisher",
    repoUrl: "https://example.invalid/fixture",
    sameOwnerAsGoatCitadel: false,
    trustTier: "restricted",
    category: "fun_optional",
    runtimeType: "separate_repo_app",
    installCommands: [{ command: "git", args: ["checkout", "--detach", "a".repeat(40)] }],
    webEntryMode: "none",
    requiresSeparateRepoDownload: true,
    healthChecks: [],
  },
  status: "not_installed",
  healthChecks: [],
};
let owner: ReturnType<typeof useAddonSettings>, root: ReactTestRenderer;
function Harness() {
  owner = useAddonSettings();
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetAddonAttemptsForTests();
  __resetSessionViewStateForTests();
  api.fetchAddonsCatalog.mockResolvedValue({ items: [initial.addon] });
  api.fetchInstalledAddons.mockResolvedValue({ items: [] });
  api.fetchAddonStatus.mockResolvedValue(structuredClone(initial));
});
async function mount() {
  await act(async () => {
    root = create(<Harness />);
  });
}
describe("shared add-on view lifecycle", () => {
  it("keeps refreshed status when a superseded initial read settles last", async () => {
    const pending = deferred<AddonStatusRecord>();
    await mount();
    api.fetchAddonStatus.mockReturnValueOnce(pending.promise);
    await act(async () => owner.selectAddon("arena"));
    expect(owner.statusLoading).toBe(true);
    const refreshed: AddonStatusRecord = {
      ...initial,
      healthChecks: [{ key: "current", status: "pass", message: "Fresh owner evidence" }],
    };
    api.fetchAddonStatus.mockResolvedValueOnce(refreshed);
    await act(async () => {
      await owner.reload();
    });
    expect(owner.selectedStatus).toEqual(refreshed);
    await act(async () => {
      pending.resolve(structuredClone(initial));
    });
    expect(owner.selectedStatus).toEqual(refreshed);
    await act(async () => root.unmount());
  });
  it("refresh invalidates an exact review before another dispatch can occur", async () => {
    await mount();
    await act(async () => owner.selectAddon("arena"));
    await act(async () => owner.reviewAction("install"));
    expect(owner.review).not.toBeNull();
    await act(async () => {
      await owner.reload();
    });
    expect(owner.review).toBeNull();
    await act(async () => {
      await owner.confirmReview();
    });
    expect(api.installAddon).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
  it("selection ABA cancels pending preflight and retains the new view", async () => {
    await mount();
    await act(async () => owner.selectAddon("arena"));
    await act(async () => owner.reviewAction("install"));
    const pending = deferred<AddonStatusRecord>();
    api.fetchAddonStatus.mockReturnValueOnce(pending.promise);
    let confirmation!: Promise<void>;
    await act(async () => {
      confirmation = owner.confirmReview();
    });
    await act(async () => owner.selectAddon(""));
    await act(async () => owner.selectAddon("arena"));
    await act(async () => {
      pending.resolve(structuredClone(initial));
      await confirmation;
    });
    expect(api.installAddon).not.toHaveBeenCalled();
    expect(owner.review).toBeNull();
    expect(owner.selectedAddonId).toBe("arena");
    await act(async () => root.unmount());
  });
});
