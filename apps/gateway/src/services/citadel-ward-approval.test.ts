import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCitadelWardApprovalPayload,
  buildCitadelWardRequestSummary,
  CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND,
  CITADEL_WARD_A2A_PUSH_APPROVAL_KIND,
  CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND,
  citadelWardInputSummaryFields,
  citadelWardReplayIdempotencyKey,
  citadelWardUrlOrigin,
  computeCitadelWardPayloadHash,
  createCitadelWardRequestVault,
  isCitadelWardApprovalKind,
  openCitadelWardApprovalRequest,
  readCitadelWardApprovalPayload,
  sealCitadelWardApprovalPayload,
  type CitadelWardSealedApprovalPayload,
} from "./citadel-ward-approval.js";

const KEY = randomBytes(32);
const INTEGRATION = CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND;
const SECRET_INPUT = {
  wardAction: "integration.action.invoke",
  citadelId: "citadel-1",
  workspaceId: "ws-1",
  request: { connectionId: "c-1", invokeRequest: { input: { apiToken: "secret-xyz" } } },
};

describe("citadel ward approval contract", () => {
  it("hash is stable under key reordering and changes with content", () => {
    const hash = computeCitadelWardPayloadHash({ a: 1, b: { c: 2 } });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeCitadelWardPayloadHash({ b: { c: 2 }, a: 1 })).toBe(hash);
    expect(computeCitadelWardPayloadHash({ a: 1, b: { c: 3 } })).not.toBe(hash);
  });

  it("push payloads build plaintext and read back; read rejects malformed payloads", () => {
    const built = buildCitadelWardApprovalPayload({
      wardAction: "a2a.outbound.push",
      citadelId: "citadel-1",
      workspaceId: "ws-1",
      request: { taskId: "t-1", eventSequence: 2 },
    });
    const push = CITADEL_WARD_A2A_PUSH_APPROVAL_KIND;
    expect(readCitadelWardApprovalPayload(push, built)).toEqual(built);
    const { payloadHash: _hash, ...withoutHash } = built;
    expect(readCitadelWardApprovalPayload(push, withoutHash)).toBeUndefined();
    expect(readCitadelWardApprovalPayload(push, { ...built, wardAction: "  " })).toBeUndefined();
    expect(readCitadelWardApprovalPayload(push, { ...built, request: "x" })).toBeUndefined();
    expect(readCitadelWardApprovalPayload(push, null)).toBeUndefined();
    // A sealed kind never accepts a plaintext request.
    expect(readCitadelWardApprovalPayload(INTEGRATION, built)).toBeUndefined();
    // A blank workspace is dropped rather than stored.
    expect(buildCitadelWardApprovalPayload({ ...SECRET_INPUT, workspaceId: " " })).not.toHaveProperty("workspaceId");
  });

  it("sealed payloads carry no plaintext request and open only for their kind and hash", () => {
    const sealed = sealCitadelWardApprovalPayload(KEY, INTEGRATION, SECRET_INPUT);
    expect(JSON.stringify(sealed)).not.toContain("secret-xyz");
    expect(sealed).not.toHaveProperty("request");
    expect(sealed.payloadHash).toBe(computeCitadelWardPayloadHash(SECRET_INPUT.request));
    const read = readCitadelWardApprovalPayload(INTEGRATION, JSON.parse(JSON.stringify(sealed)));
    expect(read).toEqual(sealed);
    expect(openCitadelWardApprovalRequest(KEY, INTEGRATION, sealed)).toEqual(SECRET_INPUT.request);
    expect(openCitadelWardApprovalRequest(KEY, CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND, sealed)).toBeUndefined();
    expect(
      openCitadelWardApprovalRequest(KEY, INTEGRATION, { ...sealed, payloadHash: "0".repeat(64) }),
    ).toBeUndefined();
    expect(openCitadelWardApprovalRequest(randomBytes(32), INTEGRATION, sealed)).toBeUndefined();
    expect(readCitadelWardApprovalPayload(INTEGRATION, { ...sealed, request: SECRET_INPUT.request })).toBeUndefined();
    expect(readCitadelWardApprovalPayload(CITADEL_WARD_A2A_PUSH_APPROVAL_KIND, sealed)).toBeUndefined();
  });

  it("the vault fails closed without a key or when key resolution throws", async () => {
    const vault = createCitadelWardRequestVault(async () => KEY);
    const sealed = (await vault.seal(INTEGRATION, SECRET_INPUT)) as CitadelWardSealedApprovalPayload;
    expect(await vault.open(INTEGRATION, sealed)).toEqual(SECRET_INPUT.request);
    const keyless = createCitadelWardRequestVault(async () => undefined);
    expect(await keyless.seal(INTEGRATION, SECRET_INPUT)).toBeUndefined();
    expect(await keyless.open(INTEGRATION, sealed)).toBeUndefined();
    const throwing = createCitadelWardRequestVault(() => {
      throw new Error("keychain unavailable");
    });
    expect(await throwing.seal(INTEGRATION, SECRET_INPUT)).toBeUndefined();
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
