import { describe, expect, it, vi } from "vitest";
import { ChannelDeliveryApprovalPendingError } from "./channel-delivery-approval-pending.js";
import { parkChannelDeliveryApproval } from "./channel-delivery-approval-recovery.js";

describe("channel approval recovery fence", () => {
  const error = new ChannelDeliveryApprovalPendingError("part-1");
  function fixture() {
    const now = vi.fn(() => "2026-09-16T00:00:00.000Z");
    const parts = { list: vi.fn(async () => []), park: vi.fn(async () => true) };
    const input = { now, claimExpiresAt: "2026-09-16T00:01:00.000Z", baseBackoffMs: 1 };
    return { parts, input };
  }

  it("parks the exact part and lease before returning the persisted wake time", async () => {
    const f = fixture();
    await expect(parkChannelDeliveryApproval(f, error, f.input)).resolves.toEqual({
      status: "parked",
      updatedAt: "2026-09-16T00:00:00.000Z",
      nextAttemptAt: "2026-09-16T00:00:01.000Z",
    });
    expect(f.parts.park).toHaveBeenCalledExactlyOnceWith(
      "part-1",
      f.input.claimExpiresAt,
      "2026-09-16T00:00:01.000Z",
      "2026-09-16T00:00:00.000Z",
    );
  });

  it("returns a lost claim instead of a waiting projection after a competing claim", async () => {
    const f = fixture();
    f.parts.park.mockResolvedValueOnce(false);
    await expect(parkChannelDeliveryApproval(f, error, f.input)).resolves.toEqual({ status: "claim_lost" });
  });

  it("leaves ordinary failures and missing owners to the delivery failure path", async () => {
    const f = fixture();
    await expect(parkChannelDeliveryApproval(f, new Error("transport failed"), f.input)).resolves.toEqual({
      status: "not_applicable",
    });
    await expect(parkChannelDeliveryApproval({}, error, f.input)).resolves.toEqual({ status: "not_applicable" });
    expect(f.input.now).not.toHaveBeenCalled();
    expect(f.parts.park).not.toHaveBeenCalled();
  });

  it("propagates unavailable storage without fabricating a parked receipt", async () => {
    const f = fixture();
    f.parts.park.mockRejectedValueOnce(new Error("store unavailable"));
    await expect(parkChannelDeliveryApproval(f, error, f.input)).rejects.toThrow("store unavailable");
  });
});
