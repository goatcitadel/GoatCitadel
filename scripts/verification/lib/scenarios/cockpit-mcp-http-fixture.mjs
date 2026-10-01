import assert from "node:assert/strict";
import { createServer } from "node:http";

export function assertMcpHttpDiscoveryEvents(events, discoveries) {
  assert.deepEqual(events, Array.from({ length: discoveries }, () => ["initialize", "notifications/initialized", "tools/list"]).flat());
}

/** Task-owned loopback endpoint. No credentials, tool calls, remote services or session-close claims. */
export async function createMcpHttpFixture(stack, path) {
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)), "Requires a disposable usability runtime");
  const events = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.socket.remoteAddress, "127.0.0.1");
      assert.equal(request.method, "POST"); assert.equal(request.url, "/mcp");
      assert.equal(request.headers.authorization, undefined);
      let body = "";
      for await (const chunk of request) { body += chunk; assert.ok(body.length <= 16384); }
      const message = JSON.parse(body); events.push(message.method);
      assert.equal(message.jsonrpc, "2.0");
      assert.ok(["initialize", "notifications/initialized", "tools/list"].includes(message.method));
      if (message.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cockpit-loopback-discovery-proof", version: "1.0.0" } }
        : { tools: [] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch {
      events.push("invalid-request"); response.writeHead(400); response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    events: async () => [...events],
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
      assert.equal(server.listening, false);
    },
  };
}
