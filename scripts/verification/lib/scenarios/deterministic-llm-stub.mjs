import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";

export const DETERMINISTIC_LLM_PROVIDER_ID = "verification-stub";
export const DETERMINISTIC_LLM_MODEL = "verification-stub-chat";
export const DETERMINISTIC_LLM_KEY_ENV = "GOATCITADEL_VERIFY_STUB_LLM_KEY";
export const DETERMINISTIC_LLM_DEFAULT_REPLY = "Verification stub reply.";

const DEFAULT_LISTEN_HOST = "127.0.0.1";
const ALLOWED_WILDCARD_LISTEN_HOSTS = new Set(["0.0.0.0", "::"]);

export async function writeDeterministicLlmProviderConfig(runtimeRoot, baseUrl, options = {}) {
  const providerId = options.providerId ?? DETERMINISTIC_LLM_PROVIDER_ID;
  const model = options.model ?? DETERMINISTIC_LLM_MODEL;
  const apiKeyEnv = options.apiKeyEnv ?? DETERMINISTIC_LLM_KEY_ENV;
  const llmConfig = {
    activeProviderId: providerId,
    activeModel: model,
    providers: [
      {
        providerId,
        label: options.label ?? "Verification stub (loopback)",
        baseUrl,
        apiStyle: options.apiStyle ?? "openai-chat-completions",
        defaultModel: model,
        apiKeyEnv,
      },
    ],
  };

  // The unified file is authoritative. Update both representations and remove
  // the stale generation stamp so boot can seal the isolated fixture again.
  const unifiedPath = path.join(runtimeRoot, "config", "goatcitadel.json");
  try {
    const unified = JSON.parse(await fs.readFile(unifiedPath, "utf8"));
    unified.llm = llmConfig;
    delete unified.generation;
    await fs.writeFile(unifiedPath, `${JSON.stringify(unified, null, 2)}\n`, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.writeFile(
    path.join(runtimeRoot, "config", "llm-providers.json"),
    `${JSON.stringify(llmConfig, null, 2)}\n`,
    "utf8",
  );

  const metadataPath = path.join(runtimeRoot, "config", "llm-model-metadata.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  metadata.entries[`${providerId}/${model}`] = {
    contextWindow: 128000,
    outputTokenLimit: 16000,
    reasoning: { supportedEfforts: ["low", "medium", "high"] },
  };
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

/**
 * A deterministic OpenAI-compatible provider for isolated verification journeys.
 * `failuresBeforeSuccess` makes provider failures injectable without reading
 * personal credentials or contacting an external service. `dispatchPlan`
 * provides per-completion faults for Gateway retry/recovery proof.
 */
export async function startDeterministicLlmStub(options = {}) {
  const providerId = options.providerId ?? DETERMINISTIC_LLM_PROVIDER_ID;
  const model = options.model ?? DETERMINISTIC_LLM_MODEL;
  const replyText = options.replyText ?? DETERMINISTIC_LLM_DEFAULT_REPLY;
  const failuresBeforeSuccess = Math.max(0, Number(options.failuresBeforeSuccess ?? 0));
  const failureCode = options.failureCode ?? "server_error";
  const failureStatus = Number(options.failureStatus ?? 500);
  const listenHost = normalizeListenHost(options.listenHost);
  const publicBaseUrlHost = normalizePublicBaseUrlHost(options.publicBaseUrlHost);
  let dispatchPlan = normalizeDispatchPlan(options.dispatchPlan, replyText);
  let promptReplyRules = normalizePromptReplyRules(options.promptReplyRules);
  const dispatchPlanModel = normalizeOptionalBoundedText(options.dispatchPlanModel, "dispatchPlanModel");
  const expectedAuthorization = normalizeOptionalBoundedText(options.expectedAuthorization, "expectedAuthorization");
  const requestSummaries = [];
  const sockets = new Set();
  const dispatchWaiters = new Set();
  let completionDispatches = 0;
  let dispatchPlanDispatches = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = rawBody.trim() ? JSON.parse(rawBody) : {};
    } catch {
      body = {};
    }
    const requestSummary = {
      method: request.method ?? "GET",
      path: url.pathname,
      model: typeof body?.model === "string" ? body.model : undefined,
      stream: body?.stream === true,
      messageCount: Array.isArray(body?.messages) ? body.messages.length : undefined,
      startedAt: new Date().toISOString(),
    };
    requestSummaries.push(requestSummary);

    if (
      expectedAuthorization &&
      (url.pathname === "/v1/models" || url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses") &&
      request.headers.authorization !== expectedAuthorization
    ) {
      completeRequestSummary(requestSummary, { outcome: "credential_rejected", status: 401 });
      writeJsonResponse(response, 401, {
        error: { message: "Synthetic provider credential rejected.", type: "invalid_api_key", code: "invalid_api_key" },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      completeRequestSummary(requestSummary, { outcome: "models", status: 200 });
      writeJsonResponse(response, 200, {
        data: [{ id: model, object: "model", owned_by: "goatcitadel-verification" }],
      });
      return;
    }

    if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses")) {
      completionDispatches += 1;
      notifyDispatchWaiters(dispatchWaiters, completionDispatches);
      requestSummary.promptMetadata = summarizePromptMetadata(body);
      const promptReplyRule = matchPromptReplyRule(body, promptReplyRules);
      if (promptReplyRule) {
        requestSummary.behavior = "prompt_reply_rule";
        requestSummary.promptReplyRuleId = promptReplyRule.ruleId;
        if (body.stream === true) {
          writeStreamingSuccess(response, model, promptReplyRule.replyText, url.pathname);
        } else {
          writeNonStreamingSuccess(response, body.model ?? model, promptReplyRule.replyText, url.pathname);
        }
        completeRequestSummary(requestSummary, { outcome: "success", status: 200 });
        return;
      }
      const isDispatchPlanRequest = dispatchPlanModel === undefined || body.model === dispatchPlanModel;
      const planned = isDispatchPlanRequest ? dispatchPlan[dispatchPlanDispatches] : undefined;
      if (isDispatchPlanRequest) {
        dispatchPlanDispatches += 1;
        requestSummary.dispatchPlanIndex = dispatchPlanDispatches - 1;
      }
      if (planned) {
        requestSummary.behavior = planned.type;
        await executePlannedDispatch({
          behavior: planned,
          body,
          model,
          request,
          requestPath: url.pathname,
          requestSummary,
          response,
        });
        return;
      }
      if (completionDispatches <= failuresBeforeSuccess) {
        completeRequestSummary(requestSummary, { outcome: "http_error", status: failureStatus });
        writeJsonResponse(response, failureStatus, {
          error: {
            message: "Synthetic transient provider failure.",
            type: failureCode,
            code: failureCode,
          },
        });
        return;
      }

      if (body.stream === true) {
        writeStreamingSuccess(response, model, replyText, url.pathname);
        completeRequestSummary(requestSummary, { outcome: "success", status: 200 });
        return;
      }

      completeRequestSummary(requestSummary, { outcome: "success", status: 200 });
      writeNonStreamingSuccess(response, body.model ?? model, replyText, url.pathname);
      return;
    }

    completeRequestSummary(requestSummary, { outcome: "not_found", status: 404 });
    writeJsonResponse(response, 404, {
      error: { message: `no stub route for ${request.method} ${url.pathname}` },
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, listenHost, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("stub LLM server did not expose an address");
  }

  const advertisedHost = formatUrlHost(
    publicBaseUrlHost ?? (ALLOWED_WILDCARD_LISTEN_HOSTS.has(listenHost) ? DEFAULT_LISTEN_HOST : listenHost),
  );

  return {
    providerId,
    model,
    replyText,
    listenHost,
    publicBaseUrlHost:
      publicBaseUrlHost ?? (ALLOWED_WILDCARD_LISTEN_HOSTS.has(listenHost) ? DEFAULT_LISTEN_HOST : listenHost),
    port: address.port,
    baseUrl: `http://${advertisedHost}:${address.port}/v1`,
    requestPaths: () => requestSummaries.map((entry) => `${entry.method} ${entry.path}`),
    requestSummaries: () => requestSummaries.map((entry) => ({ ...entry })),
    completionDispatches: () => completionDispatches,
    dispatchPlanDispatches: () => dispatchPlanDispatches,
    completionDispatchRecords: () =>
      requestSummaries
        .filter(
          (entry) =>
            entry.method === "POST" && (entry.path === "/v1/chat/completions" || entry.path === "/v1/responses"),
        )
        .map((entry) => ({ ...entry })),
    dispatchPlanDispatchRecords: () =>
      requestSummaries.filter((entry) => Number.isInteger(entry.dispatchPlanIndex)).map((entry) => ({ ...entry })),
    replaceDispatchPlan: (nextPlan) => {
      dispatchPlan = normalizeDispatchPlan(nextPlan, replyText);
      dispatchPlanDispatches = 0;
    },
    replacePromptReplyRules: (nextRules) => {
      promptReplyRules = normalizePromptReplyRules(nextRules);
    },
    waitForCompletionDispatchCount: (expectedCount, timeoutMs = 10_000) =>
      waitForCompletionDispatchCount(dispatchWaiters, () => completionDispatches, expectedCount, timeoutMs),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
        server.closeIdleConnections?.();
        for (const socket of sockets) {
          socket.destroy();
        }
      }),
  };
}

async function executePlannedDispatch({ behavior, body, model, request, requestPath, requestSummary, response }) {
  if (behavior.delayMs > 0) {
    await abortableDelay(behavior.delayMs, request);
  }
  if (request.aborted || response.destroyed) {
    completeRequestSummary(requestSummary, { outcome: "client_disconnected" });
    return;
  }

  switch (behavior.type) {
    case "provider_error":
      completeRequestSummary(requestSummary, { outcome: "provider_error", status: 200 });
      writeStreamingProviderError(response, model, behavior, requestPath);
      return;
    case "http_error":
      completeRequestSummary(requestSummary, { outcome: "http_error", status: behavior.status });
      writeJsonResponse(response, behavior.status, {
        error: {
          message: behavior.message,
          type: behavior.code,
          code: behavior.code,
        },
      });
      return;
    case "disconnect":
      completeRequestSummary(requestSummary, { outcome: "disconnect" });
      request.socket.destroy();
      return;
    case "stream_disconnect": {
      response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
      response.flushHeaders?.();
      const frame = {
        ...(requestPath === "/v1/responses"
          ? {
              type: "response.output_text.delta",
              item_id: "stub-output-partial",
              response_id: "stub-response-partial",
              delta: behavior.emittedText,
            }
          : {
              id: "stub-stream-partial",
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta: { role: "assistant", content: behavior.emittedText } }],
            }),
      };
      response.write(`data: ${JSON.stringify(frame)}\n\n`, () => {
        completeRequestSummary(requestSummary, { outcome: "stream_disconnect", status: 200 });
        response.destroy(new Error("synthetic_provider_stream_disconnect"));
      });
      return;
    }
    case "stream_stall":
      response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
      response.flushHeaders?.();
      if (behavior.emittedText) {
        const frame =
          requestPath === "/v1/responses"
            ? {
                type: "response.output_text.delta",
                item_id: "stub-output-stalled",
                response_id: "stub-response-stalled",
                delta: behavior.emittedText,
              }
            : {
                id: "stub-stream-stalled",
                object: "chat.completion.chunk",
                model,
                choices: [{ index: 0, delta: { role: "assistant", content: behavior.emittedText } }],
              };
        response.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      await waitForRequestClose(request, response);
      completeRequestSummary(requestSummary, { outcome: "stream_stall_aborted", status: 200 });
      return;
    case "success": {
      const plannedReply = behavior.replyText;
      if (body.stream === true) {
        writeStreamingSuccess(response, model, plannedReply, requestPath);
      } else {
        writeNonStreamingSuccess(response, body.model ?? model, plannedReply, requestPath);
      }
      completeRequestSummary(requestSummary, { outcome: "success", status: 200 });
      return;
    }
  }
}

function normalizeDispatchPlan(value, defaultReplyText) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("dispatchPlan must be an array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`dispatchPlan[${index}] must be an object`);
    }
    const delayMs = normalizeDelayMs(entry.delayMs, `dispatchPlan[${index}].delayMs`);
    switch (entry.type) {
      case "provider_error":
        return {
          type: "provider_error",
          delayMs,
          code: normalizeBoundedText(entry.code ?? "server_error", `dispatchPlan[${index}].code`),
          message: normalizeBoundedText(
            entry.message ?? "Synthetic provider failure.",
            `dispatchPlan[${index}].message`,
          ),
        };
      case "http_error":
        return {
          type: "http_error",
          delayMs,
          status: normalizeHttpErrorStatus(entry.status, index),
          code: normalizeBoundedText(entry.code ?? "server_error", `dispatchPlan[${index}].code`),
          message: normalizeBoundedText(
            entry.message ?? "Synthetic provider failure.",
            `dispatchPlan[${index}].message`,
          ),
        };
      case "disconnect":
        return { type: entry.type, delayMs };
      case "stream_stall":
        return {
          type: "stream_stall",
          delayMs,
          emittedText:
            entry.emittedText === undefined
              ? undefined
              : normalizeBoundedText(entry.emittedText, `dispatchPlan[${index}].emittedText`),
        };
      case "stream_disconnect":
        return {
          type: "stream_disconnect",
          delayMs,
          emittedText: normalizeBoundedText(
            entry.emittedText ?? "Synthetic partial output.",
            `dispatchPlan[${index}].emittedText`,
          ),
        };
      case "success":
        return {
          type: "success",
          delayMs,
          replyText: normalizeBoundedText(entry.replyText ?? defaultReplyText, `dispatchPlan[${index}].replyText`),
        };
      default:
        throw new TypeError(`dispatchPlan[${index}].type is unsupported`);
    }
  });
}

