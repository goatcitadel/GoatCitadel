import { createHash } from "node:crypto";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";
import type {
  ImageGenerationRequest,
  ImageGenerationResponse,
  ModelUsageAttributionContext,
  ToolInvokeRequest,
} from "@goatcitadel/contracts";
import type {
  PreparedPresentationVisual,
  PreparedPresentationVisuals,
  PresentationVisualPlanItem,
} from "@goatcitadel/policy-engine";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";

const MAX_GENERATED_VISUALS = 4;
const MAX_CONCURRENT_IMAGE_REQUESTS = 2;

type GenerateImage = (
  request: ImageGenerationRequest,
  attribution?: ModelUsageAttributionContext,
) => Promise<ImageGenerationResponse>;

export function richPresentationVisualsEnabled(): boolean {
  return !/^(?:1|true|yes|on)$/iu.test(process.env.GOATCITADEL_DISABLE_RICH_PRESENTATION_VISUALS?.trim() ?? "");
}

export async function prepareApprovedPresentationVisuals(input: {
  request: ToolInvokeRequest;
  generateImage: GenerateImage;
}): Promise<PreparedPresentationVisuals> {
  if (!richPresentationVisualsEnabled() || input.request.toolName !== "presentations.create") {
    return { plan: [], assets: [], warnings: [], providerCalls: 0 };
  }
  const designMode = text(record(input.request.args.design).mode)?.toLowerCase();
  if (designMode === "plain" || designMode === "minimal") {
    return { plan: [], assets: [], warnings: [], providerCalls: 0 };
  }
  const planWithPrompts = buildPresentationVisualPlan(input.request.args);
  const assets: PreparedPresentationVisual[] = [];
  const warnings: string[] = [];
  let providerCalls = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < planWithPrompts.length) {
      const current = planWithPrompts[cursor++];
      if (!current) continue;
      providerCalls += 1;
      try {
        const response = await input.generateImage(
          {
            prompt: current.prompt,
            n: 1,
            outputFormat: "png",
            responseFormat: "b64_json",
            timeoutMs: 60_000,
          },
          createUtilityModelUsageAttribution({
            operationId: `presentation-visual:${input.request.turnId ?? input.request.runId ?? input.request.sessionId}:${current.item.slideIndex}:${current.item.promptSha256.slice(0, 12)}`,
            utilityKind: "presentation_visual_generation",
            lineage: {
              workspaceId: input.request.workspaceId,
              sessionId: input.request.sessionId,
              turnId: input.request.turnId,
              durableRunId: input.request.runId,
              taskId: input.request.taskId,
              agentId: input.request.agentId,
            },
          }),
        );
        const image = response.data.find((item) => typeof item.b64Json === "string" && item.b64Json.length > 0);
        if (!image?.b64Json) {
          warnings.push(
            `No image bytes were returned for slide ${current.item.slideIndex} (${current.item.slideTitle}); native renderer visual used.`,
          );
          continue;
        }
        assets.push({
          slideIndex: current.item.slideIndex,
          promptSha256: current.item.promptSha256,
          asset: {
            bytesBase64: image.b64Json,
            mimeType: "image/png",
            altText:
              current.item.kind === "cover"
                ? `Generated cover visual for ${current.item.slideTitle}.`
                : `Generated section visual for ${current.item.slideTitle}.`,
            source: response.providerId ?? "configured-image-provider",
            sourceModel: response.model ?? "configured-image-model",
            revisedPrompt: image.revisedPrompt,
          },
        });
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (isAuthoritativeModelUsageAccountingError(normalized)) throw normalized;
        warnings.push(
          `Image generation failed for slide ${current.item.slideIndex} (${current.item.slideTitle}); native renderer visual used. Cause: ${normalized.message.slice(0, 240)}`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_IMAGE_REQUESTS, planWithPrompts.length) }, () => worker()),
  );
  assets.sort((left, right) => left.slideIndex - right.slideIndex);
  return {
    plan: planWithPrompts.map((item) => item.item),
    assets,
    warnings,
    providerCalls,
  };
}

function buildPresentationVisualPlan(
  args: Record<string, unknown>,
): Array<{ item: PresentationVisualPlanItem; prompt: string }> {
  const title = text(args.title) ?? "Presentation";
  const rawSlides = Array.isArray(args.slides) ? args.slides : [];
  const slides = rawSlides
    .map((value, index) => {
      const slide = record(value);
      return {
        index,
        title: text(slide.title) ?? `Section ${index + 1}`,
        bullets: Array.isArray(slide.bullets)
          ? slide.bullets.map(text).filter((value): value is string => Boolean(value))
          : [],
        visualBrief: text(slide.visualBrief),
      };
    })
    .slice(0, 40);
  const plans: Array<{ slideIndex: number; slideTitle: string; kind: "cover" | "section"; visualBrief?: string }> = [];
  if (!hasInlineVisualAsset(args.visualAsset)) {
    plans.push({ slideIndex: 0, slideTitle: title, kind: "cover" });
  }
  for (const slideIndex of chooseSectionSlideIndexes(slides)) {
    const slide = slides[slideIndex];
    if (!slide) continue;
    plans.push({
      slideIndex: slide.index + 1,
      slideTitle: slide.title,
      kind: "section",
      ...(slide.visualBrief ? { visualBrief: slide.visualBrief } : {}),
    });
  }
  return plans.slice(0, MAX_GENERATED_VISUALS).map((plan) => {
    const sourceSlide = plan.kind === "section" ? slides[plan.slideIndex - 1] : undefined;
    const prompt = [
      `Create a polished, editorial PowerPoint ${plan.kind} visual for "${plan.slideTitle}" in the deck "${title}".`,
      plan.visualBrief ? `Visual direction: ${plan.visualBrief}.` : undefined,
      sourceSlide?.bullets.length ? `Concepts to represent: ${sourceSlide.bullets.slice(0, 5).join("; ")}.` : undefined,
      "Use a specific subject-appropriate composition, strong focal hierarchy, generous negative space, and presentation-safe landscape framing.",
      "Do not include readable words, logos, watermarks, UI chrome, or generic stock-photo staging.",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      item: {
        ...plan,
        promptSha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
      },
      prompt,
    };
  });
}

function chooseSectionSlideIndexes(slides: Array<{ index: number; visualBrief?: string }>): number[] {
  const count = Math.min(3, slides.length);
  if (count === 0) return [];
  const selected: number[] = [];
  for (const slide of slides) {
    if (slide.visualBrief && selected.length < count) selected.push(slide.index);
  }
  for (let slot = 0; selected.length < count && slot < count; slot += 1) {
    const candidate =
      count === 1 ? Math.floor((slides.length - 1) / 2) : Math.round((slot * (slides.length - 1)) / (count - 1));
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  for (let index = 0; selected.length < count && index < slides.length; index += 1) {
    if (!selected.includes(index)) selected.push(index);
  }
  return selected.slice(0, count).sort((left, right) => left - right);
}

function hasInlineVisualAsset(value: unknown): boolean {
  const asset = record(value);
  return Boolean(text(asset.bytesBase64) ?? text(asset.b64Json) ?? text(asset.dataBase64));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/gu, " ").slice(0, 800) : undefined;
}
