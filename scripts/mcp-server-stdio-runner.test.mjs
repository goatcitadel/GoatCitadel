import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("goatcitadel mcp-server proxies MCP stdio tools through Gateway server-mode APIs", async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.setHeader("content-type", "application/json");

    if (request.method === "GET" && request.url === "/api/v1/mcp/server-mode/manifest") {
      assert.equal(request.headers.authorization, "Bearer test-token");
      response.end(
        JSON.stringify({
          tools: [
            {
              name: "goatcitadel.fs.read",
              title: "Read file",
              description: "Read a file through Gateway policy.",
              gatewayCallable: true,
              serverModeState: "call_preview",
              inputSchema: {
                type: "object",
                properties: {
                  args: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                    },
                  },
                },
              },
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
              },
            },
            {
              name: "goatcitadel.web.search",
              title: "Search web",
              description: "Open-world search should not be exported.",
              gatewayCallable: true,
              serverModeState: "call_preview",
              inputSchema: {},
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: true,
              },
            },
            {
              name: "goatcitadel.blocked",
              title: "Blocked",
              description: "Blocked descriptors should not be exported.",
              gatewayCallable: false,
              serverModeState: "blocked",
              inputSchema: {},
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
              },
            },
          ],
        }),
      );
      return;
    }

    if (request.method === "POST" && request.url === "/api/v1/mcp/server-mode/call") {
      assert.equal(request.headers.authorization, "Bearer test-token");
      assert.equal(request.headers["x-goatcitadel-origin-surface"], "mcp");
      const parsed = JSON.parse(body);
      assert.deepEqual(parsed, {
        descriptorName: "goatcitadel.fs.read",
        args: { path: "README.md" },
        agentId: "agent-test",
        sessionId: "session-test",
        workspaceId: "default",
      });
      response.end(
        JSON.stringify({
          outcome: "executed",
          policyReason: "allowed by test",
          auditEventId: "audit-test",
          capabilityId: "tool:fs.read",
          toolName: "fs.read",
          result: { content: "ok" },
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(
    process.execPath,
    [
      "bin/goatcitadel.mjs",
      "mcp-server",
      "--gateway-url",
      gatewayUrl,
      "--agent-id",
      "agent-test",
      "--session-id",
      "session-test",
      "--workspace-id",
      "default",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        GOATCITADEL_AUTH_TOKEN: "test-token",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const stdout = collectJsonLines(child.stdout);
  const stderr = collectText(child.stderr);

  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    assert.deepEqual(await stdout.nextLine(), {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "goatcitadel", version: "1.0.0" },
      },
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    const list = await stdout.nextLine();
    assert.equal(list.id, 2);
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name),
      ["goatcitadel.fs.read"],
    );
    assert.equal(list.result.tools[0].inputSchema.properties.path.type, "string");

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "goatcitadel.fs.read", arguments: { path: "README.md" } },
      })}\n`,
    );
    const call = await stdout.nextLine();
    assert.equal(call.id, 3);
    assert.equal(call.result.isError, false);
    assert.match(call.result.content[0].text, /"content": "ok"/);
    assert.equal(call.result._meta.auditEventId, "audit-test");

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "prompts/list" })}\n`);
    const unknown = await stdout.nextLine();
    assert.equal(unknown.error.code, -32601);

    child.stdin.end();
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
    assert.match(await stderr.text(), /Gateway-backed stdio proxy started/);
    assert.equal(requests.filter((request) => request.url === "/api/v1/mcp/server-mode/manifest").length, 1);
    assert.equal(requests.filter((request) => request.url === "/api/v1/mcp/server-mode/call").length, 1);
  } finally {
    child.kill();
    server.close();
    await once(server, "close");
  }
});

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function collectJsonLines(stream) {
  const pending = [];
  const waiters = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const raw = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (raw) {
        const value = JSON.parse(raw);
        const waiter = waiters.shift();
        if (waiter) {
          waiter(value);
        } else {
          pending.push(value);
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
  return {
    nextLine() {
      if (pending.length > 0) {
        return Promise.resolve(pending.shift());
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function collectText(stream) {
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    text += chunk;
  });
  return {
    text: () => Promise.resolve(text),
  };
}
