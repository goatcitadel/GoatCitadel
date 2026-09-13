import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { normalizeComparisonTransport, sha256 } from "./agent-comparison.mjs";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REASONING = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const REQUEST_REJECTION_REASONS = new Set([
  "Unsupported comparison request.",
  "Hosted provider tools are outside the pinned text-token price boundary.",
  "Only text and function-tool messages are supported.",
  "Output token limit exceeds the pinned profile.",
  "Input exceeds the conservative token bound.",
  "Comparison transport body exceeds its limit.",
]);
const REQUEST_KEYS = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "stop",
  "seed",
  "response_format",
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "reasoning_effort",
  "service_tier",
  "n",
  "store",
  "user",
]);

/** Loopback-only transport instrumentation for an isolated comparison adapter.
 * Every HTTP attempt spends a reservation, including opaque SDK retries and
 * child calls. Their lineage is explicitly unclassified unless the product has
 * a separate canonical record. This is not an OS egress sandbox: adapters must
 * use isolated configuration and receive only this proxy's short-lived token. */
export async function createComparisonProviderProxy({
  budget,
  cellId,
  profile,
  upstreamUrl,
  upstreamApiKey,
  persistReceipt,
  fetchUpstream = fetch,
}) {
  validateComparisonProviderProfile(profile);
  const transport = normalizeComparisonTransport({
    upstreamUrl,
    outputField: profile.outputField,
    pricing: profile.pricing,
  });
  const upstream = new URL(transport.upstreamUrl);
  if (!upstreamApiKey || /[\r\n]/u.test(upstreamApiKey) || typeof persistReceipt !== "function")
    throw new Error("Comparison upstream credentials and a durable receipt sink are required.");
  if (typeof cellId !== "string" || !cellId || !budget || typeof budget.dispatch !== "function")
    throw new Error("Comparison proxy requires a campaign cell and budget owner.");
  const token = randomBytes(32).toString("base64url");
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const pending = new Set();
  const controllers = new Set();
  const receipts = [];
  let closed = false;
  const server = http.createServer((request, response) => {
    const operation = serve(request, response).catch(() =>
      reject(response, 502, "Comparison provider request failed; inspect retained transport evidence."),
    );
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  server.requestTimeout = Math.min(profile.maxTaskMs, 60_000);
  server.headersTimeout = Math.min(server.requestTimeout, 10_000);
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  await new Promise((resolve, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectStart);
      resolve();
    });
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: token,
    snapshot: () => structuredClone(receipts),
    async close() {
      if (closed) return;
      closed = true;
      const stopped = new Promise((resolve) => server.close(resolve));
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await Promise.allSettled([...pending]);
      await stopped;
    },
  };

  async function serve(request, response) {
    const authorization = Buffer.from(
      typeof request.headers.authorization === "string" ? request.headers.authorization : "",
    );
    if (
      closed ||
      authorization.length !== expectedAuthorization.length ||
      !timingSafeEqual(authorization, expectedAuthorization)
    )
      return reject(response, 401, "Comparison adapter credential is unavailable.");
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ object: "list", data: [{ id: profile.model, object: "model", owned_by: "comparison" }] }),
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions")
      return reject(response, 404, "This comparison transport supports only the pinned chat-completions model.");
    if (
      request.headers["content-encoding"] ||
      !String(request.headers["content-type"] ?? "").startsWith("application/json")
    )
      return reject(response, 415, "Comparison requests must be uncompressed JSON.");
    let body;
    try {
      body = validateBody(
        JSON.parse((await boundedBody(request, Math.min(profile.contextTokens, 1024 * 1024))).toString("utf8")),
        profile,
      );
    } catch (error) {
      return reject(
        response,
        400,
        REQUEST_REJECTION_REASONS.has(error.message)
          ? error.message
          : "Comparison request conflicts with the pinned model, modality, reasoning, or token limits.",
      );
    }
    const startedAt = new Date().toISOString();
    const maximumCostUsd =
      (profile.contextTokens * profile.pricing.inputUsdPerMillion +
        profile.outputTokens * profile.pricing.outputUsdPerMillion) /
        1_000_000 +
      profile.pricing.requestUsd;
    let attempted = false;
    try {
      await budget
        .dispatch({ cellId, role: "unclassified", maximumCostUsd }, async (reservation) => {
          attempted = true;
          const controller = new AbortController();
          controllers.add(controller);
          const disconnected = () => {
            if (!response.writableEnded) controller.abort();
          };
          response.once("close", disconnected);
          let native;
          try {
            // A cell can close while its reservation is being fsynced. Recheck
            // after that await so shutdown cannot start a new upstream request.
            if (closed || response.destroyed) throw new Error("Comparison cell closed before upstream dispatch.");
            const result = await fetchUpstream(upstream.href, {
              method: "POST",
              headers: {
                authorization: `Bearer ${upstreamApiKey}`,
                "content-type": "application/json",
                "accept-encoding": "identity",
              },
              body: JSON.stringify(body),
              redirect: "error",
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(profile.maxTaskMs)]),
            });
            const bytes = await boundedBody(result.body, MAX_RESPONSE_BYTES);
            const contentType = result.headers.get("content-type") ?? "";
            const usage = extractUsage(bytes, contentType);
            const cost = priceUsage(usage, profile);
            native = {
              schemaVersion: "goatcitadel.agent-comparison.provider-attempt.v1",
              cellId,
              budgetSequence: reservation.sequence,
              role: "unclassified",
              model: profile.model,
              requestSha256: sha256(body),
              responseSha256: sha256(bytes),
              status: result.status,
              startedAt,
              finishedAt: new Date().toISOString(),
              usage,
              costUsd: cost,
              costKind: cost === null ? "unavailable" : "usage_with_pinned_rates",
              pricingSha256: sha256(profile.pricing),
              upstreamOriginSha256: sha256(upstream.origin),
            };
            // Retain before returning bytes to the product. The local proxy buffers
            // streams to prove usage/cost first; time-to-first-token is unavailable.
            await persistReceipt(native);
            receipts.push(native);
            if (!result.ok || cost === null) {
              reject(
                response,
                502,
                "Comparison upstream failed or did not provide bounded usage. The full reservation remains held.",
              );
              throw new Error("Comparison upstream outcome has no settled cost.");
            }
            response.statusCode = result.status;
            response.setHeader(
              "content-type",
              contentType.startsWith("text/event-stream") ? "text/event-stream" : "application/json",
            );
            return { costUsd: cost, bytes };
          } catch (error) {
            if (!native) {
              const failure = {
                schemaVersion: "goatcitadel.agent-comparison.provider-attempt.v1",
                cellId,
                budgetSequence: reservation.sequence,
                role: "unclassified",
                model: profile.model,
                requestSha256: sha256(body),
                responseSha256: null,
                status: null,
                startedAt,
                finishedAt: new Date().toISOString(),
                usage: null,
                costUsd: null,
                costKind: "unavailable",
                pricingSha256: sha256(profile.pricing),
                upstreamOriginSha256: sha256(upstream.origin),
              };
              await persistReceipt(failure);
              receipts.push(failure);
            }
            throw error;
          } finally {
            controllers.delete(controller);
            response.removeListener("close", disconnected);
          }
        })
        .then((result) => {
          if (!response.destroyed && !response.writableEnded) response.end(result.bytes);
        });
    } catch {
      reject(
        response,
        attempted ? 502 : 429,
        attempted
          ? "Comparison dispatch outcome is uncertain; the full reservation remains held."
          : "Comparison budget or durable journal prevented provider dispatch.",
      );
    }
  }
}

