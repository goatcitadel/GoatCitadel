import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";

// Runs only as the exact registered local fixture command. It has no tool-call handler.
const source = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const log = process.argv[2];
const record = (event) => fs.appendFileSync(log, JSON.stringify({ pid: process.pid, ...event }) + "\n");
record({ event: "start" });
const timeout = setTimeout(() => process.exit(74), 15000);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("close", () => { clearTimeout(timeout); process.exit(0); });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  record({ event: "request", method: message.method });
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  if (message.method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cockpit-local-discovery-proof", version: "1.0.0" } });
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") return reply({ tools: [] });
  record({ event: "unexpected", method: message.method });
  process.exit(75);
});
`;

export function assertMcpDiscoveryEvents(events, expectedStarts) {
  const starts = events.filter((event) => event.event === "start");
  assert.equal(starts.length, expectedStarts);
  assert.equal(new Set(starts.map((event) => event.pid)).size, expectedStarts);
  for (const start of starts) {
    assert.ok(Number.isSafeInteger(start.pid) && start.pid > 0);
    assert.deepEqual(events.filter((event) => event.pid === start.pid && event.event !== "start")
      .map(({ event, method }) => ({ event, method })), [
      { event: "request", method: "initialize" },
      { event: "request", method: "notifications/initialized" },
      { event: "request", method: "tools/list" },
    ]);
  }
  assert.equal(events.length, expectedStarts * 4);
}

export async function createMcpConnectionFixture(stack, path) {
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)), "Connection fixture requires the disposable usability runtime");
  const runtime = await realpath(stack.runtimeRoot);
  const root = await mkdtemp(path.join(runtime, "cockpit-mcp-discovery-"));
  const relative = path.relative(runtime, await realpath(root));
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  const script = path.join(root, "discovery.cjs"), log = path.join(root, "events.jsonl");
  await writeFile(script, source);
  await writeFile(log, "");
  const events = async () => (await readFile(log, "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
  return {
    command: process.execPath, args: [script, log], events,
    async assertStopped(delay, timeoutMs = 6000) {
      const pids = [...new Set((await events()).filter((event) => event.event === "start").map((event) => event.pid))];
      const end = Date.now() + timeoutMs;
      while (pids.some(alive) && Date.now() < end) await delay(50);
      assert.deepEqual(pids.filter(alive), [], "Exact fixture discovery processes must exit; no unrelated PID is stopped");
    },
  };
}
