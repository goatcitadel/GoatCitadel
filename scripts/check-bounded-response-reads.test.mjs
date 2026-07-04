import assert from "node:assert/strict";
import test from "node:test";

import { collectRawResponseReadViolations } from "./check-bounded-response-reads.mjs";

test("bounded response read checker rejects raw response text reads", () => {
  const violations = collectRawResponseReadViolations(
    "apps/gateway/src/services/example-service.ts",
    "async function read(response) { return response.text(); }",
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0].display, ".text()");
});

test("bounded response read checker allows the shared bounded reader helper", () => {
  const violations = collectRawResponseReadViolations(
    "apps/gateway/src/services/bounded-response-reader.ts",
    `
      await response.text();
      const reader = response.body.getReader();
      await response.arrayBuffer();
    `,
  );

  assert.deepEqual(violations, []);
});

test("bounded response read checker allows approved streaming exceptions only", () => {
  assert.deepEqual(
    collectRawResponseReadViolations(
      "apps/gateway/src/services/llm-service.ts",
      "const reader = response.body.getReader();",
    ),
    [],
  );

  const violations = collectRawResponseReadViolations(
    "apps/gateway/src/services/llm-service.ts",
    "const payload = await response.json();",
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].display, ".json()");
});

test("bounded response read checker ignores comments and strings", () => {
  const violations = collectRawResponseReadViolations(
    "apps/gateway/src/services/example-service.ts",
    `
      // await response.text();
      const message = "response.json()";
      /*
        const reader = response.body.getReader();
      */
    `,
  );

  assert.deepEqual(violations, []);
});
