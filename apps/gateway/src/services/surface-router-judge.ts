import type { ChatCompletionRequest, ChatCompletionResponse, ChatMode } from "@goatcitadel/contracts";
import type { SurfaceJudgeInput, SurfaceJudgeResult } from "./surface-router-service.js";

export interface SurfaceRouterJudgeDeps {
  createChatCompletion: (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
  resolveModelDefaults: () => { providerId?: string; model?: string };
}

const SURFACE_JUDGE_SYSTEM_PROMPT =
  'Classify the user\'s first message into exactly one workspace mode:\n' +
  '- "chat": conversational Q&A or quick help.\n' +
  '- "cowork": multi-step research, comparison, planning, or coordinated work.\n' +
  '- "code": editing, running, debugging, or reviewing code in a bound project.\n' +
  'Reply with ONLY compact JSON, no prose: {"mode":"chat"|"cowork"|"code","confidence":<number 0..1>}.';

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
    typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : 0.6;
  return { mode: mode as ChatMode, confidence };
}

export function buildSurfaceRouterJudge(deps: SurfaceRouterJudgeDeps) {
  return async function surfaceRouterJudge(input: SurfaceJudgeInput): Promise<SurfaceJudgeResult | undefined> {
    try {
      const priorsText = input.priors.length
        ? input.priors.map((prior) => `${prior.fromMode}->${prior.toMode}`).join(", ")
        : "none";
      const defaults = deps.resolveModelDefaults();
      const completion = await deps.createChatCompletion({
        providerId: defaults.providerId,
        model: defaults.model,
        messages: [
          { role: "system", content: SURFACE_JUDGE_SYSTEM_PROMPT },
          { role: "user", content: `Message: ${input.prompt}\nRecent mode-corrections in this citadel (from->to): ${priorsText}` },
        ],
        temperature: 0,
        max_tokens: 40,
      });
      const rawContent = completion.choices?.[0]
        ? (completion.choices[0] as { message?: { content?: string } }).message?.content
        : undefined;
      const content = typeof rawContent === "string" ? rawContent : "";
      return parseSurfaceJudgeResult(content);
    } catch {
      return undefined;
    }
  };
}
