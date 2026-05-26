import assert from "node:assert/strict";
import test from "node:test";

import { collectButtonTypeViolations } from "./check-button-types.mjs";

test("button type checker ignores JSX callback refs when type is present", () => {
  const source = `
    <button
      key={tab.id}
      ref={(node) => {
        refs.current[index] = node;
      }}
      type="button"
      onClick={() => setActive(tab.id)}
    >
      {tab.label}
    </button>
  `;

  assert.deepEqual(collectButtonTypeViolations(source), []);
});

test("button type checker flags opening button tags without an explicit type", () => {
  const source = `
    <button
      onClick={() => submit()}
    >
      Save
    </button>
    <buttonish>Not a button element</buttonish>
  `;

  assert.equal(collectButtonTypeViolations(source).length, 1);
  assert.match(collectButtonTypeViolations(source)[0].snippet, /<button onClick/);
});
