// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { LocalOperatorOverrideRecord, PermissionProfileSelectionReviewRequest, PermissionProfileSnapshotRecord } from "@goatcitadel/contracts";
import { gatewayAuthSettingsFixture } from "./gateway-auth.test-support";
import { __resetPermissionManagementForTests, usePermissionManagement } from "./use-permission-management";
import { permissionCreateFixture as createInput, permissionFieldsFixture as fields, permissionProfileFixture as profile,
  permissionOverrideFixture as override, permissionOverrideCreateFixture as overrideInput } from "./permission-management.test-support";
import type { PermissionManagementOperation } from "./permission-management-binding";

const api = vi.hoisted(() => ({ getGatewayApiBaseUrl: vi.fn(), fetchSettings: vi.fn(), fetchPermissionProfiles: vi.fn(),
  fetchActiveLocalOperatorOverrides: vi.fn(), reviewPermissionProfileSelection: vi.fn(), createPermissionProfile: vi.fn(),
  updatePermissionProfile: vi.fn(), archivePermissionProfile: vi.fn(), createLocalOperatorOverride: vi.fn(), revokeLocalOperatorOverride: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
let view: ReactTestRenderer | undefined;
let hook: ReturnType<typeof usePermissionManagement>;
let options: Parameters<typeof usePermissionManagement>[0];
let profiles: PermissionProfileSnapshotRecord[];
let overrides: LocalOperatorOverrideRecord[];
function Harness() { hook = usePermissionManagement(options); return null; }
async function render() { await act(async () => { const element = <StrictMode><Harness /></StrictMode>; if (view) view.update(element); else view = create(element); }); }
async function request(input: PermissionManagementOperation = createInput, callback?: (receipt: PermissionProfileSnapshotRecord | LocalOperatorOverrideRecord) => void) { await act(async () => { await hook.request(input, callback); }); }
async function confirm() { await act(async () => { await hook.confirm(); }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks(); __resetPermissionManagementForTests(); profiles = []; overrides = [];
  options = { workspaceId: "work-a", identity: "editor-a", reload: vi.fn(async () => {}) };
  api.getGatewayApiBaseUrl.mockReturnValue("http://gateway-a");
  api.fetchSettings.mockResolvedValue(gatewayAuthSettingsFixture());
  api.fetchPermissionProfiles.mockImplementation(async () => ({ items: profiles }));
  api.fetchActiveLocalOperatorOverrides.mockImplementation(async () => ({ items: overrides }));
  api.createPermissionProfile.mockImplementation(async () => { profiles = [profile]; return profile; });
  api.updatePermissionProfile.mockImplementation(async () => { profiles = [{ ...profile, revision: "b".repeat(64), updatedAt: "2026-09-30T00:00:01.000Z" }]; return profiles[0]; });
  api.archivePermissionProfile.mockImplementation(async () => { profiles = [{ ...profile, status: "archived", revision: "c".repeat(64), updatedAt: "2026-09-30T00:00:01.000Z", archivedAt: "2026-09-30T00:00:01.000Z" }]; return { archived: true, profileId: profile.profileId }; });
  api.createLocalOperatorOverride.mockImplementation(async () => { overrides = [override]; return override; });
  api.revokeLocalOperatorOverride.mockImplementation(async () => { overrides = []; const record = { ...override, status: "revoked", revokedBy: "operator-a", revokedAt: "2026-09-30T00:01:00.000Z" }; return { revoked: true, overrideId: override.overrideId, status: record.status, revokedBy: record.revokedBy, revokedAt: record.revokedAt, override: record }; });
  api.reviewPermissionProfileSelection.mockImplementation(async (input: PermissionProfileSelectionReviewRequest) => ({
    revision: "d".repeat(64), input, profile: input.profileId ? profile : undefined, target: { workspaceId: "work-a" }, activeProfiles: [],
  }));
});
afterEach(async () => { if (view) await act(async () => view?.unmount()); view = undefined; __resetPermissionManagementForTests(); });

describe("shared permission management owner", () => {
  it("reviews without writes, then creates exact fields and independently reads the scoped owner", async () => {
    await render(); await request(); expect(api.createPermissionProfile).not.toHaveBeenCalled(); await confirm();
    expect(api.createPermissionProfile).toHaveBeenCalledExactlyOnceWith({ scope: "workspace", scopeRef: "work-a", ...fields, expectedSelectionRevision: undefined });
    expect(api.fetchPermissionProfiles).toHaveBeenCalledTimes(3);
    expect(options.reload).toHaveBeenCalledOnce(); expect(hook.locked(createInput)).toBe(false);
  });
  it("cancels an existing review and an old queued confirmation without a write", async () => {
    await render(); await request(); const oldConfirm = hook.confirm; await act(async () => hook.invalidate());
    await act(async () => { await oldConfirm(); }); expect(api.createPermissionProfile).not.toHaveBeenCalled();
  });
  it.each(["scope", "draft", "installation"])("withholds initial late %s review and clears its checking indicator", async (kind) => {
    const pending = deferred<ReturnType<typeof gatewayAuthSettingsFixture>>(); api.fetchSettings.mockReturnValueOnce(pending.promise);
    await render(); let task!: Promise<boolean>; await act(async () => { task = hook.request(createInput); });
    if (kind === "scope") options.workspaceId = "work-b"; else if (kind === "draft") options.identity = "edited"; else api.getGatewayApiBaseUrl.mockReturnValue("http://gateway-b");
    await render(); expect(hook.checking).toBe(false);
    await act(async () => { pending.resolve(gatewayAuthSettingsFixture()); await task; }); expect(hook.review).toBeUndefined();
  });
  it.each(["scope", "input"])("cancels preflight when %s leaves and returns to the same value", async (kind) => {
    await render(); await request(); const pending = deferred<ReturnType<typeof gatewayAuthSettingsFixture>>(); api.fetchSettings.mockReturnValueOnce(pending.promise);
    let task!: Promise<boolean>; await act(async () => { task = hook.confirm(); });
    if (kind === "scope") { options.workspaceId = "work-b"; await render(); options.workspaceId = "work-a"; await render(); }
    else { await act(async () => hook.invalidate()); await act(async () => hook.invalidate()); }
    await act(async () => { pending.resolve(gatewayAuthSettingsFixture()); await task; });
    expect(api.createPermissionProfile).not.toHaveBeenCalled(); expect(hook.locked(createInput)).toBe(false);
  });
  it("rejects changed deployment revision before dispatch", async () => {
    await render(); await request(); api.fetchSettings.mockResolvedValue({ ...gatewayAuthSettingsFixture(), revision: 999 });
    await confirm(); expect(api.createPermissionProfile).not.toHaveBeenCalled();
  });
  it("rejects a changed exact profile before dispatch", async () => {
    profiles = [profile]; const input: PermissionManagementOperation = { kind: "update", profile, fields };
    await render(); await request(input); profiles = [{ ...profile, label: "Changed owner" }]; await confirm();
    expect(api.updatePermissionProfile).not.toHaveBeenCalled();
  });
  it("uses canonical normalized default review and both revisions for edits", async () => {
    profiles = [profile]; const input: PermissionManagementOperation = { kind: "update", profile, fields: { ...fields, defaultForSurfaces: ["chat"] } };
    api.updatePermissionProfile.mockImplementation(async () => { profiles = [{ ...profile, defaultForSurfaces: ["chat"], revision: "b".repeat(64), updatedAt: "2026-09-30T00:00:01.000Z" }]; return profiles[0]; });
    await render(); await request(input); await confirm();
    expect(api.reviewPermissionProfileSelection).toHaveBeenCalledWith({ operation: "defaults", profileId: profile.profileId, scope: "workspace", scopeRef: "work-a", defaultForSurfaces: ["chat"] });
    expect(api.updatePermissionProfile).toHaveBeenCalledWith(profile.profileId, { ...input.fields, expectedRevision: profile.revision, expectedSelectionRevision: "d".repeat(64) });
  });
  it("archives only an exact receipt plus immutable archived owner readback", async () => {
    profiles = [profile]; await render(); await request({ kind: "archive", profile }); await confirm();
    expect(api.archivePermissionProfile).toHaveBeenCalledExactlyOnceWith(profile.profileId, { expectedRevision: profile.revision }); expect(options.reload).toHaveBeenCalledOnce();
  });
  it.each(["scope", "rules", "identity", "readback"])("retains uncertainty for wrong %s result", async (kind) => {
    api.createPermissionProfile.mockImplementation(async () => {
      const receipt = { ...profile, ...(kind === "scope" ? { scopeRef: "foreign" } : kind === "rules" ? { allow: ["*"] } : kind === "identity" ? { profileId: "" } : {}) };
      profiles = kind === "readback" ? [] : [receipt]; return receipt;
    });
    await render(); await request(); await confirm(); expect(hook.attemptFor(createInput)?.phase).toBe("uncertain"); expect(options.reload).not.toHaveBeenCalled();
  });
  it("serializes duplicate confirmations before dispatch", async () => {
    await render(); await request(); await act(async () => { await Promise.all([hook.confirm(), hook.confirm()]); }); expect(api.createPermissionProfile).toHaveBeenCalledOnce();
  });
  it("retains a dispatched unknown profile across shell remount and blocks archive of the same ID", async () => {
    profiles = [profile]; const input: PermissionManagementOperation = { kind: "update", profile, fields }; api.updatePermissionProfile.mockRejectedValue(new Error("response lost"));
    await render(); await request(input); await confirm(); await act(async () => view?.unmount()); view = undefined;
    options.identity = "classic-editor"; await render(); expect(hook.locked({ kind: "archive", profile })).toBe(true);
    await request({ kind: "archive", profile }); await confirm(); expect(api.archivePermissionProfile).not.toHaveBeenCalled();
  });
  it("retains an exact rejected profile revision across shells until a different canonical record is reviewed", async () => {
    profiles = [profile]; const input: PermissionManagementOperation = { kind: "update", profile, fields };
    api.updatePermissionProfile.mockRejectedValueOnce({ status: 409, body: { code: "WRITE_CONFLICT", details: { reason: "PERMISSION_PROFILE_REVISION_CONFLICT" } } });
    await render(); await request(input); await confirm();
    expect(hook.attemptFor(input)?.phase).toBe("rejected");
    await act(async () => view?.unmount()); view = undefined; options.identity = "classic"; await render();
    await request(input); await confirm(); expect(api.updatePermissionProfile).toHaveBeenCalledOnce();
    const current = { ...profile, revision: "d".repeat(64) }; profiles = [current];
    const rebased: PermissionManagementOperation = { kind: "update", profile: current, fields };
    expect(hook.locked(rebased)).toBe(false); await request(rebased); await confirm();
    expect(api.updatePermissionProfile).toHaveBeenCalledTimes(2); expect(hook.locked(rebased)).toBe(false);
  });
  it("allows a new selection review after an uncommitted default-selection conflict without rejecting the profile revision", async () => {
    profiles = [profile]; const input: PermissionManagementOperation = { kind: "update", profile, fields: { ...fields, defaultForSurfaces: ["chat"] } };
    api.updatePermissionProfile.mockRejectedValueOnce({ status: 409, body: { code: "WRITE_CONFLICT", details: { reason: "PERMISSION_SELECTION_REVISION_CONFLICT" } } });
    await render(); await request(input); await confirm();
    expect(hook.attemptFor(input)).toBeUndefined(); expect(hook.review).toBeUndefined();
    await request(input); expect(hook.review?.selection?.profile?.revision).toBe(profile.revision);
    expect(api.updatePermissionProfile).toHaveBeenCalledOnce();
  });
  it("does not classify a committed-marked conflict as safe to retry", async () => {
    profiles = [profile]; const input: PermissionManagementOperation = { kind: "update", profile, fields };
    api.updatePermissionProfile.mockRejectedValueOnce({ status: 409, body: { code: "WRITE_CONFLICT", details: { reason: "PERMISSION_PROFILE_REVISION_CONFLICT", mutationCommitted: true } } });
    await render(); await request(input); await confirm(); expect(hook.attemptFor(input)?.phase).toBe("uncertain");
  });
  it("acknowledges the origin after unmount without refreshing the new view", async () => {
    const pending = deferred<PermissionProfileSnapshotRecord>(); const ack = vi.fn(); api.createPermissionProfile.mockReturnValueOnce(pending.promise);
    await render(); await request(createInput, ack); let task!: Promise<boolean>; await act(async () => { task = hook.confirm(); });
    await act(async () => view?.unmount()); view = undefined; profiles = [profile];
    await act(async () => { pending.resolve(profile); await task; }); expect(ack).toHaveBeenCalledExactlyOnceWith(profile); expect(options.reload).not.toHaveBeenCalled();
  });
  it("keeps a verified write confirmed if the editor acknowledgement fails", async () => {
    await render(); await request(createInput, () => { throw new Error("editor failed"); }); await confirm();
    expect(hook.locked(createInput)).toBe(false); expect(hook.message).toContain("could not be acknowledged"); expect(options.reload).toHaveBeenCalledOnce();
  });
  it("refreshes a current confirmed origin even when acknowledgement changes the editor input", async () => {
    await render(); await request(createInput, () => { options.identity = "acknowledged"; view?.update(<StrictMode><Harness /></StrictMode>); });
    await confirm(); expect(options.reload).toHaveBeenCalledOnce(); expect(hook.locked(createInput)).toBe(false);
  });
  it("starts and revokes an exact scoped database-expiring override without pretending to submit CAS", async () => {
    await render(); await request(overrideInput); await confirm(); expect(api.createLocalOperatorOverride).toHaveBeenCalledExactlyOnceWith(overrideInput.kind === "override-create" ? overrideInput.input : undefined);
    await request({ kind: "override-revoke", override }); await confirm(); expect(api.revokeLocalOperatorOverride).toHaveBeenCalledExactlyOnceWith(override.overrideId);
  });
  it("retains unknown override admission across workspace and shell remount", async () => {
    api.createLocalOperatorOverride.mockRejectedValue(new Error("response lost")); await render(); await request(overrideInput); await confirm();
    await act(async () => view?.unmount()); view = undefined; options.workspaceId = "work-b"; options.identity = "classic"; await render();
    const second: PermissionManagementOperation = { kind: "override-create", input: { scope: "workspace", scopeRef: "work-b", reason: "Second", ttlSeconds: 60 } };
    expect(hook.locked(second)).toBe(true); await request(second); await confirm(); expect(api.createLocalOperatorOverride).toHaveBeenCalledOnce();
  });
  it("rejects override expiry, state and remote-hardening mismatches before success", async () => {
    api.createLocalOperatorOverride.mockResolvedValue({ ...override, expiresAt: "2026-09-30T02:00:00.000Z" }); await render(); await request(overrideInput); await confirm();
    expect(hook.attemptFor(overrideInput)?.phase).toBe("uncertain");
  });
  it("withholds local overrides when the fresh deployment is remote hardened", async () => {
    api.fetchSettings.mockResolvedValue({ ...gatewayAuthSettingsFixture(), deploymentProfile: "remote_hardened" }); await render(); await request(overrideInput);
    expect(hook.review).toBeUndefined(); await confirm(); expect(api.createLocalOperatorOverride).not.toHaveBeenCalled();
  });
});
