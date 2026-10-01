// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionProfileSelectionReview, PermissionProfileSnapshotRecord } from "@goatcitadel/contracts";
import {
  __resetPermissionActivationsForTests,
  usePermissionProfileActivation,
} from "./use-permission-profile-activation";

const api = vi.hoisted(() => ({
  activatePermissionProfile: vi.fn(),
  reviewPermissionProfileSelection: vi.fn(),
  fetchSettings: vi.fn(),
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
const reviewFor = (input: PermissionProfileSelectionReview["input"]): PermissionProfileSelectionReview => ({
  revision: "b".repeat(64),
  input,
  profile,
  target: { workspaceId: input.operation === "activate" ? input.workspaceId : undefined, operatorId: "operator-1" },
  activeProfiles: [],
});
let view: ReactTestRenderer;
let hook: ReturnType<typeof usePermissionProfileActivation>;
let options: Parameters<typeof usePermissionProfileActivation>[0];
function Harness() {
  hook = usePermissionProfileActivation(options);
  return null;
}
async function render() {
  await act(async () => {
    const tree = (
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    if (view) view.update(tree);
    else view = create(tree);
  });
}
async function review() {
  await act(async () => {
    await hook.request();
  });
}
async function confirm() {
  await act(async () => {
    await hook.confirm();
  });
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
  __resetPermissionActivationsForTests();
  options = {
    key: "profile",
    workspaceId: "work-a",
    profile,
    available: true,
    deploymentProfile: "local_dev",
    reload: vi.fn(async () => {}),
  };
  api.reviewPermissionProfileSelection.mockImplementation(async (input) => reviewFor(input));
  api.fetchSettings.mockResolvedValue({ deploymentProfile: "local_dev" });
  api.activatePermissionProfile.mockImplementation(async (input) => ({
    ...input,
    activationId: "activation-1",
    active: true,
    operatorId: "operator-1",
    createdBy: "operator-1",
    createdAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
  }));
});
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  view = undefined as unknown as ReactTestRenderer;
  __resetPermissionActivationsForTests();
});

describe("shared permission profile activation", () => {
  it("reviews exact workspace Chat, rechecks it, commits both revisions and refreshes the owner", async () => {
    await render();
    await review();
    expect(api.activatePermissionProfile).not.toHaveBeenCalled();
    expect(hook.review?.target.workspaceId).toBe("work-a");
    await confirm();
    expect(api.reviewPermissionProfileSelection).toHaveBeenCalledTimes(2);
    expect(api.activatePermissionProfile).toHaveBeenCalledExactlyOnceWith({
      profileId: "safe",
      workspaceId: "work-a",
      surface: "chat",
      expectedProfileRevision: profile.revision,
      expectedSelectionRevision: "b".repeat(64),
    });
    expect(options.reload).toHaveBeenCalledOnce();
    expect(hook.notice).toContain("recorded by the Gateway");
    expect(hook.locked).toBe(false);
  });
  it("cancels without dispatch and permits a new explicit review", async () => {
    await render();
    await review();
    await act(async () => hook.clear());
    await confirm();
    expect(api.activatePermissionProfile).not.toHaveBeenCalled();
    await review();
    await confirm();
    expect(api.activatePermissionProfile).toHaveBeenCalledOnce();
  });
  it.each(["workspace", "surface", "profile", "operator", "revision"])(
    "withholds a mismatched initial %s review",
    async (field) => {
      api.reviewPermissionProfileSelection.mockImplementation(async (input) => {
        const value = reviewFor(input);
        if (field === "workspace") value.target.workspaceId = "foreign";
        if (field === "surface" && value.input.operation === "activate")
          value.input = { ...value.input, surface: "all" };
        if (field === "profile") value.profile = { ...profile, profileId: "foreign" };
        if (field === "operator") value.target.operatorId = undefined;
        if (field === "revision") value.revision = "not-a-revision";
        return value;
      });
      await render();
      await review();
      expect(hook.review).toBeUndefined();
      await confirm();
      expect(api.activatePermissionProfile).not.toHaveBeenCalled();
    },
  );
  it.each(["selection", "same-id-profile"])("rejects a changed %s during fresh confirmation", async (change) => {
    await render();
    await review();
    api.reviewPermissionProfileSelection.mockImplementationOnce(async (input) => {
      const current = reviewFor(input);
      if (change === "selection") current.revision = "c".repeat(64);
      else current.profile = { ...profile, label: "Changed rules label", allow: ["changed.*"] };
      return current;
    });
    await confirm();
    expect(api.activatePermissionProfile).not.toHaveBeenCalled();
    expect(hook.notice).toContain("changed");
  });
  it("invalidates a visible same-ID profile edit", async () => {
    await render();
    await review();
    options = { ...options, profile: { ...profile, deny: ["file.*"] } };
    await render();
    expect(hook.review).toBeUndefined();
    await confirm();
    expect(api.activatePermissionProfile).not.toHaveBeenCalled();
  });
  it("keeps unavailable and foreign profiles inert", async () => {
    options = { ...options, profile: { ...profile, scope: "workspace", scopeRef: "foreign" } };
    await render();
    await review();
    expect(api.reviewPermissionProfileSelection).not.toHaveBeenCalled();
    options = { ...options, profile, available: false };
    await render();
    await review();
    expect(api.reviewPermissionProfileSelection).not.toHaveBeenCalled();
  });
  it("checks Remote Hardened at both review availability and dispatch", async () => {
    const bypass = { ...profile, approvalMode: "bypass" as const };
    options = { ...options, profile: bypass, deploymentProfile: "remote_hardened" };
    await render();
    await review();
    expect(api.reviewPermissionProfileSelection).not.toHaveBeenCalled();
    options = { ...options, deploymentProfile: "local_dev" };
    api.reviewPermissionProfileSelection.mockImplementation(async (input) => ({
      ...reviewFor(input),
      profile: bypass,
    }));
    await render();
    await review();
    api.fetchSettings.mockResolvedValueOnce({ deploymentProfile: "remote_hardened" });
    await confirm();
    expect(api.activatePermissionProfile).not.toHaveBeenCalled();
  });
  it.each(["navigate", "away-back", "unmount", "cancel"])("cancels fresh-check dispatch after %s", async (change) => {
    const wait = deferred<{ deploymentProfile: string }>();
    await render();
    await review();
    api.fetchSettings.mockReturnValueOnce(wait.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = hook.confirm();
    });
    if (change === "unmount") await act(async () => view.unmount());
    else if (change === "cancel") await act(async () => hook.clear());
    else {
      options = { ...options, workspaceId: "work-b" };
      await render();
      if (change === "away-back") {
        options = { ...options, workspaceId: "work-a" };
        await render();
      }
    }
    await act(async () => {
      wait.resolve({ deploymentProfile: "local_dev" });
      await pending;
    });
    expect(api.activatePermissionProfile).not.toHaveBeenCalled();
    expect(options.reload).not.toHaveBeenCalled();
  });
  it("prevents duplicate confirmation and retains an unknown outcome across remount", async () => {
    const wait = deferred<never>();
    await render();
    await review();
    api.activatePermissionProfile.mockReturnValueOnce(wait.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = hook.confirm();
      void hook.confirm();
    });
    expect(api.activatePermissionProfile).toHaveBeenCalledOnce();
    await act(async () => {
      wait.resolve(undefined as never);
      await pending;
    });
    expect(hook.uncertain).toBe(true);
    await act(async () => view.unmount());
    view = undefined as unknown as ReactTestRenderer;
    await render();
    await review();
    await confirm();
    expect(hook.locked).toBe(true);
    expect(api.activatePermissionProfile).toHaveBeenCalledOnce();
  });
  it.each([false, true])("only releases a definitive uncommitted conflict (committed=%s)", async (committed) => {
    await render();
    await review();
    api.activatePermissionProfile.mockRejectedValueOnce({
      status: 409,
      body: { code: "WRITE_CONFLICT", committed, details: { reason: "PERMISSION_SELECTION_REVISION_CONFLICT" } },
    });
    await confirm();
    expect(hook.locked).toBe(committed);
    expect(hook.uncertain).toBe(committed);
  });
  it("keeps a valid receipt from restoring a departed scope or triggering its reload", async () => {
    const wait = deferred<unknown>();
    const receipt = {
      activationId: "saved",
      profileId: "safe",
      workspaceId: "work-a",
      surface: "chat",
      active: true,
      operatorId: "operator-1",
      createdBy: "operator-1",
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
    await render();
    await review();
    api.activatePermissionProfile.mockReturnValueOnce(wait.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = hook.confirm();
    });
    options = { ...options, workspaceId: "work-b" };
    await render();
    await act(async () => {
      wait.resolve(receipt);
      await pending;
    });
    expect(hook.notice).toBeUndefined();
    expect(options.reload).not.toHaveBeenCalled();
  });
});