export function validateComparisonProviderProfile(profile) {
  if (
    !profile ||
    typeof profile.model !== "string" ||
    !profile.model.trim() ||
    !REASONING.has(profile.reasoning) ||
    !["max_tokens", "max_completion_tokens"].includes(profile.outputField) ||
    ![profile.contextTokens, profile.outputTokens, profile.maxTaskMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    profile.outputTokens >= profile.contextTokens ||
    profile.contextTokens > 1_000_000 ||
    profile.maxTaskMs > 900_000
  )
    throw new Error("Comparison provider limits are invalid.");
}

function validateBody(body, profile) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.model !== profile.model ||
    Object.keys(body).some((key) => !REQUEST_KEYS.has(key)) ||
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.length > 1024 ||
    (body.n !== undefined && body.n !== 1) ||
    (body.stream !== undefined && typeof body.stream !== "boolean") ||
    (body.service_tier !== undefined && body.service_tier !== "default") ||
    (body.reasoning_effort !== undefined && body.reasoning_effort !== profile.reasoning) ||
    body.audio ||
    body.modalities ||
    body.web_search_options ||
    body.prediction
  )
    throw new Error("Unsupported comparison request.");
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.some(
        (tool) =>
          tool?.type !== "function" ||
          !tool.function ||
          Object.keys(tool).some((key) => !["type", "function"].includes(key)),
      ))
  )
    throw new Error("Hosted provider tools are outside the pinned text-token price boundary.");
  for (const message of body.messages) {
    const textParts =
      Array.isArray(message?.content) &&
      message.content.every(
        (part) =>
          part &&
          part.type === "text" &&
          typeof part.text === "string" &&
          Object.keys(part).every((key) => key === "type" || key === "text"),
      );
    if (
      !message ||
      typeof message !== "object" ||
      (message.content !== null &&
        message.content !== undefined &&
        typeof message.content !== "string" &&
        !textParts) ||
      message.audio
    )
      throw new Error("Only text and function-tool messages are supported.");
  }
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    if (
      body[key] !== undefined &&
      (!Number.isSafeInteger(body[key]) || body[key] < 1 || body[key] > profile.outputTokens)
    )
      throw new Error("Output token limit exceeds the pinned profile.");
  }
  const normalized = {
    ...body,
    reasoning_effort: profile.reasoning,
    service_tier: "default",
    [profile.outputField]: profile.outputTokens,
  };
  delete normalized[profile.outputField === "max_tokens" ? "max_completion_tokens" : "max_tokens"];
  if (body.stream) normalized.stream_options = { include_usage: true };
  // Conservatively budget one token per serialized UTF-8 byte, including tool
  // schemas/role overhead. This text-only bound intentionally rejects large prompts.
  if (Buffer.byteLength(JSON.stringify(normalized)) > profile.contextTokens - profile.outputTokens)
    throw new Error("Input exceeds the conservative token bound.");
  return normalized;
}

