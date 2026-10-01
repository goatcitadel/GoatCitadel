import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddonInstalledRecord, AddonStatusRecord } from "@goatcitadel/contracts";
import { __resetAddonAttemptsForTests, commitAddonReview, type AddonReview } from "./addon-lifecycle";
import { addonActionAvailable, assertAddonStatus } from "./addon-owner-binding";

const api = vi.hoisted(() => ({
  base: "http://addon-owner",
  fetchAddonStatus: vi.fn(),
  fetchInstalledAddons: vi.fn(),
  installAddon: vi.fn(),
  updateAddon: vi.fn(),
  enableAddon: vi.fn(),
  disableAddon: vi.fn(),
  launchAddon: vi.fn(),
  stopAddon: vi.fn(),
  uninstallAddon: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.base }));
const pin = "a".repeat(40),
  stamp = "2026-09-30T12:00:00.000Z";
const uninstalled: AddonStatusRecord = {
  addon: {
    addonId: "arena",
    label: "Arena",
    description: "Fixture only",
    owner: "publisher",
    repoUrl: "https://example.invalid/fixture",
    sameOwnerAsGoatCitadel: false,
    trustTier: "restricted",
    category: "fun_optional",
    runtimeType: "separate_repo_app",
    installCommands: [{ command: "git", args: ["checkout", "--detach", pin] }],
    webEntryMode: "external_local_url",
    requiresSeparateRepoDownload: true,
    healthChecks: [],
  },
  status: "not_installed",
  healthChecks: [],
};
const record: AddonInstalledRecord = {
  addonId: "arena",
  installedPath: "C:/fixture/arena",
  repoUrl: uninstalled.addon.repoUrl,
  owner: "publisher",
  sameOwnerAsGoatCitadel: false,
  trustTier: "restricted",
  runtimeType: "separate_repo_app",
  webEntryMode: "external_local_url",
  installRef: pin,
  installedAt: stamp,
  updatedAt: stamp,
  consentedAt: stamp,
  consentedBy: "operator",
  enabled: false,
  runtimeStatus: "disabled",
};
const disabled: AddonStatusRecord = { ...uninstalled, installed: record, status: "disabled" };
let status: AddonStatusRecord;
const review = (overrides: Partial<AddonReview> = {}): AddonReview => ({
  base: api.base,
  action: "install",
  status: structuredClone(status),
  current: () => true,
  ...overrides,
});
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
  api.base = "http://addon-owner";
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No live transport in add-on owner tests");
    }),
  );
  status = structuredClone(uninstalled);
  api.fetchAddonStatus.mockImplementation(async () => structuredClone(status));
  api.fetchInstalledAddons.mockImplementation(async () => ({
    items: status.installed ? [structuredClone(status.installed)] : [],
  }));
  api.installAddon.mockImplementation(async () => {
    status = structuredClone(disabled);
    return { status: structuredClone(status) };
  });
});

