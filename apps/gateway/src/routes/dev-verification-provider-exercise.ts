import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";
import { createUtilityModelUsageAttribution } from "../services/utility-model-usage-attribution.js";

const providerExerciseSchema = z.object({
  providerId: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  scenario: z.enum(["simple", "stream", "tools", "structured"]),
});

const providerExerciseStructuredResponseSchema = z
  .object({
    summary: z.string().trim().min(1),
    confidence: z.string().trim().min(1),
  })
  .strict();

const PROVIDER_EXERCISE_TOOL_NAME = "echo_status";
const PROVIDER_EXERCISE_TOOL_MESSAGE = "goatcitadel-provider-tool-roundtrip";
const PROVIDER_EXERCISE_TOOL_ARGUMENT_MAX_BYTES = 4096;

export function registerDevVerificationProviderExerciseRoute(
  fastify: FastifyInstance,
  devVerificationEnabled: () => boolean,
): void {
  fastify.post("/api/v1/dev/verification/provider-exercise", async (request, reply) => {
    if (!devVerificationEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const parsed = providerExerciseSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const startedAt = Date.now();
    try {
      const payload = buildProviderExercisePayload(parsed.data.scenario, parsed.data.providerId, parsed.data.model);
      const usageAttribution = createUtilityModelUsageAttribution({
        operationId: `dev-provider-exercise:${encodeURIComponent(request.id)}`,
        utilityKind: "dev_provider_exercise",
        requestedProviderId: payload.providerId,
        requestedModelId: payload.model,
        lineage: { agentId: "dev-verification" },
      });
      if (parsed.data.scenario === "stream") {
        let chunkCount = 0;
        let preview = "";
        let returnedModel: string | undefined;
        let routing: Record<string, unknown> | undefined;
        let usage: Record<string, unknown> | undefined;
        const modelUsageEventIds = new Set<string>();
        for await (const chunk of fastify.services.devVerification.createChatCompletionStream(
          payload,
          usageAttribution,
        )) {
          chunkCount += 1;
          returnedModel = readNonEmptyString(chunk.model) ?? returnedModel;
          routing = asRecord(chunk.routing) ?? routing;
          usage = asRecord(chunk.usage) ?? usage;
          collectProviderExerciseUsageEventIds(modelUsageEventIds, chunk);
          preview = appendProviderExerciseStreamPreview(preview, chunk);
        }
        if (!returnedModel) {
          throw new Error("Provider verification failed: the streaming response did not report a returned model.");
        }
        if (!preview.trim()) {
          throw new Error("Provider verification failed: the streaming response contained no assistant text.");
        }
        return reply.send({
          ok: true,
          requestedProviderId: payload.providerId ?? null,
          requestedModel: payload.model ?? null,
          providerId: readNonEmptyString(routing?.effectiveProviderId) ?? null,
          model: returnedModel,
          scenario: parsed.data.scenario,
          elapsedMs: Date.now() - startedAt,
          chunkCount,
          outputPreview: preview,
          routing: routing ?? null,
          usage: usage ?? null,
          modelUsageEventIds: [...modelUsageEventIds],
        });
      }

      const result = await fastify.services.devVerification.createChatCompletion(payload, usageAttribution);
      if (parsed.data.scenario === "tools") {
        const observed = requireProviderExerciseToolCall(result);
        const toolResult = {
          ok: true,
          message: PROVIDER_EXERCISE_TOOL_MESSAGE,
        };
        const followupPayload: ChatCompletionRequest = {
          providerId: payload.providerId,
          model: payload.model,
          memory: payload.memory,
          messages: [
            ...payload.messages,
            observed.assistantMessage,
            {
              role: "tool",
              tool_call_id: observed.toolCallId,
              content: JSON.stringify(toolResult),
            },
          ],
        };
        const followupAttribution = createUtilityModelUsageAttribution({
          operationId: `dev-provider-exercise:${encodeURIComponent(request.id)}:tool-result`,
          utilityKind: "dev_provider_exercise",
          requestedProviderId: payload.providerId,
          requestedModelId: payload.model,
          lineage: { agentId: "dev-verification" },
        });
        const followup = await fastify.services.devVerification.createChatCompletion(
          followupPayload,
          followupAttribution,
        );
        const followupMessage = readProviderExerciseMessage(followup);
        if (readNonEmptyString(followupMessage?.role) !== "assistant") {
          throw new Error("Provider tool verification failed: the follow-up response was not an assistant message.");
        }
        if (readProviderExerciseToolCalls(followupMessage).length > 0) {
          throw new Error("Provider tool verification failed: the follow-up response requested another tool call.");
        }
        const content = readProviderExerciseContent(followupMessage);
        if (!content.trim()) {
          throw new Error("Provider tool verification failed: the follow-up response contained no assistant text.");
        }
        const firstEvidence = readProviderExerciseCompletionEvidence(result);
        const followupEvidence = readProviderExerciseCompletionEvidence(followup);
        const returnedModel = followupEvidence.model ?? firstEvidence.model;
        if (!returnedModel) {
          throw new Error(
            "Provider tool verification failed: the completion responses did not report a returned model.",
          );
        }
        return reply.send({
          ok: true,
          requestedProviderId: payload.providerId ?? null,
          requestedModel: payload.model ?? null,
          providerId: followupEvidence.providerId ?? firstEvidence.providerId ?? null,
          model: returnedModel,
          scenario: parsed.data.scenario,
          elapsedMs: Date.now() - startedAt,
          outputPreview: content.slice(0, 240),
          toolCallObserved: true,
          toolResultRoundTrip: true,
          toolName: PROVIDER_EXERCISE_TOOL_NAME,
          routing: followupEvidence.routing ?? firstEvidence.routing ?? null,
          usage: {
            toolCall: firstEvidence.usage ?? null,
            toolResult: followupEvidence.usage ?? null,
          },
          modelUsageEventIds: [
            ...new Set([...firstEvidence.modelUsageEventIds, ...followupEvidence.modelUsageEventIds]),
          ],
          phases: {
            toolCall: firstEvidence,
            toolResult: followupEvidence,
          },
        });
      }

      const evidence = readProviderExerciseCompletionEvidence(result);
      if (!evidence.model) {
        throw new Error("Provider verification failed: the completion response did not report a returned model.");
      }
      const message = readProviderExerciseMessage(result);
      if (readNonEmptyString(message?.role) !== "assistant") {
        throw new Error("Provider verification failed: the completion response was not an assistant message.");
      }
      const content = readProviderExerciseContent(message);
      if (!content.trim()) {
        throw new Error("Provider verification failed: the completion response contained no assistant text.");
      }
      if (parsed.data.scenario === "structured") {
        validateProviderExerciseStructuredContent(content);
      }
      return reply.send({
        ok: true,
        requestedProviderId: payload.providerId ?? null,
        requestedModel: payload.model ?? null,
        providerId: evidence.providerId ?? null,
        model: evidence.model,
        scenario: parsed.data.scenario,
        elapsedMs: Date.now() - startedAt,
        outputPreview: content.slice(0, 240),
        routing: evidence.routing ?? null,
        usage: evidence.usage ?? null,
        modelUsageEventIds: evidence.modelUsageEventIds,
      });
    } catch (error) {
      if (isAuthoritativeModelUsageAccountingError(error)) {
        throw error;
      }
      return reply.send({
        ok: false,
        requestedProviderId: parsed.data.providerId ?? null,
        requestedModel: parsed.data.model ?? null,
        providerId: null,
        model: null,
        scenario: parsed.data.scenario,
        elapsedMs: Date.now() - startedAt,
        error: (error as Error).message,
      });
    }
  });
}

function buildProviderExercisePayload(
  scenario: z.infer<typeof providerExerciseSchema>["scenario"],
  providerId?: string,
  model?: string,
): ChatCompletionRequest {
  const base: ChatCompletionRequest = {
    providerId,
    model,
    memory: {
      enabled: false,
      mode: "off",
    },
    messages: [
      {
        role: "system" as const,
        content: "You are a concise verification responder. Reply compactly.",
      },
      {
        role: "user" as const,
        content:
          scenario === "structured"
            ? "Return a short JSON object with keys summary and confidence."
            : "Reply with one short sentence confirming the provider is healthy.",
      },
    ],
  };

  if (scenario === "tools") {
    return {
      ...base,
      messages: [
        {
          role: "system" as const,
          content:
            "You are a provider tool-protocol verifier. Call the tool exactly once, then acknowledge its returned status in one short sentence.",
        },
        {
          role: "user" as const,
          content: `Call ${PROVIDER_EXERCISE_TOOL_NAME} exactly once with message ${JSON.stringify(
            PROVIDER_EXERCISE_TOOL_MESSAGE,
          )}. Do not answer before the tool result arrives. After it arrives, reply with one short sentence confirming the returned status.`,
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: PROVIDER_EXERCISE_TOOL_NAME,
            description: "Echo a health status message.",
            parameters: {
              type: "object",
              properties: {
                message: { type: "string" },
              },
              required: ["message"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: "required",
      parallel_tool_calls: false,
    };
  }

  if (scenario === "structured") {
    if (providerId === "deepseek") {
      return {
        ...base,
        response_format: {
          type: "json_object",
        },
      };
    }
    return {
      ...base,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "verification_status",
          ...(providerId === "anthropic" ? { strict: true } : {}),
          schema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              confidence: { type: "string" },
            },
            required: ["summary", "confidence"],
            additionalProperties: false,
          },
        },
      },
    };
  }

  if (scenario === "stream") {
    return {
      ...base,
      stream: true,
    };
  }

  return base;
}

function readProviderExerciseCompletionEvidence(result: unknown): {
  providerId?: string;
  model?: string;
  routing?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  modelUsageEventIds: string[];
} {
  const record = asRecord(result);
  const routing = asRecord(record?.routing);
  const eventIds = new Set<string>();
  if (record) collectProviderExerciseUsageEventIds(eventIds, record);
  return {
    providerId: readNonEmptyString(routing?.effectiveProviderId),
    model: readNonEmptyString(record?.model),
    routing,
    usage: asRecord(record?.usage),
    modelUsageEventIds: [...eventIds],
  };
}

function requireProviderExerciseToolCall(result: unknown): {
  toolCallId: string;
  assistantMessage: ChatCompletionRequest["messages"][number];
} {
  const message = readProviderExerciseMessage(result);
  if (readNonEmptyString(message?.role) !== "assistant") {
    throw new Error("Provider tool verification failed: the tool-call response was not an assistant message.");
  }
  const toolCalls = readProviderExerciseToolCalls(message);
  if (toolCalls.length !== 1) {
    throw new Error(`Provider tool verification failed: expected exactly one tool call, received ${toolCalls.length}.`);
  }
  const toolCall = toolCalls[0]!;
  if (readNonEmptyString(toolCall.type) !== "function") {
    throw new Error("Provider tool verification failed: the tool call was not a function call.");
  }
  const fn = asRecord(toolCall.function);
  const name = readNonEmptyString(fn?.name);
  if (name !== PROVIDER_EXERCISE_TOOL_NAME) {
    throw new Error(
      `Provider tool verification failed: expected ${PROVIDER_EXERCISE_TOOL_NAME}, received ${name ?? "no name"}.`,
    );
  }
  const toolCallId = readNonEmptyString(toolCall.id);
  if (!toolCallId) {
    throw new Error("Provider tool verification failed: the tool call did not include an id.");
  }
  const rawArguments = fn?.arguments;
  const serializedArguments =
    typeof rawArguments === "string" ? rawArguments : asRecord(rawArguments) ? JSON.stringify(rawArguments) : "";
  if (
    !serializedArguments ||
    Buffer.byteLength(serializedArguments, "utf8") > PROVIDER_EXERCISE_TOOL_ARGUMENT_MAX_BYTES
  ) {
    throw new Error("Provider tool verification failed: tool arguments were missing or exceeded the size limit.");
  }
  let parsedArguments: Record<string, unknown>;
  try {
    parsedArguments = asRecord(JSON.parse(serializedArguments)) ?? {};
  } catch {
    throw new Error("Provider tool verification failed: tool arguments were not valid JSON.");
  }
  if (
    parsedArguments.message !== PROVIDER_EXERCISE_TOOL_MESSAGE ||
    Object.keys(parsedArguments).some((key) => key !== "message")
  ) {
    throw new Error("Provider tool verification failed: echo_status received unexpected arguments.");
  }
  return {
    toolCallId,
    assistantMessage: {
      ...(message ?? {}),
      role: "assistant",
      content: typeof message?.content === "string" || Array.isArray(message?.content) ? message.content : "",
      tool_calls: [toolCall],
    } as ChatCompletionRequest["messages"][number],
  };
}

function validateProviderExerciseStructuredContent(content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Provider structured verification failed: the response was not valid JSON.");
  }
  if (!providerExerciseStructuredResponseSchema.safeParse(parsed).success) {
    throw new Error(
      "Provider structured verification failed: the response must contain only non-empty string summary and confidence fields.",
    );
  }
}

