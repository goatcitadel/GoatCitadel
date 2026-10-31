import { beforeEach, describe, expect, it, vi } from "vitest";
import { enableCodeMode } from "./enable-code-mode";

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  approvePlanInPlace: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
}));
vi.mock("./channel-setup/approve-plan-in-place", () => ({ approvePlanInPlace: api.approvePlanInPlace }));

function settings(revision: string, features: Record<string, boolean>) {
  return { revision, features };
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
});

describe("enableCodeMode", () => {
  it("turns each flag on in its own governed change, because a Settings plan carries one flag", async () => {
    api.fetchSettings
      .mockResolvedValueOnce(settings("r1", {}))
      .mockResolvedValueOnce(settings("r2", { codeModeV1Enabled: true }));
    api.patchSettings.mockResolvedValue({ changePlanReceipt: { planId: "p", status: "completed" } });

    await enableCodeMode();

    expect(api.patchSettings.mock.calls).toEqual([
      [{ expectedRevision: "r1", features: { codeModeV1Enabled: true } }],
      [{ expectedRevision: "r2", features: { codeModeHostSandboxEnabled: true } }],
    ]);
    expect(api.approvePlanInPlace).not.toHaveBeenCalled();
  });

  it("skips a flag that is already on", async () => {
    api.fetchSettings
      .mockResolvedValueOnce(settings("r1", { codeModeV1Enabled: true }))
      .mockResolvedValueOnce(settings("r1", { codeModeV1Enabled: true }));
    api.patchSettings.mockResolvedValue({ changePlanReceipt: { planId: "p", status: "completed" } });

    await enableCodeMode();

    expect(api.patchSettings).toHaveBeenCalledTimes(1);
    expect(api.patchSettings).toHaveBeenCalledWith({
      expectedRevision: "r1",
      features: { codeModeHostSandboxEnabled: true },
    });
  });

  it("settles each change's approval in place", async () => {
    api.fetchSettings.mockResolvedValueOnce(settings("r1", {})).mockResolvedValueOnce(settings("r2", {}));
    api.patchSettings
      .mockResolvedValueOnce({ changePlanReceipt: { planId: "p1", status: "awaiting_approval" } })
      .mockResolvedValueOnce({ changePlanReceipt: { planId: "p2", status: "awaiting_approval" } });
    api.approvePlanInPlace.mockResolvedValue({ kind: "completed" });

    await enableCodeMode();

    expect(api.approvePlanInPlace.mock.calls).toEqual([
      ["p1", "default"],
      ["p2", "default"],
    ]);
  });

  it("stops at the first change that cannot finish here", async () => {
    api.fetchSettings.mockResolvedValue(settings("r1", {}));
    api.patchSettings.mockResolvedValue({ changePlanReceipt: { planId: "p1", status: "awaiting_approval" } });
    api.approvePlanInPlace.mockResolvedValue({ kind: "elsewhere" });

    await expect(enableCodeMode()).rejects.toThrow("Turning on Code Mode needs an approval in Settings or Inbox.");
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
  });
});
