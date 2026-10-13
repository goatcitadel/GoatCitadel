import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { sha256 } from "./agent-comparison.mjs";

/** Test-owned, opt-in transport faults. Control methods stay in the parent
 * process; the HTTP endpoint exposes only a nonce-bound test marker tool.
 * Nothing here grants the product permission to call that tool. */
export async function createAcceptanceFaultControls({ cellId, deadlineAt, persistReceipt }) {
  if (
    !/^[^:]+:provider_recovery:\d+$/u.test(cellId ?? "") ||
    !Number.isFinite(deadlineAt) ||
    deadlineAt <= Date.now() ||
    typeof persistReceipt !== "function"
  )
    throw new Error("Fault controls require a bounded provider-recovery cell and durable evidence sink.");
  let runtimeId,
    toolName,
    providerArmed = false,
    providerUsed = false,
    effectArmed = false;
  let publicTransportReviewed = false;
  let closed = false,
    failure,
    overflow = false,
    requestCount = 0;
  const providerReceipts = [],
    dispatches = [],
    pending = new Set();
  const marker = randomUUID(),
    args = { marker },
    argsSha256 = sha256(args);
  const token = randomBytes(32).toString("base64url"),
    expected = Buffer.from(`Bearer ${token}`);
  const check = (scope, signal) => {
    signal?.throwIfAborted();
    if (closed || Date.now() >= deadlineAt) throw new Error("The acceptance fault scope expired.");
    if (!runtimeId || scope !== runtimeId) throw new Error("The fault control belongs to a different owned runtime.");
    if (failure) throw new Error("Fault observation persistence failed; no complete receipt is available.");
  };
  const retain = async (receipt) => {
    try {
      await persistReceipt(receipt);
    } catch (error) {
      failure = error;
      throw error;
    }
  };
  const server = http.createServer((request, response) => {
    const operation = serve(request, response).catch(() => {
      if (!response.destroyed) response.destroy();
    });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  let closing;
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      clearTimeout(timer);
      const stopped = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await Promise.allSettled([...pending]);
      await stopped;
    })());
  const timer = setTimeout(
    () => {
      void close();
    },
    Math.max(1, deadlineAt - Date.now()),
  );
  timer.unref();
  return {
    bindRuntime(value) {
      if (closed || runtimeId || typeof value !== "string" || !value.trim() || value.length > 200)
        throw new Error("Bind the fault controls once to an actual owned runtime.");
      runtimeId = value;
    },
    armPreDispatchFailure({ runtimeId: owner, providerId, signal }) {
      check(owner, signal);
      if (providerId !== "comparison" || providerArmed || providerUsed)
        throw new Error("Only one initial comparison-provider fault may be armed.");
      providerArmed = true;
      return { runtimeId, providerId, boundary: "before_upstream_forward", maxFaults: 1, controlled: true };
    },
    /** Called only after the common request budget reserves the actual attempt. */
    async consumeProviderFault({ budgetSequence, requestSha256, startedAt }) {
      if (closed || failure || Date.now() >= deadlineAt) check(runtimeId);
      if (!providerArmed) return undefined;
      check(runtimeId);
      if (!Number.isSafeInteger(budgetSequence) || budgetSequence < 1 || !/^[a-f0-9]{64}$/u.test(requestSha256))
        throw new Error("A controlled provider fault requires a real reserved request.");
      providerArmed = false;
      providerUsed = true;
      const receipt = {
        kind: "controlled_provider_failure",
        transportReceiptId: randomUUID(),
        cellId,
        runtimeId,
        budgetSequence,
        requestSha256,
        startedAt,
        finishedAt: new Date().toISOString(),
        boundary: "before_upstream_forward",
        nativeTransportReachedFixture: true,
        upstreamForwarded: false,
        controlled: true,
        status: 503,
        usefulOutputBytes: 0,
      };
      await retain(receipt);
      providerReceipts.push(receipt);
      return structuredClone(receipt);
    },
    observeProviderFault({ runtimeId: owner, signal }) {
      check(owner, signal);
      if (providerReceipts.length !== 1) throw new Error("No exact completed controlled provider fault was observed.");
      return structuredClone(providerReceipts[0]);
    },
    getEffectConnection({ runtimeId: owner, signal }) {
      check(owner, signal);
      // Private connection material: pass to the normal server configuration
      // owner, never to an evidence file or model message.
      return { url, headers: { authorization: `Bearer ${token}` }, nativeToolName: "record_marker" };
    },
    enableReviewedPublicTransport({ runtimeId: owner, signal }) {
      check(owner, signal);
      if (effectArmed || publicTransportReviewed)
        throw new Error("Review the public loopback fixture once before arming it.");
      publicTransportReviewed = true;
      return { url, authType: "none", nativeToolName: "record_marker", scope: "controlled_loopback_fixture" };
    },
    bindEffectTool({ runtimeId: owner, toolName: value, signal }) {
      check(owner, signal);
      if (toolName || !/^[a-zA-Z0-9_.:-]{1,200}$/u.test(value ?? ""))
        throw new Error("Bind one actual discovered tool alias before arming the effect fixture.");
      toolName = value;
    },
    armUncertainEffect({ runtimeId: owner, signal }) {
      check(owner, signal);
      if (!toolName || effectArmed) throw new Error("The reviewed discovered effect tool must be bound once.");
      effectArmed = true;
      return {
        runtimeId,
        toolName,
        argsSha256,
        prompt: `Call the approved test tool ${toolName} exactly once with ${JSON.stringify(args)}. It records a marker only in the isolated comparison fixture. If its response is lost, stop for reconciliation; do not repeat the call.`,
      };
    },
    observeEffectTransport({ runtimeId: owner, effectId, toolName: alias, argsSha256: hash, signal }) {
      check(owner, signal);
      if (!effectArmed || alias !== toolName || hash !== argsSha256 || !effectId || overflow || !dispatches.length)
        throw new Error("The native effect cannot be joined to complete fixture transport evidence.");
      // effectId is supplied by the product receipt. The random argument binds
      // that native result to this observed transport; it is not a native ID
      // independently issued by this fixture.
      return {
        runtimeId,
        effectId,
        toolName,
        argsSha256,
        dispatches: structuredClone(dispatches),
        automaticRetries: dispatches.length - 1,
        observationScope: "all_matching_transport_dispatches",
        controlled: true,
      };
    },
    close,
  };

  async function serve(request, response) {
    const auth = Buffer.from(typeof request.headers.authorization === "string" ? request.headers.authorization : "");
    if (
      closed ||
      Date.now() >= deadlineAt ||
      (!publicTransportReviewed && (auth.length !== expected.length || !timingSafeEqual(auth, expected)))
    )
      return reply(response, 401, { error: "Fixture credential unavailable." });
    if (++requestCount > 512) {
      overflow = true;
      return reply(response, 429, { error: "Fixture request bound exceeded." });
    }
    if (
      request.method !== "POST" ||
      request.url !== "/mcp" ||
      request.headers["content-encoding"] ||
      !String(request.headers["content-type"] ?? "").startsWith("application/json")
    )
      return reply(response, 400, { error: "Only bounded MCP JSON requests are supported." });
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64 * 1024) return reply(response, 413, { error: "Fixture request too large." });
      chunks.push(chunk);
    }
    let input;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return reply(response, 400, { error: "Invalid JSON." });
    }
    if (!input || input.jsonrpc !== "2.0" || typeof input.method !== "string")
      return reply(response, 400, { error: "Invalid MCP request." });
    if (input.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    const result = (value) => reply(response, 200, { jsonrpc: "2.0", id: input.id, result: value });
    if (input.method === "initialize")
      return result({
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "comparison-fault-fixture", version: "1.0.0" },
      });
    if (input.method === "tools/list")
      return result({
        tools: [
          {
            name: "record_marker",
            description:
              "Record one nonce marker in this isolated comparison fixture. This is a controlled uncertain-response test, with no third-party effect.",
            inputSchema: {
              type: "object",
              properties: { marker: { type: "string", const: marker } },
              required: ["marker"],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
          },
        ],
      });
    if (input.method !== "tools/call" || input.params?.name !== "record_marker")
      return reply(response, 200, {
        jsonrpc: "2.0",
        id: input.id,
        error: { code: -32601, message: "Unknown fixture method." },
      });
    check(runtimeId);
    if (!runtimeId || !toolName || !effectArmed || failure || sha256(input.params?.arguments) !== argsSha256)
      return reply(response, 403, { error: "This marker is not armed in the reviewed runtime." });
    if (dispatches.length >= 8) {
      overflow = true;
      return reply(response, 429, { error: "Effect observation bound exceeded." });
    }
    const dispatch = {
      transportReceiptId: randomUUID(),
      outcome: "unknown_after_send",
      at: new Date().toISOString(),
      argsSha256,
      responseIntentionallyDropped: true,
      controlled: true,
    };
    // The marker is the task-owned external effect. Retain its receipt before
    // dropping the response; never report a network timeout as no dispatch.
    dispatches.push(dispatch);
    await retain({ kind: "controlled_effect_dispatch", cellId, runtimeId, toolName, ...dispatch });
    response.destroy();
  }
}

function reply(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
