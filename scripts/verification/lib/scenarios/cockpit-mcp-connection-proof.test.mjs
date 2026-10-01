import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assertMcpConnectionAgreement } from "./cockpit-mcp-connection-proof.mjs";
import { assertMcpDiscoveryEvents, createMcpConnectionFixture } from "./cockpit-mcp-connection-fixture.mjs";
import { assertMcpHttpDiscoveryEvents, createMcpHttpFixture } from "./cockpit-mcp-http-fixture.mjs";

test("loopback HTTP fixture admits only credential-free initialization and discovery", async () => {
  const fixture = await createMcpHttpFixture({ runtimeRoot: path.join(os.tmpdir(), "goatcitadel-usability-http-test") }, path);
  try {
    assertMcpHttpDiscoveryEvents(await fixture.events(), 0);
    for (const [index, method] of ["initialize", "notifications/initialized", "tools/list"].entries()) {
      const reply = await fetch(fixture.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, ...(index === 1 ? {} : { id: index + 1 }) }) });
      assert.equal(reply.status, index === 1 ? 202 : 200);
      if (index === 2) assert.deepEqual((await reply.json()).result, { tools: [] });
    }
    assertMcpHttpDiscoveryEvents(await fixture.events(), 1);
    assert.throws(() => assertMcpHttpDiscoveryEvents([...(awaitableEvents()), "tools/call"], 1));
    function awaitableEvents() { return ["initialize", "notifications/initialized", "tools/list"]; }
    const forbidden = await fetch(fixture.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call" }) });
    assert.equal(forbidden.status, 400);
    assert.throws(() => assertMcpHttpDiscoveryEvents(["tools/call"], 0));
  } finally { await fixture.stop(); }
  await assert.rejects(fetch(fixture.url));
});

function agreement(action = "connect") {
  const before = { serverId: "fixture", label: "Local fixture", enabled: true, transport: "stdio", command: "node", args: ["fixture.cjs"],
    authType: "none", policy: { allowedEnvKeys: [] }, revision: "a".repeat(64), connectionRevision: "b".repeat(64), status: "disconnected" };
  const request = { expectedRevision: before.revision, expectedConnectionRevision: before.connectionRevision };
  const owner = { ...before, connectionRevision: "c".repeat(64), status: action === "connect" ? "connected" : "disconnected" };
  return { before, action, request, owner, receipt: { version: 1, action, reviewed: request, server: structuredClone(owner) } };
}
test("connection evidence binds exact action, review pair, saved command and fresh owner", () => {
  assertMcpConnectionAgreement(agreement()); assertMcpConnectionAgreement(agreement("disconnect"));
  for (const change of [
    (value) => { value.request.expectedRevision = "d".repeat(64); },
    (value) => { value.receipt.action = "disconnect"; },
    (value) => { value.receipt.server.command = "other"; },
    (value) => { value.owner.args = []; },
    (value) => { value.owner.connectionRevision = value.before.connectionRevision; },
    (value) => { value.owner.status = "connecting"; },
    (value) => { value.owner.serverId = "foreign"; },
  ]) { const value = agreement(); change(value); assert.throws(() => assertMcpConnectionAgreement(value)); }
  const value = agreement("disconnect"); value.owner.revision = "d".repeat(64); value.receipt.server = structuredClone(value.owner);
  assert.throws(() => assertMcpConnectionAgreement(value));
});
test("fixture evidence rejects duplicate starts, calls, unexpected methods and missing initialization", () => {
  const events = [{ event: "start", pid: 1 }, ...["initialize", "notifications/initialized", "tools/list"].map(method => ({ event: "request", pid: 1, method }))];
  assertMcpDiscoveryEvents(events, 1); assertMcpDiscoveryEvents([], 0);
  for (const changed of [events.slice(1), [...events, { event: "request", pid: 1, method: "tools/call" }],
    [...events, ...events], events.map(item => item.method === "tools/list" ? { ...item, method: "tools/call" } : item)])
    assert.throws(() => assertMcpDiscoveryEvents(changed, 1));
});
test("task-owned stdio fixture performs only initialization/list-tools and exits its exact child", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-usability-mcp-fixture-test-"));
  let child;
  try {
    const fixture = await createMcpConnectionFixture({ runtimeRoot }, path);
    assertMcpDiscoveryEvents(await fixture.events(), 0);
    child = spawn(fixture.command, fixture.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const ended = once(child, "exit"); let output = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { output += chunk; });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    const deadline = Date.now() + 5000;
    while (output.split("\n").filter(Boolean).length < 2 && Date.now() < deadline) await delay(10);
    assert.deepEqual(output.split("\n").filter(Boolean).map(line => JSON.parse(line)), [
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cockpit-local-discovery-proof", version: "1.0.0" } } },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ]);
    child.stdin.end(); assert.deepEqual(await ended, [0, null]);
    assertMcpDiscoveryEvents(await fixture.events(), 1); await fixture.assertStopped(delay);
  } finally {
    if (child?.exitCode === null) { const ended = once(child, "exit"); child.kill(); await ended; }
    const relative = path.relative(os.tmpdir(), runtimeRoot);
    assert.ok(relative.startsWith("goatcitadel-usability-mcp-fixture-test-") && !relative.includes(path.sep));
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
