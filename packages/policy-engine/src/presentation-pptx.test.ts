import { afterEach, describe, expect, it, vi } from "vitest";
import { createArtifactDesignPlan } from "./artifact-design.js";
import {
  analyzePresentationDeckQuality,
  resolveContentSlideRenderer,
  resolvePresentationDeckLayoutPlan,
} from "./presentation-layout.js";
import { buildPresentationSlideVisuals, createPresentationPptxWithDiagnostics } from "./presentation-pptx.js";

afterEach(() => {
  vi.doUnmock("pptxgenjs");
  vi.doUnmock("sharp");
});

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

  it("alternates stacked and two-column rendering for dense slides", () => {
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
    ).toBe("stacked-list");
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
    expect(
      resolveContentSlideRenderer(design, 1, {
        title: "Physical Health Benefits",
        bullets: ["Supports heart health", "Helps maintain mobility", "Can improve energy levels"],
      }),
    ).toBe("stat-callout");
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
      weakContentSlideCount: 1,
      rendererCounts: { "image-text": 2, "two-column": 0, "stat-callout": 0 },
      templateWarnings: [],
      contentWarnings: [],
      warnings: [],
    });
  });

  it("warns when a deck repeats the same sparse content template too often", () => {
    const design = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Daily Walking",
    });
    const deckSlides = [
      { title: "Daily Walking", bullets: ["Quick overview"] },
      { title: "Plan", bullets: ["Walk more", "Start today", "Keep going"] },
      { title: "Routine", bullets: ["Pick time", "Set route", "Go outside"] },
      { title: "Habits", bullets: ["Use shoes", "Drink water", "Track wins"] },
      { title: "Progress", bullets: ["Walk daily", "Add minutes", "Repeat weekly"] },
    ];

    const quality = analyzePresentationDeckQuality(design, deckSlides);

    expect(quality.rendererCounts).toEqual({
      "image-text": 4,
      "two-column": 0,
      "stacked-list": 0,
      "stat-callout": 0,
    });
    expect(quality.templateWarnings).toEqual([expect.stringContaining("Layout variety is low")]);
    expect(quality.contentWarnings).toEqual([expect.stringContaining("very brief bullets")]);
  });

  it("treats very short single-bullet content slides as weak content", () => {
    const design = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Launch Notes",
    });
    const deckSlides = [
      { title: "Launch Notes", bullets: ["Quick overview"] },
      { title: "Status", bullets: ["Drafting"] },
      { title: "Risk", bullets: ["TBD"] },
      { title: "Next", bullets: ["Review"] },
    ];

    const quality = analyzePresentationDeckQuality(design, deckSlides);

    expect(quality.weakContentSlideCount).toBe(3);
    expect(quality.contentWarnings).toEqual([expect.stringContaining("very brief bullets")]);
  });

  it("builds unique local support visuals for each generated slide", async () => {
    const design = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Benefits of Daily Walking",
    });
    const deckSlides = [
      { title: "Benefits of Daily Walking", bullets: ["A quick wellness overview"] },
      {
        title: "Physical Health Benefits",
        bullets: ["Supports heart health", "Helps maintain mobility", "Can improve energy levels"],
      },
      {
        title: "Make It Easy",
        bullets: ["Attach walking to meals", "Prepare a short route", "Track the habit weekly"],
      },
    ];
    const layoutPlan = resolvePresentationDeckLayoutPlan(design, deckSlides);

    const visuals = await buildPresentationSlideVisuals("Benefits of Daily Walking", deckSlides, design, layoutPlan);

    expect(visuals).toHaveLength(deckSlides.length);
    expect(visuals.every((visual) => visual.source === "local-renderer")).toBe(true);
    expect(new Set(visuals.map((visual) => visual.dataUri)).size).toBe(deckSlides.length);
  });

  it("uses provided generated imagery only as the cover anchor", async () => {
    const design = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Benefits of Daily Walking",
    });
    const deckSlides = [
      { title: "Benefits of Daily Walking", bullets: ["A quick wellness overview"] },
      {
        title: "Physical Health Benefits",
        bullets: ["Supports heart health", "Helps maintain mobility", "Can improve energy levels"],
      },
    ];
    const layoutPlan = resolvePresentationDeckLayoutPlan(design, deckSlides);

    const visuals = await buildPresentationSlideVisuals("Benefits of Daily Walking", deckSlides, design, layoutPlan, {
      bytesBase64: "cover-image-base64",
      mimeType: "image/png",
      source: "openai",
      sourceModel: "gpt-image-2",
    });

    expect(visuals[0]).toMatchObject({
      dataUri: "data:image/png;base64,cover-image-base64",
      source: "openai:gpt-image-2",
    });
    expect(visuals[1]?.source).toBe("local-renderer");
    expect(visuals[1]?.dataUri).not.toBe(visuals[0]?.dataUri);
  });

  it("places ephemeral generated assets on their mapped section slides", async () => {
    const design = createArtifactDesignPlan({ kind: "presentation", format: "pptx", title: "Mapped Visuals" });
    const deckSlides = [
      { title: "Mapped Visuals", bullets: [] },
      { title: "Context", bullets: ["Grounded context"] },
      { title: "Decision", bullets: ["Grounded decision"] },
    ];
    const layoutPlan = resolvePresentationDeckLayoutPlan(design, deckSlides);
    const visuals = await buildPresentationSlideVisuals("Mapped Visuals", deckSlides, design, layoutPlan, undefined, [
      { slideIndex: 0, asset: { bytesBase64: "cover-bytes", source: "openai", sourceModel: "gpt-image-2" } },
      { slideIndex: 2, asset: { bytesBase64: "section-bytes", source: "openai", sourceModel: "gpt-image-2" } },
    ]);

    expect(visuals[0]?.dataUri).toContain("cover-bytes");
    expect(visuals[1]?.source).toBe("local-renderer");
    expect(visuals[2]).toMatchObject({
      dataUri: "data:image/png;base64,section-bytes",
      source: "openai:gpt-image-2",
    });
    const mappedLayoutPlan = resolvePresentationDeckLayoutPlan(design, deckSlides, new Set([2]));
    expect(mappedLayoutPlan[2]).toMatchObject({
      renderer: "image-text",
      reason: expect.stringContaining("approved section visual"),
    });
  });

  it("renders a mapped visual even when the section content is dense", async () => {
    const imageObjects: Array<Record<string, unknown>> = [];
    vi.doMock("sharp", () => ({
      default: () => ({ png: () => ({ toBuffer: async () => Buffer.from("mock-png") }) }),
    }));
    vi.doMock("pptxgenjs", () => ({
      default: class MockPptxGen {
        public layout = "";
        public author = "";
        public company = "";
        public subject = "";
        public title = "";
        public theme = {};
        public ShapeType = { rect: "rect", roundRect: "roundRect" };

        public addSlide() {
          const slide: Record<string, unknown> = {};
          slide.addShape = () => slide;
          slide.addImage = (options: Record<string, unknown>) => {
            imageObjects.push(options);
            return slide;
          };
          slide.addText = () => slide;
          slide.addNotes = () => slide;
          return slide;
        }

        public async write() {
          return Buffer.from("PKmock");
        }
      },
    }));

    await createPresentationPptxWithDiagnostics({
      title: "Mapped Dense Section",
      slides: [
        {
          title: "Storage",
          bullets: [
            "Keep cold food at safe temperatures and verify the appliance with a thermometer.",
            "Freeze short-lived food before it spoils and label each package clearly.",
            "Use product-specific storage guidance when shelf life varies.",
            "Rotate newly purchased products behind older ones.",
            "Store produce according to its temperature and humidity needs.",
          ],
        },
      ],
      visualAssets: [
        {
          slideIndex: 1,
          asset: { bytesBase64: "mapped-section-bytes", source: "openai", sourceModel: "gpt-image-2" },
        },
      ],
    });

    expect(imageObjects).toContainEqual(
      expect.objectContaining({
        data: "data:image/png;base64,mapped-section-bytes",
        objectName: "GoatCitadel section visual",
      }),
    );
  });

  it("keeps renderer provenance and local visual labels out of visible slide content", async () => {
    const visibleText: string[] = [];
    const notesText: string[] = [];
    const imageObjects: Array<Record<string, unknown>> = [];
    const localVisualSvg: string[] = [];

    vi.doMock("sharp", () => ({
      default: (input: Buffer) => {
        localVisualSvg.push(input.toString("utf8"));
        return {
          png: () => ({
            toBuffer: async () => Buffer.from("mock-png"),
          }),
        };
      },
    }));
    vi.doMock("pptxgenjs", () => ({
      default: class MockPptxGen {
        public layout = "";
        public author = "";
        public company = "";
        public subject = "";
        public title = "";
        public theme = {};
        public ShapeType = { rect: "rect", roundRect: "roundRect" };

        public addSlide() {
          const slide: Record<string, unknown> = {};
          slide.addShape = () => slide;
          slide.addImage = (options: Record<string, unknown>) => {
            imageObjects.push(options);
            return slide;
          };
          slide.addText = (text: string) => {
            visibleText.push(String(text));
            return slide;
          };
          slide.addNotes = (notes: string) => {
            notesText.push(notes);
            return slide;
          };
          return slide;
        }

        public async write() {
          return Buffer.from("PKmock");
        }
      },
    }));

    const result = await createPresentationPptxWithDiagnostics({
      title: "Weekend Fun",
      subtitle: "Simple activities",
      slides: [
        {
          title: "Choose The Mood",
          bullets: ["Go outside", "Cook something relaxed", "Try a local event"],
        },
        {
          title: "Keep It Easy",
          bullets: [
            "Pick one active option",
            "Pick one creative option",
            "Pick one restful option",
            "Keep the budget low",
            "Leave room for spontaneity",
          ],
        },
      ],
    });

    expect(result.renderer).toBe("pptxgenjs");
    expect(visibleText.join("\n")).not.toMatch(/GoatCitadel design brief|Designed artifact|Image Text/u);
    expect(notesText.join("\n")).toContain("GoatCitadel design provenance");
    expect(localVisualSvg.join("\n")).not.toContain("<text");
    expect(imageObjects.some((image) => image.objectName === "GoatCitadel accent visual")).toBe(false);
  });

  it("keeps generated visuals safe when raw callers omit display strings", async () => {
    const design = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Fallback Strings",
    });
    const deckSlides = [{ title: undefined as unknown as string, bullets: [] }];
    const layoutPlan = resolvePresentationDeckLayoutPlan(design, deckSlides);

    const visuals = await buildPresentationSlideVisuals(undefined as unknown as string, deckSlides, design, layoutPlan);

    expect(visuals).toHaveLength(1);
    expect(visuals[0]?.dataUri).toMatch(/^data:image\/png;base64,/u);
  });

  it("returns truthful diagnostics when the PPTX renderer falls back", async () => {
    vi.doMock("pptxgenjs", () => ({
      default: class UnavailablePptxGen {
        constructor() {
          throw new Error("pptxgenjs unavailable");
        }
      },
    }));

    const result = await createPresentationPptxWithDiagnostics({
      title: "Fallback Deck",
      slides: [{ title: "Only Slide", bullets: ["A safe text fallback"] }],
    });

    expect(result.renderer).toBe("fallback");
    expect(result.fallbackTriggered).toBe(true);
    expect(result.usedAssetIds).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("text-only fallback deck")]);
    expect(result.buffer.subarray(0, 2).toString("utf8")).toBe("PK");
  });
});