function normalizePromptReplyRules(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw new TypeError("promptReplyRules must be an array with at most 50 entries");
  }
  const seenRuleIds = new Set();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`promptReplyRules[${index}] must be an object`);
    }
    const ruleId = normalizeBoundedText(entry.ruleId, `promptReplyRules[${index}].ruleId`);
    if (seenRuleIds.has(ruleId)) {
      throw new TypeError(`promptReplyRules contains duplicate ruleId ${ruleId}`);
    }
    seenRuleIds.add(ruleId);
    const userContentIncludes =
      entry.userContentIncludes === undefined
        ? undefined
        : normalizeBoundedText(entry.userContentIncludes, `promptReplyRules[${index}].userContentIncludes`);
    const systemContentIncludes =
      entry.systemContentIncludes === undefined
        ? undefined
        : normalizeBoundedText(entry.systemContentIncludes, `promptReplyRules[${index}].systemContentIncludes`);
    if ((userContentIncludes === undefined) === (systemContentIncludes === undefined)) {
      throw new TypeError(
        `promptReplyRules[${index}] requires exactly one of userContentIncludes or systemContentIncludes`,
      );
    }
    return {
      ruleId,
      userContentIncludes,
      systemContentIncludes,
      replyText: normalizeBoundedText(entry.replyText, `promptReplyRules[${index}].replyText`),
    };
  });
}

