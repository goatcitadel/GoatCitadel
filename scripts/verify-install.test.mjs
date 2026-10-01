import assert from "node:assert/strict";
import test from "node:test";
import { assertVerifiedFirstAnswer, fetchTextWithRetry, resolveOnboardingRevision } from "./verify-install.mjs";

test("install smoke sends the current onboarding revision", () => {
  assert.equal(resolveOnboardingRevision({ ok: true, status: 200, body: { settings: { revision: 7 } } }), 7);
  assert.throws(() => resolveOnboardingRevision({ ok: true, status: 200, body: {} }), /current onboarding revision/u);
  assert.throws(
    () => resolveOnboardingRevision({ ok: false, status: 503, body: { settings: { revision: 7 } } }),
    /status 503/u,
  );
});

test("install UI smoke retries a transient Vite restart", async () => {
  let calls = 0;
  const result = await fetchTextWithRetry("http://127.0.0.1:5173/", {
    attempts: 3,
    delayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        throw new TypeError("fetch failed");
      }
      return new Response('<div id="root"></div><script src="/@vite/client"></script>', { status: 200 });
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.response.status, 200);
  assert.match(result.text, /id="root"/u);
});

function firstAnswer() {
  const settings = { revision: 3, llm: { activeProviderId: "stub", activeModel: "model" } };
  const verified = { status: "verified", sessionId: "s", turnId: "t", providerId: "stub", model: "model" };
  const completed = { completed: true, completedAt: "2026-09-30T00:00:00Z", completedBy: "operator", settings };
  return { before: { completed: false, settings }, completed, after: { ...completed, firstTask: verified }, verified,
    turn: { turnId: "t", trace: { sessionId: "s", status: "completed", model: "model", routing: { primaryProviderId: "stub" } },
      assistantMessage: { content: "Verification stub reply." } }, providerDispatches: 1 };
}
test("first answer requires exact canonical turn, actual provider dispatch and preserved settings", () => {
  assert.doesNotThrow(() => assertVerifiedFirstAnswer(firstAnswer()));
  for (const alter of [value => { value.providerDispatches = 0; }, value => { value.turn.trace.status = "failed"; },
    value => { value.turn.turnId = "foreign"; }, value => { value.turn.trace.routing.primaryProviderId = "foreign"; },
    value => { value.after.settings = { revision: 4 }; }, value => { value.after.completedAt = "other"; }]) {
    const input = firstAnswer(); alter(input); assert.throws(() => assertVerifiedFirstAnswer(input));
  }
});
