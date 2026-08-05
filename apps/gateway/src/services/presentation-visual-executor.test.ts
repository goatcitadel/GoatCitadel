import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import { prepareApprovedPresentationVisuals } from "./presentation-visual-executor.js";

const ORIGINAL_KILL_SWITCH = process.env.GOATCITADEL_DISABLE_RICH_PRESENTATION_VISUALS;

afterEach(() => {
  if (ORIGINAL_KILL_SWITCH === undefined) delete process.env.GOATCITADEL_DISABLE_RICH_PRESENTATION_VISUALS;
  else process.env.GOATCITADEL_DISABLE_RICH_PRESENTATION_VISUALS = ORIGINAL_KILL_SWITCH;
});

describe("approved presentation visual execution", () => {
  it("maps a cover and three section visuals with two-call concurrency and complete attribution", async () => {
    let active = 0;
    let peak = 0;
    const generateImage = vi.fn(async (_request, attribution) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        providerId: "openai",
        model: "gpt-image-2",
        operation: "generate" as const,
        data: [{ b64Json: `bytes-${String(attribution?.operationId)}` }],
      };
    });
    const result = await prepareApprovedPresentationVisuals({
      request: presentationRequest(),
      generateImage,
    });

    expect(result.plan).toHaveLength(4);
    expect(result.plan[0]).toMatchObject({ slideIndex: 0, kind: "cover" });
    expect(result.plan.filter((item) => item.visualBrief)).toHaveLength(2);
    expect(result.assets.map((item) => item.slideIndex)).toEqual(result.plan.map((item) => item.slideIndex));
    expect(generateImage).toHaveBeenCalledTimes(4);
    expect(peak).toBeLessThanOrEqual(2);
    expect(result.providerCalls).toBe(4);
    expect(generateImage.mock.calls[0]?.[1]).toMatchObject({
      callKind: "utility",
      utilityKind: "presentation_visual_generation",
      workspaceId: "workspace-visuals",
      sessionId: "session-visuals",
      turnId: "turn-visuals",
    });
    expect(JSON.stringify(result.plan)).not.toContain("bytes-");
  });

  it("honors the rich-visual kill switch without calling a provider", async () => {
    process.env.GOATCITADEL_DISABLE_RICH_PRESENTATION_VISUALS = "true";
    const generateImage = vi.fn();
    await expect(
      prepareApprovedPresentationVisuals({ request: presentationRequest(), generateImage }),
    ).resolves.toEqual({ plan: [], assets: [], warnings: [], providerCalls: 0 });
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("distributes unbriefed section visuals and degrades partial provider failure to a warning", async () => {
    const request = presentationRequest();
    request.args.slides = (request.args.slides as Array<Record<string, unknown>>).map(
      ({ visualBrief: _visualBrief, ...slide }) => slide,
    );
    let call = 0;
    const generateImage = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error("temporary image provider outage");
      return {
        providerId: "openai",
        model: "gpt-image-2",
        operation: "generate" as const,
        data: [{ b64Json: `bytes-${call}` }],
      };
    });

    const result = await prepareApprovedPresentationVisuals({ request, generateImage });

    expect(result.plan.map((item) => item.slideIndex)).toEqual([0, 1, 5, 8]);
    expect(result.providerCalls).toBe(4);
    expect(result.assets).toHaveLength(3);
    expect(result.warnings.join(" ")).toMatch(/native renderer visual used|temporary image provider outage/i);
  });
});

function presentationRequest(): ToolInvokeRequest {
  return {
    toolName: "presentations.create",
    args: {
      path: "./workspace/goatcitadel_out/grounded.pptx",
      title: "Grounded Research",
      slides: Array.from({ length: 8 }, (_, index) => ({
        title: `Section ${index + 1}`,
        bullets: [`Specific research point ${index + 1}`],
        ...(index === 1 || index === 5 ? { visualBrief: `Illustrate section ${index + 1}` } : {}),
      })),
    },
    agentId: "assistant",
    sessionId: "session-visuals",
    turnId: "turn-visuals",
    workspaceId: "workspace-visuals",
    runId: "run-visuals",
    taskId: "task-visuals",
  };
}
