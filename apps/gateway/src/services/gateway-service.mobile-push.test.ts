import { describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "@goatcitadel/contracts";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { GatewayService } from "./gateway-service.js";

describe("GatewayService mobile push projection", () => {
  it("preserves the retained approval publication when the post-commit push projection fails", async () => {
    const event: RealtimeEvent = {
      eventId: "event-retained",
      sequence: 7,
      eventType: "approval_created",
      source: "approvals",
      timestamp: "2026-08-09T00:00:00.000Z",
      eventClass: "domain_fact",
      eventAuthority: "retained_stream",
      links: { approvalId: "approval-1" },
      payload: { approvalId: "approval-1", kind: "tool", riskLevel: "high", status: "pending" },
    };
    const publishRetained = vi.fn(async () => event);
    const enqueueApprovalRefresh = vi.fn(async () => {
      throw new Error("push outbox unavailable");
    });
    const recordDevDiagnostic = vi.fn(() => {
      throw new Error("diagnostic sink unavailable");
    });
    const routeCanonicalNotification = vi.fn(async () => undefined);
    const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, unknown>;
    Object.assign(gateway, {
      realtimeEventService: { publishRealtime: publishRetained },
      storage: { mobilePush: { enqueueApprovalRefresh } },
      recordDevDiagnostic,
      maybeRouteCanonicalNotification: routeCanonicalNotification,
    });

    await expect(
      GatewayService.prototype.publishRealtime.call(gateway, "approval_created", "approvals", event.payload, {
        eventClass: event.eventClass,
        eventAuthority: event.eventAuthority,
        links: event.links,
      }),
    ).resolves.toBe(event);

    expect(publishRetained).toHaveBeenCalledTimes(1);
    expect(enqueueApprovalRefresh).toHaveBeenCalledTimes(1);
    expect(routeCanonicalNotification).toHaveBeenCalledWith(event);
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "mobile_push.approval_projection_failed",
        context: { realtimeEventId: "event-retained", eventType: "approval_created" },
      }),
    );
  });
});
