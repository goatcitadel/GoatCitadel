import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import {
  assertNativeApprovalTerminal,
  startNativeApprovalConsole,
} from "./agent-comparison-native-approval-console.mjs";

const until = async (condition) => {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "The native console did not settle.");
    await delay(10);
  }
};

function fixture(t, overrides = {}) {
  const input = new PassThrough(),
    output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 100;
  const calls = [],
    resolutions = [];
  let text = "",
    closed = 0;
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  const console = startNativeApprovalConsole({
    input,
    output,
    workspace: "controlled fixture",
    pollMs: 20,
    pending: async () => {
      calls.push("pending");
      return { approvals: [{ id: "native-one", summary: "fixture\u001b[2J" }] };
    },
    resolve: async (decision) => {
      resolutions.push(decision);
      return { applied: true };
    },
    onClosed: () => {
      closed++;
    },
    ...overrides,
  });
  t.after(async () => {
    await console.stop();
    input.destroy();
    output.destroy();
  });
  return {
    input,
    console,
    calls,
    resolutions,
    get text() {
      return text;
    },
    get closed() {
      return closed;
    },
  };
}

it("rejects noninteractive and piped approval input before opening a console", () => {
  assert.throws(() => assertNativeApprovalTerminal({ isTTY: false }, { isTTY: true }), /interactive terminal/);
  assert.throws(() => assertNativeApprovalTerminal({ isTTY: true }, { isTTY: false }), /interactive terminal/);
});

it("polls native requests without granting and forwards only exact typed one-time decisions", async (t) => {
  const f = fixture(t);
  await until(() => f.calls.length >= 2);
  assert.deepEqual(f.resolutions, []);
  assert.match(f.text, /fixture\\u001b\[2J/u);
  f.input.write("allow-always native-one\nallow-once --help\nallow-once one extra\n");
  await delay(30);
  assert.deepEqual(f.resolutions, []);
  f.input.write("allow-once native-one\ndeny native-two\n");
  await until(() => f.resolutions.length === 2);
  assert.deepEqual(f.resolutions, [
    { decision: "allow-once", approvalId: "native-one" },
    { decision: "deny", approvalId: "native-two" },
  ]);
  await f.console.stop();
  f.input.write("allow-once native-three\n");
  assert.equal(f.resolutions.length, 2);
  assert.equal(f.closed, 0);
});

it("closing operator input stops supervision and never supplies an approval", async (t) => {
  const f = fixture(t);
  f.input.end();
  await until(() => f.closed === 1);
  assert.deepEqual(f.resolutions, []);
});

it("retains a failed decision as uncertain without automatically retrying it", async (t) => {
  let attempts = 0;
  const f = fixture(t, {
    resolve: async () => {
      attempts++;
      throw new Error("response unknown");
    },
  });
  f.input.write("allow-once native-one\n");
  await until(() => f.text.includes("response unknown"));
  await delay(60);
  assert.equal(attempts, 1);
});
