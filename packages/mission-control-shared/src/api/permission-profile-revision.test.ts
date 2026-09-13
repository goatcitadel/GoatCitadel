import { beforeEach, expect, it, vi } from "vitest";
import { activatePermissionProfile, archivePermissionProfile, reviewPermissionProfileSelection, updatePermissionProfile } from "./approvals";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client-core.js", () => ({ request: mocks.request }));
beforeEach(() => { mocks.request.mockReset(); });

it("sends the draft's reviewed revision to the encoded profile update endpoint", async () => {
  const input = { expectedRevision: "a".repeat(64), expectedSelectionRevision: "c".repeat(64), label: "Retained draft" };
  const saved = { profileId: "profile/a", label: input.label, revision: "b".repeat(64) };
  mocks.request.mockResolvedValue(saved);
  expect(await updatePermissionProfile("profile/a", input)).toBe(saved);
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith("/api/v1/tools/permission-profiles/profile%2Fa", {
    method: "PATCH", body: JSON.stringify(input),
  });
});

it("keeps selection review read-only and sends both returned preconditions only when applying", async () => {
  const input = { operation: "activate" as const, profileId: "profile/a", workspaceId: "workspace a", surface: "chat" as const };
  const reviewed = { revision: "b".repeat(64), profile: { revision: "a".repeat(64) } };
  mocks.request.mockResolvedValue(reviewed);
  expect(await reviewPermissionProfileSelection(input)).toBe(reviewed);
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith("/api/v1/tools/permission-profiles/selection-review", { method: "POST", body: JSON.stringify(input) });
  const mutation = { profileId: input.profileId, workspaceId: input.workspaceId, surface: input.surface,
    expectedProfileRevision: reviewed.profile.revision, expectedSelectionRevision: reviewed.revision };
  await activatePermissionProfile(mutation);
  expect(mocks.request).toHaveBeenLastCalledWith("/api/v1/tools/permission-profiles/activate", { method: "POST", body: JSON.stringify(mutation) });
});

it("archives only the profile revision captured for the operator's confirmation", async () => {
  const input = { expectedRevision: "a".repeat(64) };
  const result = { archived: true, profileId: "profile/a" };
  mocks.request.mockResolvedValue(result);
  expect(await archivePermissionProfile("profile/a", input)).toBe(result);
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith("/api/v1/tools/permission-profiles/profile%2Fa/archive", {
    method: "POST", body: JSON.stringify(input),
  });
});
