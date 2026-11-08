import { describe, expect, it } from "vitest";
import { parseSessionControlDetailResponse, SESSION_CONTROL_EVENT_REASON_CODES } from "./session-control.js";
import { readIdleOperatorControlDetail } from "./session-control-operator-projection.js";

const control = {
  workspaceId: "workspace-a",
  sessionId: "session-1",
  generation: 1,
  lastEventId: "evt-1",
  lastEventReasonCode: "session_initialized",
  updatedAt: "2026-07-14T12:00:00.000Z",
  ownerKind: "operator",
  leaseState: "operator_active",
  capabilities: [],
};

function expectCanonicalParity(input: unknown) {
  let expected;
  try {
    expected = parseSessionControlDetailResponse(input);
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
  }
  const actual = readIdleOperatorControlDetail(input);
  expect(actual).toStrictEqual(expected);
  if (actual) {
    expect(Object.isFrozen(actual)).toBe(true);
    expect(Object.isFrozen(actual.control)).toBe(true);
    expect(Object.isFrozen(actual.control.capabilities)).toBe(true);
    expect(Object.isFrozen(actual.pendingRequests)).toBe(true);
  }
}

describe("idle operator detail projection", () => {
  it("matches canonical generation and event constraints", () => {
    for (const lastEventReasonCode of [...SESSION_CONTROL_EVENT_REASON_CODES, "unknown"]) {
      for (const generation of [-1, 0, 1, 2, 3, 9, Number.MAX_SAFE_INTEGER + 1, 1.5, "1"]) {
        expectCanonicalParity({ control: { ...control, lastEventReasonCode, generation }, pendingRequests: [] });
      }
    }
  });

  it("matches canonical validation for exact, malformed, and hostile shapes", () => {
    expectCanonicalParity({ control, pendingRequests: [] });
    for (const key of Object.keys(control)) {
      const missing: Record<string, unknown> = { ...control };
      delete missing[key];
      expectCanonicalParity({ control: missing, pendingRequests: [] });
    }
    for (const patch of [
      { workspaceId: "" },
      { workspaceId: "a".repeat(257) },
      { sessionId: "session/1" },
      { lastEventId: "event\n1" },
      { updatedAt: "2026-02-30T12:00:00.000Z" },
      { updatedAt: "2026-07-14T12:00:00Z" },
      { updatedAt: "2026-07-14T12:00:00.000+00:00" },
      { ownerKind: "external_companion" },
      { leaseState: "external_stale" },
      { capabilities: ["send"] },
      { unexpected: "private" },
    ]) {
      expectCanonicalParity({ control: { ...control, ...patch }, pendingRequests: [] });
    }
    const getter = () => {
      throw new Error("Do not evaluate an untrusted accessor.");
    };
    expectCanonicalParity({
      control: Object.defineProperty({ ...control }, "sessionId", { get: getter }),
      pendingRequests: [],
    });
    expectCanonicalParity({ control, pendingRequests: [], unexpected: "private" });
    expectCanonicalParity({ control, pendingRequests: new Array(1) });
  });
});
