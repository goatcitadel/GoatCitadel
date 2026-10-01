import assert from "node:assert/strict";
import { createServer } from "node:http";

/** Inert loopback completions; only the unique child stream stays open until its caller cancels. */
export async function startBackgroundChildProvider({ marker, model }) {
  assert.ok(marker.length >= 20 && model);
  const sockets = new Set(), held = new Set();
  let streams = 0, childStreams = 0, childClosed = 0, auxiliary = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: model, object: "model", owned_by: "verification" }] })); return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        response.writeHead(404); response.end(); return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const isChild = body.stream === true && body.messages?.some(message =>
        message.role === "user" && JSON.stringify(message.content).includes(marker));
      if (body.stream !== true) {
        auxiliary++;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: "verification-background-auxiliary", model,
          choices: [{ index: 0, message: { role: "assistant", content: "Verification context." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })); return;
      }
      streams++;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const frame = content => JSON.stringify({ id: `verification-background-${streams}`, model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }] });
      if (isChild) {
        childStreams++; held.add(response);
        response.write(`data: ${frame("Local child is working.")}\n\n`);
        const heartbeat = setInterval(() => response.write(": held local child\n\n"), 1_000);
        response.once("close", () => { clearInterval(heartbeat); held.delete(response); childClosed++; });
      } else {
        response.write(`data: ${frame("PARENT_BACKGROUND_READY")}\n\n`);
        response.end(`data: ${JSON.stringify({ id: "verification-parent-done", model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
      }
    } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    counts: () => ({ streams, childStreams, childClosed, auxiliary, held: held.size }),
    async close() {
      for (const response of held) response.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
