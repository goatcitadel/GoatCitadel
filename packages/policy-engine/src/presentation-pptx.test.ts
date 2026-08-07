import { afterEach, describe, expect, it, vi } from "vitest";
import { createArtifactDesignPlan } from "./artifact-design.js";
import {
  analyzePresentationDeckQuality,
  resolveContentSlideRenderer,
  resolvePresentationDeckLayoutPlan,
} from "./presentation-layout.js";
import {
  buildPresentationSlideVisuals,
  createPresentationPptxWithDiagnostics,
  type PresentationPackageAuditReport,
} from "./presentation-pptx.js";
import { stablePresentationSourceId } from "./presentation-model.js";

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
      { title: "Routes", bullets: ["Pick a loop", "Check weather", "Bring water"] },
      { title: "Company", bullets: ["Invite a friend", "Call family", "Walk a dog"] },
      { title: "Recovery", bullets: ["Slow down", "Stretch later", "Rest well"] },
      { title: "Review", bullets: ["Track distance", "Note energy", "Plan next week"] },
    ];

    const quality = analyzePresentationDeckQuality(design, deckSlides);

    expect(quality.rendererCounts).toMatchObject({
      "image-text": 5,
      "two-column": 2,
      "stacked-list": 0,
      "stat-callout": 1,
    });
    expect(quality.templateWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Layout variety is low")]),
    );
    expect(quality.contentWarnings).toEqual([expect.stringContaining("very brief bullets")]);
  });

  it("uses distinct continuation layouts after two repeated semantic layouts", () => {
    const design = createArtifactDesignPlan({ kind: "presentation", format: "pptx", title: "Semantic rhythm" });
    const table = { headers: [{ text: "Game" }], rows: [[{ text: "Example" }]] };
    const chart = { type: "bar" as const, categories: ["Example"], series: [{ name: "Signal", values: [1] }] };
    const deckSlides = [
      { title: "Semantic rhythm", bullets: ["Overview"] },
      ...Array.from({ length: 3 }, (_, index) => ({ title: `Table ${index}`, bullets: [], table })),
      ...Array.from({ length: 3 }, (_, index) => ({ title: `Chart ${index}`, bullets: [], chart })),
      ...Array.from({ length: 3 }, (_, index) => ({
        title: `Section ${index}`,
        bullets: ["Section detail"],
        archetype: "section" as const,
      })),
    ];

    const renderers = resolvePresentationDeckLayoutPlan(design, deckSlides).map((item) => item.renderer);

    expect(renderers).toEqual([
      "hero",
      "table",
      "table",
      "table-continuation",
      "chart",
      "chart",
      "chart-continuation",
      "section",
      "section",
      "section-continuation",
    ]);
    expect(analyzePresentationDeckQuality(design, deckSlides).templateWarnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("repeats")]),
    );
  });

  it("exempts only generated source appendix slides from identical-layout runs", () => {
    const design = createArtifactDesignPlan({ kind: "presentation", format: "pptx", title: "Source rhythm" });
    const generatedSources = Array.from({ length: 4 }, (_, index) => ({
      title: `Sources ${index}`,
      bullets: ["Source"],
      archetype: "sources" as const,
      generatedSourceAppendix: true,
    }));
    const manualSources = generatedSources.map(({ generatedSourceAppendix: _ignored, ...slide }) => slide);

    expect(
      resolvePresentationDeckLayoutPlan(design, [
        { title: "Source rhythm", bullets: ["Overview"] },
        ...generatedSources,
      ]).map((item) => item.renderer),
    ).toEqual(["hero", "sources", "sources", "sources", "sources"]);
    expect(
      resolvePresentationDeckLayoutPlan(design, [
        { title: "Source rhythm", bullets: ["Overview"] },
        ...manualSources,
      ]).map((item) => item.renderer),
    ).toEqual(["hero", "sources", "sources", "sources-continuation", "sources"]);
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
        objectName: "GoatCitadel supporting visual",
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
    expect(notesText.join("\n")).not.toContain("GoatCitadel design provenance");
    expect(localVisualSvg.join("\n")).not.toContain("<text");
    expect(imageObjects.some((image) => image.objectName === "GoatCitadel accent visual")).toBe(false);
  });

  it("keeps complete bullet text at the body font floor without shrink-to-fit", async () => {
    const textObjects: Array<{ text: unknown; options?: Record<string, unknown> }> = [];
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
          slide.addImage = () => slide;
          slide.addText = (text: unknown, options?: Record<string, unknown>) => {
            textObjects.push({ text, options });
            return slide;
          };
          slide.addNotes = () => slide;
          return slide;
        }

        public async write() {
          return Buffer.from("PKmock");
        }
      },
    }));

    const overlongBullet =
      "Research limitation: accessible search evidence consisted mainly of editorial compilations; no controlled audience test was available in this pass. Joke wording may vary across organizations and publications.";

    const result = await createPresentationPptxWithDiagnostics({
      title: "Sources",
      slides: [{ title: "Sources and limitations", bullets: [overlongBullet] }],
    });

    const bulletTextBox = textObjects.find(
      (item) =>
        Array.isArray(item.text) &&
        item.text.some(
          (run) => typeof run === "object" && run !== null && (run as { text?: string }).text === overlongBullet,
        ),
    );
    expect(bulletTextBox?.options).toMatchObject({ fontSize: 16 });
    expect(bulletTextBox?.options).not.toHaveProperty("fit");
    expect(result.manifest.minimumBodyFontSize).toBe(16);
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

  it("renders semantic tables, charts, clickable citations, clean notes, and a truthful manifest", async () => {
    const textObjects: unknown[] = [];
    const notes: string[] = [];
    const tables: unknown[] = [];
    const charts: unknown[] = [];
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
        public ChartType = { bar: "bar", line: "line" };

        public addSlide() {
          const slide: Record<string, unknown> = {};
          slide.addShape = () => slide;
          slide.addImage = () => slide;
          slide.addText = (text: unknown) => {
            textObjects.push(text);
            return slide;
          };
          slide.addTable = (rows: unknown) => {
            tables.push(rows);
            return slide;
          };
          slide.addChart = (type: unknown, series: unknown) => {
            charts.push({ type, series });
            return slide;
          };
          slide.addNotes = (value: string) => {
            notes.push(value);
            return slide;
          };
          return slide;
        }

        public async write() {
          return Buffer.from("PKmock");
        }
      },
    }));

    const url = "https://example.com/official";
    const sourceId = stablePresentationSourceId(url);
    const result = await createPresentationPptxWithDiagnostics(
      {
        title: "Grounded Deck",
        sources: [{ id: sourceId, title: "Official source", url, publisher: "Example", role: "official" }],
        slides: [
          {
            title: "Finding",
            speakerNotes: "Explain the audience implication.",
            bullets: [{ text: "Official support is active.", claimKind: "fact", sourceIds: [sourceId] }],
          },
          {
            title: "Matrix",
            archetype: "matrix",
            bullets: [],
            table: {
              headers: [{ text: "Game" }, { text: "Fit" }],
              rows: [[{ text: "Example" }, { text: "Strong", sourceIds: [sourceId] }]],
            },
          },
          {
            title: "Signal",
            archetype: "chart",
            bullets: [],
            chart: {
              type: "bar",
              categories: ["Example"],
              series: [{ name: "Signal", values: [1], sourceIds: [sourceId] }],
            },
          },
        ],
      },
      { auditPackage: () => passingPackageAudit() },
    );

    const textRuns = textObjects.flatMap((item) => (Array.isArray(item) ? item : []));
    expect(textRuns).toEqual(
      expect.arrayContaining([expect.objectContaining({ options: expect.objectContaining({ hyperlink: { url } }) })]),
    );
    expect(tables).toHaveLength(1);
    expect(JSON.stringify(tables)).toContain(url);
    expect(charts).toHaveLength(1);
    expect(textObjects).toContain("Series: Signal");
    expect(notes.join("\n")).toContain("Explain the audience implication.");
    expect(notes.join("\n")).not.toMatch(/design provenance|revised prompt|visual source/iu);
    expect(result.manifest).toMatchObject({
      slideCount: 5,
      contentSlideCount: 4,
      sourceCount: 1,
      tableCount: 1,
      chartCount: 1,
      minimumBodyFontSize: 16,
    });
    expect(result.manifest.hyperlinkCount).toBeGreaterThanOrEqual(4);
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
    expect(result.warnings).toEqual([expect.stringContaining("semantic text fallback")]);
    expect(result.buffer.subarray(0, 2).toString("utf8")).toBe("PK");
  });
});

function passingPackageAudit(): PresentationPackageAuditReport {
  return {
    passed: true,
    findings: [],
    observed: {
      slideCount: 0,
      hyperlinkCount: 0,
      uniqueHyperlinkTargetCount: 0,
      tableCount: 0,
      chartCount: 0,
      pictureCount: 0,
      authoredNoteCount: 0,
      layoutCounts: {},
    },
  };
}
