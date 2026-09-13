import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const mode = process.argv[2];
const tools = [
  {
    name: "note.read",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", enum: ["note.txt"] } },
      required: ["path"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    },
  },
];
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let initialized = false,
  ready = false,
  pendingList,
  toolCalls = 0;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  void receive(line).catch(() => {
    process.exitCode = 81;
    lines.close();
  });
});
lines.on("close", () => {
  if (mode === "normal" && toolCalls !== 1) process.exitCode = 82;
});

async function receive(line) {
  const rpc = JSON.parse(line);
  assert.equal(rpc.jsonrpc, "2.0");
  if (rpc.id === "server-ping") {
    assert.deepEqual(rpc.result, {});
    emit({ jsonrpc: "2.0", id: "server-sampling", method: "sampling/createMessage", params: {} });
    return;
  }
  if (rpc.id === "server-sampling") {
    assert.equal(rpc.error.code, -32601);
    emit({
      jsonrpc: "2.0",
      id: pendingList,
      result: { tools: mode === "schema-drift" ? [{ ...tools[0], inputSchema: { type: "object" } }] : tools },
    });
    pendingList = undefined;
    return;
  }
  if (rpc.method === "initialize") {
    assert.equal(initialized, false);
    initialized = true;
    assert.equal(rpc.params.protocolVersion, "2025-06-18");
    assert.deepEqual(rpc.params.capabilities, {});
    process.stderr.write(`fixture-mode:${mode}\n`);
    if (mode === "malformed") {
      process.stdout.write("not a protocol response\n");
      return;
    }
    if (mode === "hang") return;
    emit({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "native-stdio-fixture", version: "1.0.0" },
      },
    });
    return;
  }
  assert.equal(initialized, true);
  if (rpc.method === "notifications/initialized") {
    assert.equal(rpc.id, undefined);
    ready = true;
    return;
  }
  assert.equal(ready, true);
  if (rpc.method === "tools/list") {
    assert.equal(pendingList, undefined);
    pendingList = rpc.id;
    process.stderr.write("Fixture diagnostic; never tool output.\n");
    emit({ jsonrpc: "2.0", id: "server-ping", method: "ping" });
    return;
  }
  assert.equal(rpc.method, "tools/call");
  assert.equal(++toolCalls, 1);
  assert.equal(rpc.params.name, "note.read");
  assert.deepEqual(rpc.params.arguments, { path: "note.txt" });
  const content = await readFile(new URL("./note.txt", import.meta.url), "utf8");
  emit({
    jsonrpc: "2.0",
    id: rpc.id,
    result: { content: [{ type: "text", text: content }], structuredContent: { content }, isError: false },
  });
}