function matchPromptReplyRule(body, rules) {
  if (rules.length === 0) return undefined;
  const userContent = collectPromptUserContent(body);
  const systemContent = collectPromptRoleContent(body, "system");
  return rules.find((rule) =>
    rule.userContentIncludes !== undefined
      ? userContent.includes(rule.userContentIncludes)
      : systemContent.includes(rule.systemContentIncludes),
  );
}

function collectPromptUserContent(body) {
  return collectPromptRoleContent(body, "user");
}

function collectPromptRoleContent(body, role) {
  const messages = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  return messages
    .filter((message) => message?.role === role)
    .flatMap((message) => extractPromptText(message?.content))
    .join("\n");
}

const PROMPT_METADATA_MARKERS = Object.freeze({
  scoreJudge: "Trace summary (metadata only):",
  executionPlanner: '"workflowTemplate":',
  surfaceRouter: "Recent mode-corrections in this citadel (from->to):",
  backgroundMemory: "extract durable operator facts as JSON",
  backgroundSkill: "decide whether one reusable procedure may merit governed review",
  commitmentClassifier: "list inferred follow-up check-ins as JSON",
  proactivePlanner: "OPEN COMMITMENTS:",
  incompleteRepair: "Partial assistant draft:",
  finalSynthesis: "Tool run summary:",
});

