import { describe, expect, it } from "vitest";
import {
  canonicalizePresentationSourceUrl,
  normalizePresentationResearch,
  normalizePresentationSlides,
  normalizePresentationSources,
  preparePresentationSlides,
  stablePresentationSourceId,
  validateResearchPresentation,
  type PresentationSlide,
} from "./presentation-model.js";

describe("presentation rich-content model", () => {
  it("canonicalizes HTTPS sources and remaps caller aliases to server-owned stable ids", () => {
    const canonical = "https://example.com/research?a=1&b=2";
    const normalized = normalizePresentationSources([
      {
        id: "model-source-1",
        title: "Research",
        url: "https://EXAMPLE.com:443/research/?utm_source=chat&b=2&a=1#finding",
        publisher: "Example",
        role: "independent",
      },
    ]);

    expect(normalized.sources).toEqual([
      expect.objectContaining({
        id: stablePresentationSourceId(canonical),
        url: canonical,
        role: "independent",
      }),
    ]);
    expect(normalized.aliases.get("model-source-1")).toBe(stablePresentationSourceId(canonical));
  });

  it("rejects duplicate canonical source ids within a claim before rendering", () => {
    const normalized = normalizePresentationSources([
      {
        id: "official",
        title: "Official evidence",
        url: "https://example.com/official-evidence",
        publisher: "Example",
        role: "official",
      },
    ]);

    expect(() =>
      normalizePresentationSlides(
        [
          {
            title: "Finding",
            bullets: [{ text: "Supported claim", claimKind: "fact", sourceIds: ["official", "official"] }],
          },
        ],
        "Fallback",
        undefined,
        normalized.aliases,
      ),
    ).toThrow(/duplicate canonical source ids/u);
    expect(() =>
      preparePresentationSlides(
        [
          {
            title: "Finding",
            bullets: [{ text: "Supported claim", claimKind: "fact", sourceIds: ["src_same", "src_same"] }],
          },
        ],
        [],
      ),
    ).toThrow(/duplicate canonical source ids/u);
  });

  it("rejects credentialed, non-HTTPS, and visibly truncated source URLs", () => {
    expect(canonicalizePresentationSourceUrl("http://example.com/report")).toBeUndefined();
    expect(canonicalizePresentationSourceUrl("https://user:secret@example.com/report")).toBeUndefined();
    expect(canonicalizePresentationSourceUrl("https://example.com/report…")).toBeUndefined();
  });

  it("preserves complete visible text and paginates narrative bullets deterministically", () => {
    const longText = Array.from({ length: 28 }, (_, index) => `word${index}`).join(" ");
    const authoredBullets = [longText, "Second", "Third", "Fourth", "Fifth", "Sixth"];
    const slides: PresentationSlide[] = [
      {
        title: "Evidence",
        bullets: authoredBullets,
      },
    ];

    const prepared = preparePresentationSlides(slides, []);
    const renderedText = prepared
      .flatMap((slide) => slide.bullets)
      .map((bullet) => (typeof bullet === "string" ? bullet : bullet.text));

    expect(prepared.length).toBeGreaterThan(1);
    expect(prepared[1]?.title).toContain("— Continued");
    expect(renderedText).toEqual(authoredBullets);
    expect(renderedText.join(" ")).not.toContain("...");
  });

  it("rejects an oversized bullet instead of splitting, truncating, or replacing it", () => {
    const oversized = "x".repeat(241);

    expect(() => preparePresentationSlides([{ title: "Evidence", bullets: [oversized] }], [])).toThrow(
      /maximum is 240/u,
    );
  });

  it("applies the 240-character limit to authored text while citations only affect line estimation", () => {
    const authoredText = "x".repeat(218);
    const sourceIds = ["src_one", "src_two", "src_three", "src_four"];

    const prepared = preparePresentationSlides(
      [
        {
          title: "Cited evidence",
          bullets: [{ text: authoredText, claimKind: "fact", sourceIds }],
        },
      ],
      [],
    );

    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.bullets).toEqual([{ text: authoredText, claimKind: "fact", sourceIds }]);
  });

  it("rejects table cells and source URLs that cannot fit at their typography floors", () => {
    const longCell = "inventory-risk ".repeat(90).trim();
    expect(() =>
      preparePresentationSlides(
        [
          {
            title: "Matrix",
            bullets: [],
            table: {
              headers: [{ text: "Game" }, { text: "Retail fit" }],
              rows: [[{ text: "Example" }, { text: longCell }]],
            },
          },
        ],
        [],
      ),
    ).toThrow(/table cell cannot fit/u);

    const longUrl = `https://example.com/${"unbreakable".repeat(50)}`;
    const source = {
      id: stablePresentationSourceId(longUrl),
      title: "Long URL evidence",
      url: longUrl,
      publisher: "Example",
      role: "official" as const,
    };
    expect(() => preparePresentationSlides([{ title: "Finding", bullets: [] }], [source])).toThrow(/source URL/u);
  });

  it("preserves a long but wrappable source URL through source-specific pagination", () => {
    const url = `https://example.com/${"segment/".repeat(38)}evidence`;
    const source = {
      id: stablePresentationSourceId(url),
      title: "Detailed official evidence",
      url,
      publisher: "Example",
      role: "official" as const,
    };

    const prepared = preparePresentationSlides([{ title: "Finding", bullets: [] }], [source]);
    const sourceSlide = prepared.find((slide) => slide.generatedSourceAppendix);

    expect(sourceSlide?.bullets).toEqual([
      {
        text: `Example: Detailed official evidence — ${url}`,
        claimKind: "fact",
        sourceIds: [source.id],
      },
    ]);
  });

  it("paginates matrices without losing rows or charts and generates complete source slides", () => {
    const normalized = normalizePresentationSources([
      {
        id: "official",
        title: "Official game page",
        url: "https://example.com/game",
        publisher: "Example Games",
        role: "official",
      },
    ]);
    const inputRows = Array.from({ length: 9 }, (_, index) => [
      `Game ${index + 1}`,
      { text: "Strong", sourceIds: ["official"] },
    ]);
    const slides = normalizePresentationSlides(
      [
        {
          title: "Matrix",
          archetype: "matrix",
          table: {
            headers: ["Game", "Fit"],
            rows: inputRows,
          },
        },
        {
          title: "Signal",
          archetype: "chart",
          chart: {
            type: "bar",
            categories: ["Example"],
            series: [{ name: "Retail signal", values: [7], sourceIds: ["official"] }],
          },
        },
      ],
      "Fallback",
      undefined,
      normalized.aliases,
    );

    const prepared = preparePresentationSlides(slides, normalized.sources);

    const tableSlides = prepared.filter((slide) => slide.table);
    expect(tableSlides.length).toBeGreaterThan(1);
    expect(tableSlides[1]?.title).toContain("— Continued");
    expect(tableSlides.flatMap((slide) => slide.table?.rows ?? []).map((row) => row.map((cell) => cell.text))).toEqual(
      inputRows.map((row) => row.map((cell) => (typeof cell === "string" ? cell : cell.text))),
    );
    expect(prepared.find((slide) => slide.chart)?.chart).toEqual(slides.find((slide) => slide.chart)?.chart);
    const sourceSlides = prepared.filter((slide) => slide.generatedSourceAppendix);
    expect(sourceSlides).toHaveLength(1);
    expect(sourceSlides.flatMap((slide) => slide.bullets)).toEqual([
      {
        text: "Example Games: Official game page — https://example.com/game",
        claimKind: "fact",
        sourceIds: [normalized.sources[0]?.id],
      },
    ]);
  });

  it("fits realistic cited four-column matrix content at three rows per page", () => {
    const realisticCell = (prefix: string, length: number) =>
      `${prefix} ${"player fit, retailer demand, organized play, and inventory trade-offs remain explicit. ".repeat(3)}`.slice(
        0,
        length,
      );
    const rows = Array.from({ length: 11 }, (_, index) => [
      { text: `Game ${index + 1}` },
      { text: realisticCell("Player benefit:", 117 + (index % 3) * 6), sourceIds: ["src_evidence"] },
      { text: realisticCell("Retail profile:", 127 + (index % 2) * 6), sourceIds: ["src_evidence"] },
      { text: realisticCell("Major trade-off:", 139), sourceIds: ["src_evidence"] },
    ]);

    const prepared = preparePresentationSlides(
      [
        {
          title: "Physical CCG comparison",
          bullets: [],
          archetype: "matrix",
          table: {
            headers: [
              { text: "Game" },
              { text: "Player benefit" },
              { text: "Retail profile" },
              { text: "Major trade-off" },
            ],
            rows,
          },
        },
      ],
      [],
    );
    const matrixPages = prepared.filter((slide) => slide.table);

    expect(matrixPages.map((slide) => slide.table?.rows.length)).toEqual([3, 3, 3, 2]);
    expect(matrixPages.flatMap((slide) => slide.table?.rows ?? [])).toEqual(rows);
  });

  it("requires complete research metadata and citations", () => {
    const sources = normalizePresentationSources([
      {
        id: "official",
        title: "Official game page",
        url: "https://example.com/game",
        publisher: "Example Games",
        role: "official",
      },
    ]);
    const research = normalizePresentationResearch({
      asOfDate: "2026-08-06",
      geography: "North America",
      physicalDigitalBoundary: "Physical core; digital appendix",
      inclusionCriteria: ["Retail availability"],
      exclusions: ["Digital-only games"],
      methodology: ["Official and independent sources"],
      limitations: ["No paid market dataset"],
      competitors: ["Example Game"],
      comparisonCriteria: ["Player fit", "Retail fit"],
    });
    const cited = normalizePresentationSlides(
      [
        {
          title: "Finding",
          bullets: [{ text: "The game has organized play.", claimKind: "fact", sourceIds: ["official"] }],
        },
      ],
      "Fallback",
      undefined,
      sources.aliases,
    );

    expect(() => validateResearchPresentation(research, sources.sources, cited)).not.toThrow();
    expect(() =>
      validateResearchPresentation(research, sources.sources, [{ title: "Finding", bullets: ["Uncited"] }]),
    ).toThrow(/structured citations/u);
  });
});
