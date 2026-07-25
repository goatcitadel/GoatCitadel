import { describe, expect, it } from "vitest";
import { HEARTBEAT_READ_ONLY_ALLOW, HEARTBEAT_RESTRICTED_PROFILE, SCHEDULED_RESTRICTED_PROFILE } from "./policy.js";

describe("autonomous restricted permission profiles", () => {
  it("makes heartbeat reads unattended only inside the immutable exact tool surface", () => {
    expect(HEARTBEAT_RESTRICTED_PROFILE).toMatchObject({
      builtin: true,
      status: "active",
      approvalMode: "bypass",
      allow: [],
    });
    expect(HEARTBEAT_RESTRICTED_PROFILE.toolPatterns).toEqual(HEARTBEAT_READ_ONLY_ALLOW);
    expect(new Set(HEARTBEAT_RESTRICTED_PROFILE.toolPatterns).size).toBe(5);
  });

  it("does not change the scheduled autonomous approval posture", () => {
    expect(SCHEDULED_RESTRICTED_PROFILE.approvalMode).toBe("approve_risky");
  });
});