async function boundedBody(stream, maximum) {
  if (!stream) throw new Error("Transport body is missing.");
  const parts = [];
  let length = 0;
  for await (const part of stream) {
    length += part.length;
    if (length > maximum) throw new Error("Comparison transport body exceeds its limit.");
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts, length);
}

function extractUsage(bytes, contentType) {
  try {
    const raw = bytes.toString("utf8");
    if (contentType.startsWith("application/json")) return normalizeUsage(JSON.parse(raw).usage);
    if (!contentType.startsWith("text/event-stream")) return null;
    let usage = null;
    let done = false;
    for (const event of raw.replace(/\r\n/gu, "\n").split("\n\n")) {
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      if (done) return null;
      if (data === "[DONE]") {
        done = true;
        continue;
      }
      const parsed = JSON.parse(data);
      if (parsed.error) return null;
      if (parsed.usage) {
        const current = normalizeUsage(parsed.usage);
        if (!current || (usage && JSON.stringify(current) !== JSON.stringify(usage))) return null;
        usage = current;
      }
    }
    return done ? usage : null;
  } catch {
    return null;
  }
}

function normalizeUsage(usage) {
  if (
    !usage ||
    ![usage.prompt_tokens, usage.completion_tokens].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    (usage.total_tokens !== undefined && usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens)
  )
    return null;
  return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
}

function priceUsage(usage, profile) {
  if (
    !usage ||
    usage.inputTokens > profile.contextTokens - profile.outputTokens ||
    usage.outputTokens > profile.outputTokens
  )
    return null;
  return (
    (usage.inputTokens * profile.pricing.inputUsdPerMillion +
      usage.outputTokens * profile.pricing.outputUsdPerMillion) /
      1_000_000 +
    profile.pricing.requestUsd
  );
}

function reject(response, status, message) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ error: { type: "comparison_transport", message } }));
}
