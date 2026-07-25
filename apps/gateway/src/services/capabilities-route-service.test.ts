import { describe, expect, it, vi } from "vitest";
import { CapabilitiesRouteService, type CapabilitiesRoutePort } from "./capabilities-route-service.js";

/**
 * HX-402 P2: the capability route facade forwards the approval-first candidate
 * lifecycle verbs (promote/revoke/rollback + proposal creation) faithfully,
 * including the requesting actor, so the service can bind requester Journey
 * evidence to each canonical `capability.lifecycle` approval.
 */
describe("CapabilitiesRouteService", () => {
  function fakePort(): CapabilitiesRoutePort {
    const methods = [
      "createProposal",
      "getCandidateDetail",
      "getProposalDetail",
      "listProposals",
      "promoteCandidate",
      "revokeCandidate",
      "rollbackCandidate",
    ] as const;
    const port: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of methods) {
      port[method] = vi.fn(() => ({ method }));
    }
    return port as unknown as CapabilitiesRoutePort;
  }

  it("forwards approval-first candidate lifecycle verbs with the requesting actor", () => {
    const port = fakePort();
    const service = new CapabilitiesRouteService(port);

    expect(service.promoteCapabilityCandidate("candidate-1", 3, "version-2", "operator-1")).toEqual({
      method: "promoteCandidate",
    });
    expect(port.promoteCandidate).toHaveBeenCalledWith("candidate-1", 3, "version-2", "operator-1");

    expect(service.revokeCapabilityCandidate("candidate-1", 4, undefined, "operator-2")).toEqual({
      method: "revokeCandidate",
    });
    expect(port.revokeCandidate).toHaveBeenCalledWith("candidate-1", 4, undefined, "operator-2");

    expect(service.rollbackCapabilityCandidate("candidate-1", "version-0", 5, "operator-3")).toEqual({
      method: "rollbackCandidate",
    });
    expect(port.rollbackCandidate).toHaveBeenCalledWith("candidate-1", "version-0", 5, "operator-3");
  });

  it("forwards review-only proposal creation with the acting operator", () => {
    const port = fakePort();
    const service = new CapabilitiesRouteService(port);
    const input = { proposalKind: "skill" as const, title: "T", summary: "S", payload: {} };
    expect(service.createCapabilityProposal(input, "operator-4")).toEqual({ method: "createProposal" });
    expect(port.createProposal).toHaveBeenCalledWith(input, "operator-4");
  });

  it("omits the requester when the route has none so the service default applies", () => {
    const port = fakePort();
    const service = new CapabilitiesRouteService(port);
    service.promoteCapabilityCandidate("candidate-1", 3);
    expect(port.promoteCandidate).toHaveBeenCalledWith("candidate-1", 3, undefined, undefined);
  });
});
