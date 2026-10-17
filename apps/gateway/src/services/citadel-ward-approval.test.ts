import { describe, expect, it } from "vitest";
import {
  buildCitadelWardApprovalPayload,
  citadelWardReplayIdempotencyKey,
  computeCitadelWardPayloadHash,
  isCitadelWardApprovalKind,
  readCitadelWardApprovalPayload,
} from "./citadel-ward-approval.js";

describe("citadel ward approval contract", () => {
  it("hash is stable under key reordering and changes with content", () => {
    const hash = computeCitadelWardPayloadHash({ a: 1, b: { c: 2 } });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeCitadelWardPayloadHash({ b: { c: 2 }, a: 1 })).toBe(hash);
    expect(computeCitadelWardPayloadHash({ a: 1, b: { c: 3 } })).not.toBe(hash);
  });

  it("build then read round-trips and read rejects malformed payloads", () => {
    const built = buildCitadelWardApprovalPayload({
      wardAction: "integration.action.invoke",
      citadelId: "citadel-1",
      workspaceId: "ws-1",
      request: { integrationId: "i-1", input: { x: 1 } },
    });
    expect(readCitadelWardApprovalPayload(built)).toEqual(built);
    const { payloadHash: _hash, ...withoutHash } = built;
    expect(readCitadelWardApprovalPayload(withoutHash)).toBeUndefined();
    expect(readCitadelWardApprovalPayload({ ...built, wardAction: "  " })).toBeUndefined();
    expect(readCitadelWardApprovalPayload({ ...built, request: "x" })).toBeUndefined();
    expect(readCitadelWardApprovalPayload(null)).toBeUndefined();
  });

  it("replay key is namespaced by approval id", () => {
    expect(citadelWardReplayIdempotencyKey("ap-1")).toBe("citadel-ward:ap-1");
  });

  it("recognises only ward approval kinds", () => {
    expect(isCitadelWardApprovalKind("citadel_ward.a2a_push")).toBe(true);
    expect(isCitadelWardApprovalKind("other")).toBe(false);
  });
});
