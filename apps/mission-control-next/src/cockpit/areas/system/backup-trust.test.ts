import { describe, expect, it } from "vitest";
import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import { backupTrustFromInbox } from "./backup-trust";
import { backupHealthCheck, summarizeHealthChecks } from "./health-overview";

const latest = { backupId: "B", createdAt: "2026-10-06T12:00:00Z" };
function projection(state: NonNullable<OperatorInboxResponse["coverage"][number]["backupTrust"]>["state"], identity?: typeof latest): OperatorInboxResponse {
  return { authority: "derived_projection", workspaceId: "default", generatedAt: "now", items: [],
    counts: { needs_attention: { known: 0, complete: false }, needs_decision: { known: 0, complete: true }, proposals: { known: 0, complete: true }, updates: { known: 0, complete: true } },
    coverage: [{ source: "backup_trust", state: state === "none" ? "not_enabled" : "limited",
      backupTrust: { state, ...identity, observedAt: "2026-10-06T12:01:00Z" } }] };
}
describe("exact backup trust and shared health summary", () => {
  it("cannot erase a canonical record with cached absence", () => {
    const trust = backupTrustFromInbox(projection("none"), latest);
    expect(trust).toBe("unknown");
    const check = backupHealthCheck(trust, true);
    expect(check.status.label).toBe("Not verified yet");
    expect(summarizeHealthChecks([check]).label).toBe("Some system checks lack live proof");
    expect(backupHealthCheck("none", true).status.label).toBe("Not verified yet");
    expect(backupTrustFromInbox(projection("none"))).toBe("unknown");
    expect(backupTrustFromInbox(projection("none"), null)).toBe("none");
  });
  for (const state of ["verified", "failed", "stale"] as const) {
    it(`does not apply backup A's ${state} observation to B`, () => {
      expect(backupTrustFromInbox(projection(state, { ...latest, backupId: "A" }), latest)).toBe("unknown");
      expect(backupTrustFromInbox(projection(state), latest)).toBe("unknown");
      expect(backupTrustFromInbox(projection(state, { ...latest, createdAt: "earlier" }), latest)).toBe("unknown");
      expect(backupTrustFromInbox(projection(state, latest), latest)).toBe(state);
    });
  }
  it("keeps unavailable or legacy identity-free trust unknown", () => {
    const legacy = projection("verified"); delete (legacy.coverage[0] as { backupTrust?: unknown }).backupTrust;
    expect(backupTrustFromInbox(legacy, latest)).toBe("unknown");
    const unavailable = projection("verified", latest); unavailable.coverage[0]!.state = "unavailable";
    expect(backupTrustFromInbox(unavailable, latest)).toBe("unknown");
    unavailable.coverage[0]!.state = "partial";
    expect(backupTrustFromInbox(unavailable, latest)).toBe("unknown");
  });
});
