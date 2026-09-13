import { beforeEach, expect, it, vi } from "vitest";
import { acceptMemoryMaintenanceRecommendation, patchMemoryMaintenancePolicy, rejectMemoryMaintenanceRecommendation } from "./memory";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client-core.js", () => ({ request: mocks.request }));
beforeEach(() => { mocks.request.mockReset(); });

it("sends the selected workspace and reviewed policy revision in the mutation body", async () => {
  const patch = { expectedRevision: "a".repeat(64), enabled: false };
  const saved = { workspaceId: "workspace a", revision: "b".repeat(64), enabled: false };
  mocks.request.mockResolvedValue(saved);
  expect(await patchMemoryMaintenancePolicy("workspace a", patch)).toBe(saved);
  expect(mocks.request).toHaveBeenCalledWith("/api/v1/memory/maintenance/policy?workspaceId=workspace%20a", {
    method: "PATCH", body: JSON.stringify({ ...patch, workspaceId: "workspace a" }),
  });
});

it("binds recommendation decisions to the reviewed proposal and preserves the acceptance envelope", async () => {
  const expectedRevision = "a".repeat(64);
  const expectedPolicyRevision = "b".repeat(64);
  const accepted = { recommendation: { status: "applied" }, policy: { revision: "c".repeat(64) } };
  mocks.request.mockResolvedValue(accepted);
  expect(await acceptMemoryMaintenanceRecommendation("rec/a", { expectedRevision, expectedPolicyRevision })).toBe(accepted);
  expect(mocks.request).toHaveBeenLastCalledWith("/api/v1/memory/maintenance/recommendations/rec%2Fa/accept", {
    method: "POST", body: JSON.stringify({ expectedRevision, expectedPolicyRevision }),
  });
  await rejectMemoryMaintenanceRecommendation("rec/a", { expectedRevision });
  expect(mocks.request).toHaveBeenLastCalledWith("/api/v1/memory/maintenance/recommendations/rec%2Fa/reject", {
    method: "POST", body: JSON.stringify({ expectedRevision }),
  });
});
