import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GATEWAY_STARTUP_FAILURE_ENV,
  clearGatewayStartupFailure,
  gatewayStartupFailurePath,
  readGatewayStartupFailure,
} from "./gateway-startup-failure.mjs";

function withTempDir(run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-startup-failure-"));
  try {
    run(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const SUMMARY = "The local database did not start within 180 seconds. Open Logs shows its last messages.";

test("reads a valid record and refuses malformed ones", () => {
  withTempDir((tmp) => {
    const file = path.join(tmp, "gateway-startup-failure.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, summary: SUMMARY, retryable: true, at: "2026-11-15T10:00:00.000Z" }));
    assert.deepEqual(readGatewayStartupFailure(file), { summary: SUMMARY, retryable: true, at: "2026-11-15T10:00:00.000Z" });
    fs.writeFileSync(file, "{oops");
    assert.equal(readGatewayStartupFailure(file), undefined);
    fs.writeFileSync(file, JSON.stringify({ version: 2, summary: "x", retryable: true, at: "" }));
    assert.equal(readGatewayStartupFailure(file), undefined);
    fs.writeFileSync(file, JSON.stringify({ version: 1, summary: "x", retryable: "yes", at: "t" }));
    assert.equal(readGatewayStartupFailure(file), undefined);
    fs.writeFileSync(file, JSON.stringify({ version: 1, summary: "  ", retryable: true, at: "t" }));
    assert.equal(readGatewayStartupFailure(file), undefined);
    fs.writeFileSync(file, "null");
    assert.equal(readGatewayStartupFailure(file), undefined);
    assert.equal(readGatewayStartupFailure(path.join(tmp, "missing.json")), undefined);
  });
});

test("cuts a long summary to 500 characters", () => {
  withTempDir((tmp) => {
    const file = path.join(tmp, "gateway-startup-failure.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, summary: "a".repeat(900), retryable: false, at: "t" }));
    assert.equal(readGatewayStartupFailure(file).summary.length, 500);
  });
});

test("clears without failing when the file is missing", () => {
  withTempDir((tmp) => {
    clearGatewayStartupFailure(path.join(tmp, "none.json"));
    const file = path.join(tmp, "gateway-startup-failure.json");
    fs.writeFileSync(file, "{}");
    clearGatewayStartupFailure(file);
    assert.equal(fs.existsSync(file), false);
  });
});

test("names the record inside the runtime log folder and matches the Gateway's variable", () => {
  assert.equal(gatewayStartupFailurePath(path.join("runtime", "logs")), path.join("runtime", "logs", "gateway-startup-failure.json"));
  assert.equal(GATEWAY_STARTUP_FAILURE_ENV, "GOATCITADEL_STARTUP_FAILURE_FILE");
});
