import assert from "node:assert/strict";
import test from "node:test";

import { DETERMINISTIC_FIRECRAWL_RESULTS, startDeterministicFirecrawlStub } from "./deterministic-firecrawl-stub.mjs";

test("deterministic Firecrawl stub returns bounded external evidence for known queries", async () => {
  const stub = await startDeterministicFirecrawlStub({ port: 0 });
  try {
    const query = "official Magic Pokemon Yu-Gi-Oh trading card game products organized play";
    const response = await fetch(`${stub.baseUrl}/v2/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: 2 }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.length, 2);
    assert.ok(payload.data.every((item) => new URL(item.url).protocol === "https:"));
    assert.deepEqual(stub.requests(), [{ query, limit: 2, matched: true }]);
  } finally {
    await stub.close();
  }
});

test("deterministic Firecrawl evidence spans the benchmark source floor", () => {
  const results = [...DETERMINISTIC_FIRECRAWL_RESULTS.values()].flat();
  assert.ok(results.length >= 12);
  assert.ok(new Set(results.map((item) => item.url)).size >= 12);
  assert.ok(new Set(results.map((item) => new URL(item.url).hostname)).size >= 8);
});
