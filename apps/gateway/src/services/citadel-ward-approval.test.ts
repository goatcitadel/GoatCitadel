import { describe, expect, it } from "vitest";
import {
  buildCitadelWardApprovalPayload,
  buildCitadelWardRequestSummary,
  citadelWardInputSummaryFields,
  citadelWardReplayIdempotencyKey,
  citadelWardUrlOrigin,
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

  it("replays under the request's own idempotency key when it carried one", () => {
    expect(citadelWardReplayIdempotencyKey("ap-1", "client-key")).toBe("client-key");
    expect(citadelWardReplayIdempotencyKey("ap-1", "  ")).toBe("citadel-ward:ap-1");
    expect(citadelWardReplayIdempotencyKey("ap-1", 42)).toBe("citadel-ward:ap-1");
  });

  it("request summary is bounded, truncated and redacts secret-looking keys", () => {
    const summary = buildCitadelWardRequestSummary([
      ["Peer", "peer-1"],
      ["Skipped", undefined],
      ["Parameters", { password: "hunter2-not-real", nested: { clientSecret: "s-not-real" }, note: "z".repeat(300) }],
      ...citadelWardInputSummaryFields({ apiKey: "k-not-real", count: 3 }),
    ]);
    expect(summary.map((entry) => entry.label)).toEqual(["Peer", "Parameters", "Input apiKey", "Input count"]);
    expect(summary[1]!.value).toHaveLength(200);
    expect(summary[1]!.value.endsWith("…")).toBe(true);
    expect(summary[2]).toEqual({ label: "Input apiKey", value: "[REDACTED]" });
    expect(summary[3]).toEqual({ label: "Input count", value: "3" });
    const text = JSON.stringify(summary);
    for (const secret of ["hunter2-not-real", "s-not-real", "k-not-real"]) expect(text).not.toContain(secret);

    const many = buildCitadelWardRequestSummary(Array.from({ length: 25 }, (_, index) => [`Field ${index}`, index]));
    expect(many).toHaveLength(21);
    expect(many.at(-1)).toEqual({ label: "More fields", value: "5 not shown" });
  });

  it("push URL summary keeps only the origin", () => {
    expect(citadelWardUrlOrigin("https://user:pw@peer.example:8443/push/abc?token=t")).toBe(
      "https://peer.example:8443",
    );
    expect(citadelWardUrlOrigin("not a url")).toBe("unparseable URL");
  });

  it("recognises only ward approval kinds", () => {
    expect(isCitadelWardApprovalKind("citadel_ward.a2a_push")).toBe(true);
    expect(isCitadelWardApprovalKind("other")).toBe(false);
  });
});
