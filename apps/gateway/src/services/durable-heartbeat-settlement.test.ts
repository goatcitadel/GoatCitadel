import { describe, expect, it, vi } from "vitest";
import { DurableRunService } from "./durable-run-service.js";

describe("heartbeat terminal capability binding", () => {
  const admission = {
    admissionId: "admission",
    sessionIncarnationId: "incarnation",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
  };
  const settle = async (payload: Record<string, unknown>) => {
    const markTerminal = vi.fn(async () => ({ disposition: "terminal" }));
    const service = Object.create(DurableRunService.prototype) as {
      ctx: unknown;
      settleSystemHeartbeatOccurrenceIfPresent(run: unknown, admission: unknown): Promise<void>;
    };
    service.ctx = { storage: { heartbeatOccurrences: { markTerminal } } };
    await service.settleSystemHeartbeatOccurrenceIfPresent(
      { runId: "run", payload: { heartbeatOccurrenceId: "occurrence", ...payload } },
      admission,
    );
    return markTerminal;
  };
  it("hands the exact feature binding to the canonical occurrence owner", async () => {
    const markTerminal = await settle({ featureReferenceSha256: "a".repeat(64) });
    expect(markTerminal).toHaveBeenCalledWith({
      ...admission,
      occurrenceId: "occurrence",
      durableRunId: "run",
      featureReferenceSha256: "a".repeat(64),
    });
  });
  it("retains historical profile settlement", async () => {
    const markTerminal = await settle({ capabilityProfileId: "profile", capabilityProfileHash: "b".repeat(64) });
    expect(markTerminal).toHaveBeenCalledWith({
      ...admission,
      occurrenceId: "occurrence",
      durableRunId: "run",
      capabilityProfileId: "profile",
      capabilityProfileHash: "b".repeat(64),
    });
  });
  it.each([
    {},
    { featureReferenceSha256: "invalid" },
    { capabilityProfileId: "profile" },
    { featureReferenceSha256: "a".repeat(64), capabilityProfileId: "profile", capabilityProfileHash: "b".repeat(64) },
  ])("refuses missing, malformed or mixed capability evidence %j", async (payload) => {
    await expect(settle(payload)).rejects.toThrow("exact occurrence settlement identity");
  });
});
