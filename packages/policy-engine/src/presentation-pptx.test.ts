import { describe, expect, it } from "vitest";
import { createArtifactDesignPlan } from "./artifact-design.js";
import {
  analyzePresentationDeckQuality,
  resolveContentSlideRenderer,
  resolvePresentationDeckLayoutPlan,
} from "./presentation-layout.js";

describe("presentation PPTX layout selection", () => {
  it("avoids sparse two-column slides when the preset layout rotates to two-column", () => {
    const design = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Benefits of Daily Walking",
      slides: [
        {
          title: "Why Walking Matters",
          bullets: [
            "Simple, low-cost activity that fits into most routines",
            "Supports physical health, mental clarity, and daily energy",
            "Easy to scale: start small and build consistency",
          ],
        },
      ],
    });

    expect(design.layouts[2]?.name).toBe("two-column");
    expect(
      resolveContentSlideRenderer(design, 2, {
        title: "Why Walking Matters",
        bullets: [
          "Simple, low-cost activity that fits into most routines",
          "Supports physical health, mental clarity, and daily energy",
          "Easy to scale: start small and build consistency",
        ],
      }),
    ).toBe("image-text");
  });

  it("keeps two-column rendering for dense slides", () => {
    const design = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Quarterly Update",
    });

    expect(
      resolveContentSlideRenderer(design, 2, {
        title: "Operating Detail",
        bullets: [
          "Pipeline review needs clearer ownership before the next milestone",
          "Support load is concentrated around onboarding and workspace setup",
          "Review evidence should be collected with each release candidate",
          "Follow-up work should stay scoped to the operator-visible runtime",
        ],
      }),
    ).toBe("two-column");
    expect(
      resolveContentSlideRenderer(design, 1, {
        title: "Operating Detail",
        bullets: [
          "Pipeline review needs clearer ownership before the next milestone",
          "Support load is concentrated around onboarding and workspace setup",
          "Review evidence should be collected with each release candidate",
          "Follow-up work should stay scoped to the operator-visible runtime",
          "Release notes should distinguish shipped behavior from upcoming work",
        ],
      }),
    ).toBe("two-column");
  });

  it("uses callouts only for concise takeaway-style content", () => {
    const design = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Quarterly Update",
    });

    expect(
      resolveContentSlideRenderer(design, 1, {
        title: "Key impact",
        bullets: ["Retention improved after the onboarding change."],
      }),
    ).toBe("stat-callout");
    expect(
      resolveContentSlideRenderer(design, 1, {
        title: "Key impact",
        bullets: [
          "This takeaway is intentionally long enough to behave like body copy instead of a hero callout, because the renderer should not create oversized statement layouts for paragraph-scale text that will be hard to scan.",
        ],
      }),
    ).toBe("image-text");
  });

  it("summarizes deck layout quality for design-report validation", () => {
    const design = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Benefits of Daily Walking",
    });
    const deckSlides = [
      { title: "Benefits of Daily Walking", bullets: ["A lightweight deck"] },
      {
        title: "Why Walking Matters",
        bullets: [
          "Simple, low-cost activity that fits into most routines",
          "Supports physical health, mental clarity, and daily energy",
          "Easy to scale: start small and build consistency",
        ],
      },
      {
        title: "Daily Rhythm",
        bullets: ["Morning walk", "Evening reset", "Weekend trail", "Errand loop", "Commute substitute"],
      },
    ];

    const layoutPlan = resolvePresentationDeckLayoutPlan(design, deckSlides);
    const quality = analyzePresentationDeckQuality(design, deckSlides);

    expect(layoutPlan[0]?.renderer).toBe("hero");
    expect(layoutPlan[1]?.renderer).toBe("image-text");
    expect(layoutPlan[2]?.renderer).toBe("image-text");
    expect(quality).toMatchObject({
      slideCount: 3,
      contentSlideCount: 2,
      emptyContentSlideCount: 0,
      denseContentSlideCount: 0,
      rendererCounts: { "image-text": 2, "two-column": 0, "stat-callout": 0 },
      warnings: [],
    });
  });
});
