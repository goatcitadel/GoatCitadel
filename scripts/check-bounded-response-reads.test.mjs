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

test("bounded response read checker flags raw response reads in policy-engine", () => {
  const violations = collectRawResponseReadViolations(
    "packages/policy-engine/src/some-module.ts",
    "async function read(response) { return response.json(); }",
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0].display, ".json()");
});

test("bounded response read checker exempts fetchAllowlisted reads in bounded-by-construction files", () => {
  const violations = collectRawResponseReadViolations(
    "packages/policy-engine/src/tool-executor.ts",
    "const res = await fetchAllowlisted(u); await res.response.text(); await response.json();",
  );

  assert.deepEqual(violations, []);
});

test("bounded response read checker recognizes governed official-search responses as wrapped", () => {
  const violations = collectRawResponseReadViolations(
    "packages/policy-engine/src/research-search-official-providers.ts",
    "const response = await fetchAllowlisted(url); return response.json();",
  );

  assert.deepEqual(violations, []);
});

test("bounded response read checker flags bare fetch in bounded-by-construction files", () => {
  const violations = collectRawResponseReadViolations(
    "packages/policy-engine/src/tool-executor.ts",
    "await fetch(url);",
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0].method, "fetch");
});

test("bounded response read checker does not exempt unwrapped methods in bounded-by-construction files", () => {
  const violations = collectRawResponseReadViolations(
    "packages/policy-engine/src/tool-executor.ts",
    "res.body.getReader(); await response.blob();",
  );

  assert.equal(violations.length, 2);
  const methods = violations.map((violation) => violation.method).sort();
  assert.deepEqual(methods, ["blob", "body.getReader"]);
});

test("bounded response read checker masks bare fetch inside comments and strings in bounded files", () => {
  const violations = collectRawResponseReadViolations(
    "packages/policy-engine/src/tool-executor.ts",
    `
      // await fetch(url);
      const s = "fetch(x)";
    `,
  );

  assert.deepEqual(violations, []);
});

test("bounded response read checker allows network-guard's split-statement getReader but flags json", () => {
  assert.deepEqual(
    collectRawResponseReadViolations(
      "packages/policy-engine/src/sandbox/network-guard.ts",
      "response.body.getReader();",
    ),
    [],
  );

  const violations = collectRawResponseReadViolations(
    "packages/policy-engine/src/sandbox/network-guard.ts",
    "await response.json();",
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].display, ".json()");
});
