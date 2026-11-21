// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";

const recovery = vi.hoisted(() => ({ moduleLoads: 0 }));
vi.mock("./ChatExpiredApprovalRecoveryControl", () => {
  recovery.moduleLoads += 1;
  return { ChatExpiredApprovalRecoveryControl: () => null };
});

it("does not load expired-setup renewal and its review runtime on the cold Chat path", async () => {
  await import("./ChatBlockers");
  expect(recovery.moduleLoads).toBe(0);
});