function summarizePromptMetadata(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  const userContent = collectPromptRoleContent(body, "user");
  const systemContent = collectPromptRoleContent(body, "system");
  const combined = `${systemContent}\n${userContent}`;
  return {
    roles: messages.map((message) => (typeof message?.role === "string" ? message.role : "unknown")),
    userContentByteLength: Buffer.byteLength(userContent, "utf8"),
    userContentSha256: createHash("sha256").update(userContent, "utf8").digest("hex"),
    systemContentByteLength: Buffer.byteLength(systemContent, "utf8"),
    systemContentSha256: createHash("sha256").update(systemContent, "utf8").digest("hex"),
    allowlistedMarkers: Object.fromEntries(
      Object.entries(PROMPT_METADATA_MARKERS).map(([name, marker]) => [name, combined.includes(marker)]),
    ),
  };
}

function extractPromptText(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (part && typeof part === "object") {
      if (typeof part.text === "string") return [part.text];
      if (typeof part.input_text === "string") return [part.input_text];
    }
    return [];
  });
}

function normalizeListenHost(value) {
  const normalized = value === undefined ? DEFAULT_LISTEN_HOST : normalizeHostText(value, "listenHost");
  if (normalized === "localhost") return normalized;
  if (ALLOWED_WILDCARD_LISTEN_HOSTS.has(normalized)) return normalized;
  if (normalized === "127.0.0.1" || normalized === "::1") return normalized;
  throw new TypeError("listenHost must be loopback or an explicit wildcard bind host");
}

function normalizePublicBaseUrlHost(value) {
  if (value === undefined) return undefined;
  const normalized = normalizeHostText(value, "publicBaseUrlHost");
  if (ALLOWED_WILDCARD_LISTEN_HOSTS.has(normalized)) {
    throw new TypeError("publicBaseUrlHost cannot advertise a wildcard address");
  }
  return normalized;
}