function readProviderExerciseMessage(result: unknown): Record<string, unknown> | undefined {
  const choices = asRecord(result)?.choices;
  const firstChoice = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
  return asRecord(firstChoice?.message);
}

function readProviderExerciseToolCalls(message: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return Array.isArray(message?.tool_calls)
    ? (message.tool_calls.map(asRecord).filter(Boolean) as Record<string, unknown>[])
    : [];
}

function readProviderExerciseContent(message: Record<string, unknown> | undefined): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map((item) => {
      const block = asRecord(item);
      return typeof block?.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join(" ");
}

function appendProviderExerciseStreamPreview(current: string, chunk: Record<string, unknown>): string {
  if (current.length >= 240) return current.slice(0, 240);
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const delta = asRecord(asRecord(choices[0])?.delta);
  const content = typeof delta?.content === "string" ? delta.content : "";
  return `${current}${content}`.slice(0, 240);
}

function collectProviderExerciseUsageEventIds(target: Set<string>, record: Record<string, unknown>): void {
  const candidates = [
    ...(Array.isArray(record.modelUsageEventIds) ? record.modelUsageEventIds : []),
    ...(Array.isArray(record.model_usage_event_ids) ? record.model_usage_event_ids : []),
    record.model_usage_event_id,
  ];
  for (const candidate of candidates) {
    const normalized = readNonEmptyString(candidate);
    if (normalized && normalized.length <= 256 && target.size < 256) target.add(normalized);
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
