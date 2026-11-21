import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { requestJson } from "./runtime.mjs";

for (const phase of ["headers", "body"])
  test(`requestJson aborts while waiting for ${phase}`, { timeout: 5000 }, async () => {
    let received;
    const arrived = new Promise((resolve) => {
      received = resolve;
    });
    const server = http.createServer((_request, response) => {
      if (phase === "body") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
      }
      received();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const controller = new AbortController();
      const response = requestJson(`http://127.0.0.1:${server.address().port}`, "/controlled-stall", {
        signal: controller.signal,
      });
      await arrived;
      controller.abort();
      const deadline = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error("The request ignored its cancellation deadline")), 300);
        timer.unref();
      });
      await assert.rejects(Promise.race([response, deadline]), (error) => error.name === "AbortError");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