function normalizeHostText(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 253 || !/^[a-zA-Z0-9.:[\]-]+$/u.test(normalized)) {
    throw new TypeError(`${label} must be a plain hostname or IP address`);
  }
  return normalized;
}

function formatUrlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizeDelayMs(value, label) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 300_000) {
    throw new TypeError(`${label} must be between 0 and 300000`);
  }
  return Math.floor(parsed);
}

function normalizeHttpErrorStatus(value, index) {
  const parsed = Number(value ?? 500);
  if (!Number.isInteger(parsed) || parsed < 400 || parsed > 599) {
    throw new TypeError(`dispatchPlan[${index}].status must be an HTTP error status`);
  }
  return parsed;
}

function normalizeBoundedText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 2_000) {
    throw new TypeError(`${label} must be a non-empty string no longer than 2000 characters`);
  }
  return value;
}

function normalizeOptionalBoundedText(value, label) {
  if (value === undefined) return undefined;
  return normalizeBoundedText(value, label);
}

function writeNonStreamingSuccess(response, model, replyText, requestPath) {
  if (requestPath === "/v1/responses") {
    writeJsonResponse(response, 200, {
      id: "stub-response",
      object: "response",
      status: "completed",
      model,
      output: [
        {
          id: "stub-output",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: replyText, annotations: [] }],
        },
      ],
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    });
    return;
  }
  writeJsonResponse(response, 200, {
    id: "stub-completion",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: replyText },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  });
}

function writeStreamingSuccess(response, model, replyText, requestPath = "/v1/chat/completions") {
  response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
  if (requestPath === "/v1/responses") {
    const frames = [
      {
        type: "response.output_text.delta",
        item_id: "stub-output",
        response_id: "stub-response",
        delta: replyText,
      },
      {
        type: "response.completed",
        response: {
          id: "stub-response",
          object: "response",
          status: "completed",
          model,
          output: [
            {
              id: "stub-output",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: replyText, annotations: [] }],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
        },
      },
    ];
    for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }
  const splitAt = Math.max(1, Math.ceil(replyText.length / 2));
  const frames = [
    {
      id: "stub-stream",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: replyText.slice(0, splitAt) } }],
    },
    {
      id: "stub-stream",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { content: replyText.slice(splitAt) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    },
  ];
  for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function writeStreamingProviderError(response, model, behavior, requestPath) {
  response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
  if (requestPath === "/v1/responses") {
    response.write(
      `data: ${JSON.stringify({
        type: "response.failed",
        response: {
          id: "stub-response-failed",
          object: "response",
          status: "failed",
          model,
          error: { code: behavior.code, type: behavior.code, message: behavior.message },
          usage: { input_tokens: 12, output_tokens: 0, total_tokens: 12 },
        },
      })}\n\n`,
    );
  } else {
    response.write(
      `data: ${JSON.stringify({
        type: "error",
        error: { code: behavior.code, type: behavior.code, message: behavior.message },
      })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}

function completeRequestSummary(summary, patch) {
  Object.assign(summary, patch, { finishedAt: new Date().toISOString() });
}

function abortableDelay(ms, request) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    request.once("aborted", finish);
    request.once("close", finish);
    function finish() {
      clearTimeout(timer);
      request.off("aborted", finish);
      request.off("close", finish);
      resolve(undefined);
    }
  });
}

function waitForRequestClose(request, response) {
  return new Promise((resolve) => {
    request.once("aborted", resolve);
    request.once("close", resolve);
    response.once("close", resolve);
  });
}

function waitForCompletionDispatchCount(waiters, readCount, expectedCount, timeoutMs) {
  if (!Number.isInteger(expectedCount) || expectedCount < 0) {
    return Promise.reject(new TypeError("expected completion dispatch count must be a non-negative integer"));
  }
  if (readCount() >= expectedCount) return Promise.resolve(readCount());
  return new Promise((resolve, reject) => {
    const waiter = { expectedCount, resolve };
    waiters.add(waiter);
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`timed out waiting for ${expectedCount} completion dispatches; observed ${readCount()}`));
    }, timeoutMs);
    timer.unref?.();
    waiter.resolve = (value) => {
      clearTimeout(timer);
      waiters.delete(waiter);
      resolve(value);
    };
  });
}

function notifyDispatchWaiters(waiters, count) {
  for (const waiter of [...waiters]) {
    if (count >= waiter.expectedCount) waiter.resolve(count);
  }
}

function writeJsonResponse(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
