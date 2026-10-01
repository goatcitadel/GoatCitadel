import assert from "node:assert/strict";
import { it } from "node:test";
import { assertMeetReviewHasNoEffects } from "./cockpit-integration-meet-proof.mjs";

it("requires unchanged canonical owner records and zero microphone or mutation effects after cancellation", () => {
  const before = [{ sessionId: "record", state: "blocked", updatedAt: "recorded-time" }];
  const input = { before, after: structuredClone(before), writes: [], microphoneCalls: 0 };
  assert.doesNotThrow(() => assertMeetReviewHasNoEffects(input));
  for (const changed of [{ after: [] }, { after: [{ ...before[0], state: "running" }] },
    { writes: [{ method: "POST", pathname: "/api/v1/voice/realtime/client-secret" }] }, { microphoneCalls: 1 }])
    assert.throws(() => assertMeetReviewHasNoEffects({ ...input, ...changed }));
});
