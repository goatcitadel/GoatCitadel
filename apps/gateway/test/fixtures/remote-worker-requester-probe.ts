import { createServer } from "node:http";
import type { McpServerRecord } from "@goatcitadel/contracts";

/** Real loopback MCP wire; static cases use no credentials or OS keychain state. */
export async function startWorkerRequesterMcpProbe(connectionMode: "requester_scoped" | "static" = "requester_scoped") {
  const methods: string[] = [];
  const calls: unknown[] = [];
  const errors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        request.url !== "/mcp" ||
        request.headers.authorization !== (connectionMode === "static" ? undefined : "Bearer controlled-worker-mcp-secret")
      ) {
        throw new Error("MCP fixture received an unauthorized request.");
      }
      let raw = "";
      for await (const chunk of request) {
        raw += String(chunk);
        if (Buffer.byteLength(raw) > 16_384) throw new Error("MCP fixture request exceeded its bound.");
      }
      const body = JSON.parse(raw) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
      methods.push(body.method);
      let result: object;
      switch (body.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "controlled-worker", version: "1.0.0" },
          };
          break;
        case "notifications/initialized":
          response.writeHead(202);
          response.end();
          return;
        case "tools/list":
          result = {
            tools: [
              {
                name: "read",
                description: "Read the controlled worker note",
                inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
              },
            ],
          };
          break;
        case "tools/call":
          if (body.params?.name !== "read" || JSON.stringify(body.params.arguments) !== '{"path":"note.txt"}') {
            throw new Error("MCP fixture received changed tool arguments.");
          }
          calls.push(body.params.arguments);
          result = { content: [{ type: "text", text: "Approved worker read: Orion 7." }] };
          break;
        default:
          throw new Error("MCP fixture received an unsupported method.");
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "MCP fixture failed.");
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "MCP fixture rejected the request." }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP fixture did not bind a TCP port.");
  const now = new Date().toISOString();
  const record: McpServerRecord = {
    serverId: "worker-mcp",
    label: "Controlled worker MCP",
    transport: "http",
    connectionMode,
    ...(connectionMode === "static" ? { url: `http://127.0.0.1:${address.port}/mcp` } : {
      configurationRevision: 1,
      requesterResolution: {
      resolverId: "fixture.worker",
      resolverVersion: "1.0.0",
      configGeneration: 1,
      transportPolicy: {
        allowedSchemes: ["http"],
        allowedHosts: ["127.0.0.1"],
        allowedPorts: [address.port],
        allowedHeaderNames: ["authorization"],
      },
      },
    }),
    authType: "none",
    enabled: true,
    status: "disconnected",
    category: "automation",
    trustTier: "restricted",
    costTier: "unknown",
    createdAt: now,
    updatedAt: now,
    policy: { requireFirstToolApproval: false, redactionMode: "off", allowedToolPatterns: [], blockedToolPatterns: [] },
  };
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    record,
    evidence: () => ({ methods: [...methods], calls: [...calls], errors: [...errors] }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
