import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKER_MCP_PROTOCOL_VERSION } from "./worker-mcp-http-transport.js";

export const destinationMcpTools = [{ name: "note.read",
  inputSchema: { type: "object", properties: { path: { type: "string", enum: ["note.txt"] } }, required: ["path"], additionalProperties: false },
  outputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false },
}];

/** Test-only HTTP server reading a real file from its separately operated root. */
export async function startDestinationMcpFixture(root: string, options: { bearerToken?: string } = {}) {
  const calls: string[] = [];
  const authorizationChecks: boolean[] = [];
  let bearerToken = options.bearerToken;
  let toolCalls = 0;
  let mode = "json";
  let onList: (() => Promise<void>) | undefined;
  const session = "isolated-mcp-session";
  const server = createServer(async (request, response) => {
    try {
      const authorized = request.headers.authorization === (bearerToken ? `Bearer ${bearerToken}` : undefined);
      authorizationChecks.push(authorized);
      if (!authorized) { response.writeHead(401).end(); return; }
      if (request.url !== "/mcp" || request.headers["mcp-protocol-version"] !== WORKER_MCP_PROTOCOL_VERSION) {
        response.writeHead(400).end(); return;
      }
      if (request.method === "DELETE") {
        calls.push("DELETE");
        response.writeHead(request.headers["mcp-session-id"] === session ? 204 : 400).end(); return;
      }
      if (request.method !== "POST" || request.headers.accept !== "application/json, text/event-stream") {
        response.writeHead(400).end(); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 512 * 1024) { request.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params: Record<string, unknown> };
      calls.push(rpc.method);
      if (mode === "redirect") { response.writeHead(307, { Location: "http://127.0.0.1:1/escape" }).end(); return; }
      if (rpc.method !== "initialize" && request.headers["mcp-session-id"] !== session) { response.writeHead(400).end(); return; }
      const answer = (result: unknown, target: ServerResponse = response) => {
        const envelope = { jsonrpc: "2.0", id: mode === "wrong-id" ? 999 : rpc.id, result };
        const headers = rpc.method === "initialize" ? { "Mcp-Session-Id": session } : {};
        if (mode.startsWith("sse")) {
          target.writeHead(200, { ...headers, "Content-Type": "text/event-stream" });
          const newline = mode === "sse-cr" ? "\r" : mode === "sse-crlf" ? "\r\n" : "\n";
          target.write(`: keepalive${newline}${newline}event: message${newline}data: ${JSON.stringify(envelope)}${newline}${newline}`);
          // The client must finish on the response, not wait for server EOF.
          return;
        }
        target.writeHead(200, { ...headers, "Content-Type": "application/json" }).end(JSON.stringify(envelope));
      };
      if (rpc.method === "initialize") {
        answer({ protocolVersion: mode === "protocol-drift" ? "2024-11-05" : WORKER_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} }, serverInfo: { name: "destination-fixture", version: "1.0.0" } });
      } else if (rpc.method === "notifications/initialized") response.writeHead(202).end();
      else if (rpc.method === "tools/list") {
        await onList?.();
        const tools = structuredClone(destinationMcpTools);
        if (mode === "schema-drift") tools[0]!.inputSchema.properties.path.enum = ["other.txt"];
        answer({ tools, ...(mode === "cursor-loop" ? { nextCursor: "again" } : {}) });
      } else if (rpc.method === "tools/call") {
        toolCalls++;
        if (mode === "disconnect") { response.destroy(); return; }
        if (mode === "hang") return;
        if (mode === "oversized") { response.writeHead(200, { "Content-Type": "application/json", "Content-Length": 600000 }).end(); return; }
        const args = rpc.params.arguments as Record<string, unknown>;
        if (rpc.params.name !== "note.read" || args.path !== "note.txt") throw new Error("Unexpected fixture tool arguments.");
        const content = mode === "echo-auth" ? request.headers.authorization ?? "" : await readFile(join(root, "note.txt"), "utf8");
        answer({ content: [{ type: "text", text: content }],
          structuredContent: mode === "output-drift" ? { wrong: content } : { content },
          isError: mode === "tool-error", _meta: { fixtureInternal: "must not be projected" } });
      } else response.writeHead(400).end();
    } catch { response.destroy(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No MCP fixture address.");
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, calls, authorizationChecks, toolCalls: () => toolCalls,
    setBearerToken: (value: string | undefined) => { bearerToken = value; },
    setMode: (value: string) => { mode = value; }, onList: (handler: () => Promise<void>) => { onList = handler; },
    close: async () => { const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed; } };
}
