import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import path from "node:path";

export const DETERMINISTIC_LLM_PROVIDER_ID = "verification-stub";
export const DETERMINISTIC_LLM_MODEL = "verification-stub-chat";
export const DETERMINISTIC_LLM_KEY_ENV = "GOATCITADEL_VERIFY_STUB_LLM_KEY";
export const DETERMINISTIC_LLM_DEFAULT_REPLY = "Verification stub reply.";
export const DETERMINISTIC_LLM_CAPABILITIES = Object.freeze({
  reasoning: true,
  reasoningEfforts: Object.freeze(["none", "low", "medium", "high"]),
});

// A valid 1x1 opaque teal PNG. The deterministic provider uses it to exercise
// the real image-generation and PPTX embedding path without network credentials.
const DETERMINISTIC_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const DEFAULT_LISTEN_HOST = "127.0.0.1";
const ALLOWED_WILDCARD_LISTEN_HOSTS = new Set(["0.0.0.0", "::"]);
const MAX_TOOL_ARGUMENT_CHARACTERS = 128_000;
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

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
        capabilities: DETERMINISTIC_LLM_CAPABILITIES,
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
    reasoning: { supportedEfforts: ["none", "low", "medium", "high"] },
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
  const failureStatus = normalizeHttpErrorStatus(options.failureStatus, "failureStatus");
  const listenHost = normalizeListenHost(options.listenHost);
  const publicBaseUrlHost = normalizePublicBaseUrlHost(options.publicBaseUrlHost);
  let dispatchPlan = normalizeDispatchPlan(options.dispatchPlan, replyText);
  let promptReplyRules = normalizePromptReplyRules(options.promptReplyRules);
  const dispatchPlanModel = normalizeOptionalBoundedText(options.dispatchPlanModel, "dispatchPlanModel");
  let dispatchPlanRequiredTool =
    options.dispatchPlanRequiredTool === undefined
      ? undefined
      : normalizeToolName(options.dispatchPlanRequiredTool, "dispatchPlanRequiredTool");
  let expectedAuthorization = normalizeOptionalBoundedText(options.expectedAuthorization, "expectedAuthorization");
  const requestSummaries = [];
  const sockets = new Set();
  const dispatchWaiters = new Set();
  const controlledStreams = new Set();
  let completionDispatches = 0;
  let dispatchPlanDispatches = 0;
  let imageGenerationDispatches = 0;

  const handleRequest = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const requestSummary = {
      method: request.method ?? "GET",
      path: url.pathname,
      startedAt: new Date().toISOString(),
    };
    requestSummaries.push(requestSummary);

    if (
      expectedAuthorization &&
      (url.pathname === "/v1/models" ||
        url.pathname === "/v1/chat/completions" ||
        url.pathname === "/v1/responses" ||
        url.pathname === "/v1/images/generations") &&
      request.headers.authorization !== expectedAuthorization
    ) {
      completeRequestSummary(requestSummary, { outcome: "credential_rejected", status: 401 });
      writeJsonResponse(response, 401, {
        error: { message: "Synthetic provider credential rejected.", type: "invalid_api_key", code: "invalid_api_key" },
      });
      return;
    }

    let rawBody;
    try {
      rawBody = await readBoundedRequestBody(request, requestSummary);
    } catch (error) {
      if (!request.aborted && !response.destroyed) throw error;
      completeRequestSummary(requestSummary, { outcome: "client_disconnected" });
      return;
    }
    if (rawBody === undefined) {
      completeRequestSummary(requestSummary, { outcome: "request_too_large", status: 413 });
      writeJsonResponse(response, 413, {
        error: { message: "Synthetic provider request body is too large.", type: "invalid_request_error" },
      });
      return;
    }
    let body = {};
    try {
      body = JSON.parse(rawBody) ?? {};
    } catch {
      // Malformed JSON has historically been treated as an empty fixture request.
    }
    const requestedModel = typeof body.model === "string" ? body.model : undefined;
    const responseModel = requestedModel ?? model;
    Object.assign(requestSummary, {
      model: requestedModel,
      stream: body.stream === true,
      messageCount: Array.isArray(body.messages) ? body.messages.length : undefined,
      toolNames: Array.isArray(body.tools)
        ? body.tools
            .slice(0, 256)
            .map((tool) => tool?.function?.name ?? tool?.name)
            .filter((name) => typeof name === "string" && TOOL_NAME_PATTERN.test(name))
        : undefined,
    });

    if (request.method === "GET" && url.pathname === "/v1/models") {
      completeRequestSummary(requestSummary, { outcome: "models", status: 200 });
      writeJsonResponse(response, 200, {
        data: [{ id: model, object: "model", owned_by: "goatcitadel-verification" }],
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/images/generations") {
      imageGenerationDispatches += 1;
      requestSummary.behavior = "image_generation";
      completeRequestSummary(requestSummary, { outcome: "success", status: 200 });
      writeJsonResponse(response, 200, {
        created: 1_786_089_600,
        model: responseModel,
        data: [
          {
            b64_json: DETERMINISTIC_IMAGE_PNG_BASE64,
            revised_prompt: "Deterministic presentation verification visual.",
          },
        ],
      });
      return;
    }

    if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses")) {
      completionDispatches += 1;
      notifyDispatchWaiters(dispatchWaiters, completionDispatches);
      const messages = promptMessages(body, url.pathname);
      requestSummary.promptMetadata = summarizePromptMetadata(messages);
      const promptReplyRule = matchPromptReplyRule(messages, promptReplyRules);
      if (promptReplyRule) {
        requestSummary.behavior = "prompt_reply_rule";
        requestSummary.promptReplyRuleId = promptReplyRule.ruleId;
        if (body.stream === true) {
          writeStreamingSuccess(response, responseModel, promptReplyRule.replyText, url.pathname);
        } else {
          writeNonStreamingSuccess(response, responseModel, promptReplyRule.replyText, url.pathname);
        }
        completeRequestSummary(requestSummary, { outcome: "success", status: 200 });
        return;
      }
      const isDispatchPlanRequest =
        (!options.dispatchPlanStreamOnly || body.stream === true) &&
        (dispatchPlanModel === undefined || body.model === dispatchPlanModel) &&
        (dispatchPlanRequiredTool === undefined ||
          (Array.isArray(body.tools) &&
            body.tools.some(
              (tool) => tool?.type === "function" && (tool.function?.name ?? tool.name) === dispatchPlanRequiredTool,
            )));
      const planned = isDispatchPlanRequest ? dispatchPlan[dispatchPlanDispatches] : undefined;
      if (planned?.type === "stream_controlled" && (body.stream !== true || url.pathname !== "/v1/chat/completions")) {
        completeRequestSummary(requestSummary, { outcome: "invalid_request", status: 400 });
        writeJsonResponse(response, 400, {
          error: {
            message: "Controlled display fixture requires streaming chat completions.",
            type: "invalid_request_error",
          },
        });
        return;
      }
      if (isDispatchPlanRequest) {
        dispatchPlanDispatches += 1;
        requestSummary.dispatchPlanIndex = dispatchPlanDispatches - 1;
      }
      if (planned) {
        requestSummary.behavior = planned.type;
        await executePlannedDispatch({
          behavior: planned,
          body,
          model: responseModel,
          request,
          requestPath: url.pathname,
          requestSummary,
          response,
          controlledStreams,
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
        writeStreamingSuccess(response, responseModel, replyText, url.pathname);
        completeRequestSummary(requestSummary, { outcome: "success", status: 200 });
        return;
      }

      completeRequestSummary(requestSummary, { outcome: "success", status: 200 });
      writeNonStreamingSuccess(response, responseModel, replyText, url.pathname);
      return;
    }

    completeRequestSummary(requestSummary, { outcome: "not_found", status: 404 });
    writeJsonResponse(response, 404, {
      error: { message: `no stub route for ${request.method} ${url.pathname}` },
    });
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (request.aborted || response.destroyed || response.writableEnded) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      writeJsonResponse(response, 500, {
        error: { message: "Synthetic provider request failed.", type: "server_error", code: "server_error" },
      });
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
    imageGenerationDispatches: () => imageGenerationDispatches,
    advanceControlledStream: () => {
      if (controlledStreams.size !== 1)
        throw new Error(`Expected one controlled stream, found ${controlledStreams.size}`);
      return [...controlledStreams][0]();
    },
    completionDispatchRecords: () =>
      requestSummaries
        .filter(
          (entry) =>
            entry.method === "POST" && (entry.path === "/v1/chat/completions" || entry.path === "/v1/responses"),
        )
        .map((entry) => ({ ...entry })),
    dispatchPlanDispatchRecords: () =>
      requestSummaries.filter((entry) => Number.isInteger(entry.dispatchPlanIndex)).map((entry) => ({ ...entry })),
    replaceDispatchPlan: (nextPlan, requiredTool = dispatchPlanRequiredTool) => {
      const normalizedPlan = normalizeDispatchPlan(nextPlan, replyText);
      const normalizedTool =
        requiredTool == null ? undefined : normalizeToolName(requiredTool, "dispatchPlanRequiredTool");
      dispatchPlan = normalizedPlan;
      dispatchPlanRequiredTool = normalizedTool;
      dispatchPlanDispatches = 0;
    },
    replacePromptReplyRules: (nextRules) => {
      promptReplyRules = normalizePromptReplyRules(nextRules);
    },
    replaceExpectedAuthorization: (value) => {
      expectedAuthorization = normalizeBoundedText(value, "expectedAuthorization");
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

async function executePlannedDispatch({
  behavior,
  body,
  model,
  request,
  requestPath,
  requestSummary,
  response,
  controlledStreams,
}) {
  if (behavior.delayMs > 0) {
    await waitForResponseClose(request, response, behavior.delayMs);
  }
  if (request.aborted || response.destroyed) {
    completeRequestSummary(requestSummary, { outcome: "client_disconnected" });
    return;
  }

  switch (behavior.type) {
    case "stream_controlled": {
      response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
      response.flushHeaders?.();
      const closed = waitForResponseClose(request, response);
      let index = 0;
      let completed = false;
      const advance = () => {
        if (response.destroyed || response.writableEnded) throw new Error("Controlled stream is closed");
        if (index < behavior.chunks.length) {
          // A controlled phase can contain a large document fragment. Emit it
          // in ordinary token-sized batches through the real secret projector.
          // Keep phase boundaries deterministic without changing Gateway limits.
          const content = behavior.chunks[index++];
          for (let offset = 0; offset < content.length; offset += 128) {
            response.write(
              `data: ${JSON.stringify({
                id: "controlled-display",
                object: "chat.completion.chunk",
                model,
                choices: [{ index: 0, delta: { content: content.slice(offset, offset + 128) } }],
              })}\n\n`,
            );
          }
          return true;
        }
        completed = true;
        controlledStreams.delete(advance);
        response.write(
          `data: ${JSON.stringify({
            id: "controlled-display",
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 12,
              prompt_tokens_details: { cached_tokens: 0 },
              completion_tokens: 40,
              total_tokens: 52,
            },
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
        return false;
      };
      controlledStreams.add(advance);
      try {
        advance();
        await closed;
      } finally {
        controlledStreams.delete(advance);
        completeRequestSummary(requestSummary, {
          outcome: completed ? "success" : "controlled_stream_aborted",
          status: 200,
        });
      }
      return;
    }
    case "provider_error": {
      if (behavior.faultClockMarker !== undefined) {
        response.setHeader("x-goatcitadel-verification-fault-clock", behavior.faultClockMarker);
      }
      if (body.stream === true) {
        completeRequestSummary(requestSummary, { outcome: "provider_error", status: 200 });
        writeStreamingProviderError(response, model, behavior, requestPath);
      } else {
        completeRequestSummary(requestSummary, { outcome: "provider_error", status: 500 });
        writeJsonResponse(response, 500, {
          error: { code: behavior.code, type: behavior.code, message: behavior.message },
        });
      }
      return;
    }
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
        setTimeout(() => {
          completeRequestSummary(requestSummary, { outcome: "stream_disconnect", status: 200 });
          response.destroy(new Error("synthetic_provider_stream_disconnect"));
        }, 10);
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
      await waitForResponseClose(request, response);
      completeRequestSummary(requestSummary, { outcome: "stream_stall_aborted", status: 200 });
      return;
    case "success": {
      const plannedReply = behavior.replyText;
      if (body.stream === true) {
        writeStreamingSuccess(response, model, plannedReply, requestPath);
      } else {
        writeNonStreamingSuccess(response, model, plannedReply, requestPath);
      }
      completeRequestSummary(requestSummary, { outcome: "success", status: 200 });
      return;
    }
    case "tool_call": {
      if (body.stream === true) {
        writeStreamingToolCall(response, model, behavior, requestPath);
      } else {
        writeNonStreamingToolCall(response, model, behavior, requestPath);
      }
      completeRequestSummary(requestSummary, { outcome: "tool_call", status: 200 });
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
      case "stream_controlled":
        if (!Array.isArray(entry.chunks) || entry.chunks.length < 2 || entry.chunks.length > 200)
          throw new TypeError("Controlled stream requires 2-200 chunks");
        return {
          type: entry.type,
          delayMs,
          chunks: entry.chunks.map((chunk, chunkIndex) =>
            normalizeBoundedText(chunk, `dispatchPlan[${index}].chunks[${chunkIndex}]`),
          ),
        };
      case "provider_error":
        return {
          type: "provider_error",
          delayMs,
          faultClockMarker: normalizeFaultClockMarker(
            entry.faultClockMarker,
            `dispatchPlan[${index}].faultClockMarker`,
          ),
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
          status: normalizeHttpErrorStatus(entry.status, `dispatchPlan[${index}].status`),
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
      case "tool_call":
        return {
          type: "tool_call",
          delayMs,
          name: normalizeToolName(entry.name, `dispatchPlan[${index}].name`),
          arguments: normalizeToolArguments(entry.arguments, `dispatchPlan[${index}].arguments`),
          callId: normalizeToolCallId(entry.callId ?? `call_stub_${index + 1}`, `dispatchPlan[${index}].callId`),
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

function matchPromptReplyRule(messages, rules) {
  if (rules.length === 0) return undefined;
  const userContent = collectPromptRoleContent(messages, "user");
  const systemContent = collectPromptRoleContent(messages, "system");
  return rules.find((rule) =>
    rule.userContentIncludes !== undefined
      ? userContent.includes(rule.userContentIncludes)
      : systemContent.includes(rule.systemContentIncludes),
  );
}

function promptMessages(body, requestPath) {
  const messages = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : typeof body.input === "string"
        ? [{ role: "user", content: body.input }]
        : [];
  return requestPath === "/v1/responses" && typeof body.instructions === "string"
    ? [{ role: "system", content: body.instructions }, ...messages]
    : messages;
}

function collectPromptRoleContent(messages, role) {
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

function summarizePromptMetadata(messages) {
  const userContent = collectPromptRoleContent(messages, "user");
  const systemContent = collectPromptRoleContent(messages, "system");
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
  const host = value.trim().toLowerCase();
  const bracketed = host.startsWith("[") && host.endsWith("]");
  const ip = bracketed ? host.slice(1, -1) : host;
  if (isIP(ip) === 6) return new URL(`http://[${ip}]`).hostname.slice(1, -1);
  if (!bracketed && isIP(ip) === 4) return ip;
  const labels = host.replace(/\.$/u, "").split(".");
  const dnsName = host.length <= 253 && labels.every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part));
  if (dnsName && !/^(?:\d+|0x[0-9a-f]*)$/u.test(labels.at(-1))) return host;
  throw new TypeError(`${label} must be a plain hostname or IP address`);
}

function formatUrlHost(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}

function normalizeDelayMs(value, label) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 300_000) {
    throw new TypeError(`${label} must be between 0 and 300000`);
  }
  return Math.floor(parsed);
}

function normalizeHttpErrorStatus(value, label) {
  const parsed = Number(value ?? 500);
  if (!Number.isInteger(parsed) || parsed < 400 || parsed > 599) {
    throw new TypeError(`${label} must be an HTTP error status`);
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

function normalizeFaultClockMarker(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new TypeError(`${label} must be a header-safe fixture marker of at most 128 characters`);
  }
  return value;
}

function normalizeToolName(value, label) {
  const normalized = normalizeBoundedText(value, label);
  if (!TOOL_NAME_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a provider-safe function name`);
  }
  return normalized;
}

function normalizeToolCallId(value, label) {
  const normalized = normalizeBoundedText(value, label);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(normalized)) {
    throw new TypeError(`${label} must be a provider-safe call id`);
  }
  return normalized;
}

function normalizeToolArguments(value, label) {
  let serialized;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value ?? {});
  } catch {
    throw new TypeError(`${label} must be JSON serializable`);
  }
  if (typeof serialized !== "string" || serialized.length > MAX_TOOL_ARGUMENT_CHARACTERS) {
    throw new TypeError(`${label} must serialize to no more than ${MAX_TOOL_ARGUMENT_CHARACTERS} characters`);
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new TypeError(`${label} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return serialized;
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
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 } },
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
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 0 } },
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
          usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 } },
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
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 0 } },
    },
  ];
  for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function writeNonStreamingToolCall(response, model, behavior, requestPath) {
  if (requestPath === "/v1/responses") {
    const item = buildResponsesToolCallItem(behavior);
    writeJsonResponse(response, 200, {
      id: "stub-response-tool-call",
      object: "response",
      status: "completed",
      model,
      output: [item],
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 0 } },
    });
    return;
  }
  writeJsonResponse(response, 200, {
    id: "stub-completion-tool-call",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [buildChatToolCall(behavior)],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } },
  });
}