describe("shared add-on lifecycle", () => {
  it("requires exact fresh owner evidence and confirms a disabled immutable install by independent readback", async () => {
    expect((await commitAddonReview(review())).kind).toBe("confirmed");
    expect(api.installAddon).toHaveBeenCalledExactlyOnceWith("arena", {
      confirmRepoDownload: true,
      actorId: "operator",
    });
    expect(api.fetchAddonStatus).toHaveBeenCalledTimes(2);
    expect(api.launchAddon).not.toHaveBeenCalled();
    expect(api.enableAddon).not.toHaveBeenCalled();
  });
  it("cancelled reviews dispatch nothing", async () => {
    expect((await commitAddonReview(review({ current: () => false }))).kind).toBe("cancelled");
    expect(api.fetchAddonStatus).not.toHaveBeenCalled();
    expect(api.installAddon).not.toHaveBeenCalled();
  });
  it("rejects owner drift before dispatch without retaining a false unknown lock", async () => {
    const reviewed = review();
    status = { ...status, healthChecks: [{ key: "changed", status: "warn", message: "Owner changed" }] };
    expect((await commitAddonReview(reviewed)).kind).toBe("blocked");
    expect(api.installAddon).not.toHaveBeenCalled();
    expect((await commitAddonReview(review())).kind).toBe("confirmed");
  });
  it("withholds unavailable action states and contradictory identity", async () => {
    status = structuredClone(disabled);
    expect((await commitAddonReview(review())).kind).toBe("blocked");
    expect(api.installAddon).not.toHaveBeenCalled();
    expect(() => assertAddonStatus({ ...disabled, installed: { ...record, addonId: "foreign" } }, "arena")).toThrow();
    expect(() =>
      assertAddonStatus(
        { ...disabled, status: "not_installed", installed: { ...record, runtimeStatus: "not_installed" } },
        "arena",
      ),
    ).toThrow();
  });
  it("invalidates a view/input ABA while the preflight read is pending", async () => {
    const read = deferred<AddonStatusRecord>();
    let current = true;
    api.fetchAddonStatus.mockReturnValueOnce(read.promise);
    const operation = commitAddonReview(review({ current: () => current }));
    current = false;
    read.resolve(structuredClone(uninstalled));
    expect((await operation).kind).toBe("cancelled");
    expect(api.installAddon).not.toHaveBeenCalled();
  });
  it("serializes duplicate writes throughout preflight and dispatch", async () => {
    const read = deferred<AddonStatusRecord>();
    api.fetchAddonStatus.mockReturnValueOnce(read.promise);
    const first = commitAddonReview(review());
    expect((await commitAddonReview(review())).kind).toBe("blocked");
    read.resolve(structuredClone(uninstalled));
    expect((await first).kind).toBe("confirmed");
    expect(api.installAddon).toHaveBeenCalledTimes(1);
  });
  it("retains transport uncertainty across later callers and refreshes in the same installation", async () => {
    api.installAddon.mockRejectedValueOnce(new Error("Response lost after dispatch"));
    expect((await commitAddonReview(review())).kind).toBe("uncertain");
    expect((await commitAddonReview(review())).kind).toBe("blocked");
    expect(api.installAddon).toHaveBeenCalledTimes(1);
  });
  it.each(["foreign", "pin", "enabled", "identity", "readback"])(
    "retains uncertainty for an invalid %s receipt/readback",
    async (failure) => {
      api.installAddon.mockImplementationOnce(async () => {
        status = structuredClone(disabled);
        const receipt = structuredClone(status);
        if (failure === "foreign") receipt.addon.addonId = "foreign";
        if (failure === "pin") receipt.installed!.installRef = "b".repeat(40);
        if (failure === "enabled") receipt.installed!.enabled = true;
        if (failure === "identity") receipt.installed!.consentedBy = "";
        if (failure === "readback") status.installed!.updatedAt = "2026-09-30T12:01:00.000Z";
        return { status: receipt };
      });
      expect((await commitAddonReview(review())).kind).toBe("uncertain");
      expect((await commitAddonReview(review())).kind).toBe("blocked");
    },
  );
  it("verifies an original dispatched action after navigation without granting the new view authority", async () => {
    let current = true;
    api.installAddon.mockImplementationOnce(async () => {
      current = false;
      status = structuredClone(disabled);
      return { status: structuredClone(status) };
    });
    expect((await commitAddonReview(review({ current: () => current }))).kind).toBe("confirmed");
    expect(api.fetchAddonStatus).toHaveBeenCalledTimes(2);
  });
  it("retains the original installation lock if its transport changes after dispatch", async () => {
    const oldReview = review();
    api.installAddon.mockImplementationOnce(async () => {
      api.base = "http://another-installation";
      return { status: structuredClone(disabled) };
    });
    expect((await commitAddonReview(oldReview)).kind).toBe("uncertain");
    api.base = oldReview.base;
    expect((await commitAddonReview(review())).kind).toBe("blocked");
  });
  it("requires exact uninstall receipt and two independent absence owners", async () => {
    status = structuredClone(disabled);
    api.uninstallAddon.mockImplementationOnce(async () => {
      status = structuredClone(uninstalled);
      return { addonId: "arena", removed: true };
    });
    expect((await commitAddonReview(review({ action: "uninstall" }))).kind).toBe("confirmed");
    expect(api.fetchInstalledAddons).toHaveBeenCalledTimes(1);
  });
  it("does not invent uninstall success from a false receipt or remaining installed record", async () => {
    status = structuredClone(disabled);
    api.uninstallAddon.mockResolvedValueOnce({ addonId: "arena", removed: true });
    expect((await commitAddonReview(review({ action: "uninstall" }))).kind).toBe("uncertain");
  });
  it("keeps launch error distinct from a confirmed healthy process and withholds unsupported launch", async () => {
    status = { ...disabled, status: "installed", installed: { ...record, enabled: true, runtimeStatus: "installed" } };
    const before = review({ action: "launch" });
    api.launchAddon.mockImplementationOnce(async () => {
      status = {
        ...status,
        status: "error",
        installed: { ...status.installed!, runtimeStatus: "error", lastError: "Health failed" },
      };
      return { status: structuredClone(status) };
    });
    const result = await commitAddonReview(before);
    expect(result.kind).toBe("confirmed");
    if (result.kind === "confirmed") expect(result.status.status).toBe("error");
    expect(addonActionAvailable("launch", { ...status, addon: { ...status.addon, addonId: "other" } })).toBe(false);
  });
});
