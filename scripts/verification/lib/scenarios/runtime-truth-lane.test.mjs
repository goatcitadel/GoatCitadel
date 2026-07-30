import assert from "node:assert/strict";
import test from "node:test";

import { assertOwnedGatewayRestart } from "./runtime-truth-lane.mjs";

test("runtime truth accepts a new owned process on the same isolated Gateway endpoint", () => {
  assert.doesNotThrow(() =>
    assertOwnedGatewayRestart(
      { pid: 4101, gatewayUrl: "http://127.0.0.1:43111" },
      { pid: 4102, gatewayUrl: "http://127.0.0.1:43111" },
    ),
  );
});

test("runtime truth rejects a restart without a distinct owned Gateway process", () => {
  assert.throws(
    () =>
      assertOwnedGatewayRestart(
        { pid: 4101, gatewayUrl: "http://127.0.0.1:43111" },
        { pid: 4101, gatewayUrl: "http://127.0.0.1:43111" },
      ),
    /reused process 4101/,
  );
});

test("runtime truth rejects a restart that moves away from the original loopback endpoint", () => {
  assert.throws(
    () =>
      assertOwnedGatewayRestart(
        { pid: 4101, gatewayUrl: "http://127.0.0.1:43111" },
        { pid: 4102, gatewayUrl: "http://127.0.0.1:43112" },
      ),
    /changed endpoint/,
  );
});