function writeStreamingToolCall(response, model, behavior, requestPath) {
  response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
  if (requestPath === "/v1/responses") {
    const item = buildResponsesToolCallItem(behavior);
    const frames = [
      { type: "response.output_item.done", item },
      {
        type: "response.completed",
        response: {
          id: "stub-response-tool-call",
          object: "response",
          status: "completed",
          model,
          output: [item],
          usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 0 } },
        },
      },
    ];
    for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }
  const frames = [
    {
      id: "stub-stream-tool-call",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, ...buildChatToolCall(behavior) }] } }],
    },
    {
      id: "stub-stream-tool-call",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } },
    },
  ];
  for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function buildResponsesToolCallItem(behavior) {
  return {
    id: `item_${behavior.callId}`,
    type: "function_call",
    call_id: behavior.callId,
    name: behavior.name,
    arguments: behavior.arguments,
  };
}

function buildChatToolCall(behavior) {
  return {
    id: behavior.callId,
    type: "function",
    function: { name: behavior.name, arguments: behavior.arguments },
  };
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
          usage: { input_tokens: 12, output_tokens: 0, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } },
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

// A completed upload does not close the response. A delay may also expire normally.
function waitForResponseClose(request, response, timeoutMs) {
  if (request.aborted || response.destroyed || response.writableFinished) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = timeoutMs === undefined ? undefined : setTimeout(finish, timeoutMs);
    timer?.unref?.();
    request.once("aborted", finish);
    response.once("close", finish);

    function finish() {
      clearTimeout(timer);
      request.off("aborted", finish);
      response.off("close", finish);
      resolve(undefined);
    }
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

async function readBoundedRequestBody(request, summary) {
  if (Number(request.headers["content-length"]) > MAX_REQUEST_BODY_BYTES) return undefined;
  const chunks = [];
  let bytes = 0;
  // Keep the socket writable long enough to send the 413 response.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    summary.requestBodyBytes = bytes;
    if (bytes > MAX_REQUEST_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function writeJsonResponse(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
