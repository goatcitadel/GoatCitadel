import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMode,
  ModelUsageAttributionContext,
} from "@goatcitadel/contracts";
import type { SurfaceJudgeInput, SurfaceJudgeResult } from "./surface-router-service.js";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";

export interface SurfaceRouterJudgeDeps {
  createChatCompletion: (
    request: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ) => Promise<ChatCompletionResponse>;
  resolveModelDefaults: () => Promise<{ providerId?: string; model?: string }>;
}

const SURFACE_JUDGE_SYSTEM_PROMPT =
  "GoatCitadel has one operator conversation surface: chat. " +
  'Reply with ONLY compact JSON, no prose: {"mode":"chat","confidence":<number 0..1>}.';

/** Parse the judge model's reply into a result, or undefined if unparseable/invalid. Pure + exported for testing. */
export function parseSurfaceJudgeResult(content: string): SurfaceJudgeResult | undefined {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const mode = (parsed as Record<string, unknown>).mode;
  if (mode !== "chat" && mode !== "cowork" && mode !== "code") {
    return undefined;
  }
  const rawConfidence = (parsed as Record<string, unknown>).confidence;
  const confidence =
    typeof rawConfidence === "number" && Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0.6;
  return { mode: "chat" as ChatMode, confidence };
}

export function buildSurfaceRouterJudge(deps: SurfaceRouterJudgeDeps) {
  return async function surfaceRouterJudge(input: SurfaceJudgeInput): Promise<SurfaceJudgeResult | undefined> {
    try {
      const priorsText = input.priors.length
        ? input.priors.map((prior) => `${prior.fromMode}->${prior.toMode}`).join(", ")
        : "none";
      const defaults = await deps.resolveModelDefaults();
      const completion = await deps.createChatCompletion(
        {
          providerId: defaults.providerId,
          model: defaults.model,
          messages: [
            { role: "system", content: SURFACE_JUDGE_SYSTEM_PROMPT },
            {
              role: "user",
              content: `Message: ${input.prompt}\nRecent mode-corrections in this citadel (from->to): ${priorsText}`,
            },
          ],
          temperature: 0,
          max_tokens: 40,
        },
        createUtilityModelUsageAttribution({
          operationId: `chat-turn:${encodeURIComponent(input.turnId)}:surface-router-judge`,
          utilityKind: "surface_router_judge",
          requestedProviderId: defaults.providerId,
          requestedModelId: defaults.model,
          lineage: {
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            agentId: "surface-router-judge",
            parentOperationId: `chat-turn:${encodeURIComponent(input.turnId)}`,
          },
        }),
      );
      const rawContent = completion.choices?.[0]
        ? (completion.choices[0] as { message?: { content?: string } }).message?.content
        : undefined;
      const content = typeof rawContent === "string" ? rawContent : "";
      return parseSurfaceJudgeResult(content);
    } catch (error) {
      if (isAuthoritativeModelUsageAccountingError(error)) {
        throw error;
      }
      return undefined;
    }
  };
}
