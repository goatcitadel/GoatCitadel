import assert from "node:assert/strict";
import test from "node:test";
import { fetchTextWithRetry, resolveOnboardingRevision } from "./verify-install.mjs";

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
