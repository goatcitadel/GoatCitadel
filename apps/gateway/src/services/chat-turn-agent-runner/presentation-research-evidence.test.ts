import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  buildPresentationEvidencePacket,
  canonicalizePresentationSourceUrl,
  groundResearchPresentationArgs,
  presentationSourceId,
} from "./presentation-research-evidence.js";

const CCG_REQUEST =
  "Can you please do some market research on CCGs and what makes each one unique and better than the competition? Please put it into a powerpoint deck.";

const CCG_SOURCES = [
  ["magic", "Magic: The Gathering products", "https://magic.wizards.com/en/products", "official"],
  ["pokemon", "Pokémon Trading Card Game", "https://www.pokemon.com/us/pokemon-tcg/", "official"],
  ["yugioh", "Yu-Gi-Oh! Card Game", "https://www.yugioh-card.com/en/", "official"],
  ["one-piece", "One Piece Card Game", "https://en.onepiece-cardgame.com/", "official"],
  ["lorcana", "Disney Lorcana", "https://www.disneylorcana.com/en-US/", "official"],
  ["fab", "Flesh and Blood TCG", "https://fabtcg.com/", "official"],
  ["swu", "Star Wars: Unlimited", "https://starwarsunlimited.com/", "official"],
  ["riftbound", "Riftbound TCG", "https://riftbound.leagueoflegends.com/", "official"],
  ["gundam", "Gundam Card Game", "https://www.gundam-gcg.com/en/", "official"],
  ["tcgplayer", "CCG marketplace signals", "https://www.tcgplayer.com/content/ccg-market", "marketplace"],
  ["icv2", "North American hobby market", "https://icv2.com/articles/markets/view/ccg-market", "independent"],
  ["retailer", "Retail inventory considerations", "https://starcitygames.com/articles/ccg-retail", "retailer"],
] as const;

describe("presentation research evidence", () => {
  it("canonicalizes HTTPS URLs and derives stable source ids", () => {
    const canonical = canonicalizePresentationSourceUrl("https://Example.com/path/?utm_source=test&b=2&a=1#section");
    expect(canonical).toBe("https://example.com/path?a=1&b=2");
    expect(presentationSourceId(canonical!)).toMatch(/^src_[a-f0-9]{12}$/u);
    expect(presentationSourceId(canonical!)).toBe(presentationSourceId("https://example.com/path?a=1&b=2"));
    expect(canonicalizePresentationSourceUrl("http://example.com/source")).toBeUndefined();
    expect(canonicalizePresentationSourceUrl("https://user:secret@example.com/source")).toBeUndefined();
    expect(canonicalizePresentationSourceUrl("https://example.com/source...")).toBeUndefined();
  });

  it("builds a server-owned packet only from successful canonical web evidence", () => {
    const packet = buildPresentationEvidencePacket([
      browserSearchRun([
        {
          title: "Official source",
          url: "https://example.com/research?utm_campaign=x",
          snippet: "Grounded evidence.",
        },
      ]),
      {
        ...browserSearchRun([{ title: "Ignored", url: "https://ignored.example/source" }]),
        toolRunId: "failed-search",
        status: "failed",
      },
      {
        toolRunId: "navigate-run",
        turnId: "turn-research",
        sessionId: "session-research",
        toolName: "browser.navigate",
        status: "executed",
        args: { url: "https://publisher.example/article" },
        result: {
          url: "https://publisher.example/article#details",
          title: "Opened publisher article",
          content: "Direct publisher evidence.",
        },
        startedAt: "2026-08-06T10:00:02.000Z",
        finishedAt: "2026-08-06T10:00:03.000Z",
      },
    ]);

    expect(packet).toEqual([
      expect.objectContaining({
        id: presentationSourceId("https://example.com/research"),
        url: "https://example.com/research",
        title: "Official source",
        domain: "example.com",
        snippet: "Grounded evidence.",
        toolRunId: "search-run",
        toolName: "browser.search",
        query: "CCG evidence",
        retrievedAt: "2026-08-06T10:00:01.000Z",
      }),
      expect.objectContaining({
        url: "https://publisher.example/article",
        title: "Opened publisher article",
        snippet: "Direct publisher evidence.",
        toolRunId: "navigate-run",
        toolName: "browser.navigate",
        retrievedAt: "2026-08-06T10:00:03.000Z",
      }),
    ]);
  });

  it("rejects the exact CCG prompt when the model submits a generic uncited deck", () => {
    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: [browserSearchRun(CCG_SOURCES.slice(0, 2).map(sourceResult))],
      args: {
        title: "Competitive CCG Landscape",
        slides: [
          {
            title: "Category Differentiators",
            bullets: ["Rules accessibility and collection depth shape each game's position."],
          },
          {
            title: "Competitive Strengths",
            bullets: ["Distinct mechanics create different reasons to choose each game."],
          },
          {
            title: "Market Positioning",
            bullets: ["Player communities and retail support reinforce differentiation."],
          },
        ],
      },
    });

    expect(result.report).toMatchObject({ required: true, ccgBenchmark: true, passed: false });
    expect(result.report.findings.join(" ")).toMatch(
      /structured research metadata|structured sources registry|12 structured content slides|uncited legacy string bullet/i,
    );
  });

  it("canonicalizes aliases and admits a fully structured CCG research deck", () => {
    const args = buildStructuredCcgArgs();
    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report).toMatchObject({
      required: true,
      ccgBenchmark: true,
      passed: true,
      evidenceSourceCount: 12,
      declaredSourceCount: 12,
      matchedSourceCount: 12,
      domainCount: 12,
    });
    const sources = result.args.sources as Array<Record<string, unknown>>;
    expect(sources[0]).toMatchObject({
      id: presentationSourceId("https://magic.wizards.com/en/products"),
      url: "https://magic.wizards.com/en/products",
      role: "official",
      toolRunId: "search-run",
    });
    const slides = result.args.slides as Array<Record<string, unknown>>;
    const firstBullet = (slides[0]?.bullets as Array<Record<string, unknown>>)[0];
    expect(firstBullet?.sourceIds).toEqual([presentationSourceId("https://magic.wizards.com/en/products")]);
    const matrix = slides.find((slide) => slide.archetype === "matrix");
    const firstMatrixCell = ((matrix?.table as { rows: Array<Array<Record<string, unknown>>> }).rows[0] ?? [])[1];
    expect(firstMatrixCell?.sourceIds).toEqual([presentationSourceId("https://magic.wizards.com/en/products")]);
  });

  it("rejects fabricated source URLs and dangling claim citations", () => {
    const args = buildStructuredCcgArgs();
    (args.sources as Array<Record<string, unknown>>)[0] = {
      id: "magic",
      title: "Invented Magic source",
      url: "https://invented.example/not-observed",
      publisher: "Invented",
      role: "official",
    };
    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(
      /not present in canonical tool evidence|not backed by the declared canonical sources/i,
    );
  });

  it("rejects numeric or universal claims disguised as uncited recommendations", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    slides[0] = {
      ...slides[0],
      bullets: [
        ...((slides[0]?.bullets as Array<Record<string, unknown>>) ?? []),
        {
          text: "Magic has the largest market with 100 documented products.",
          claimKind: "recommendation",
          sourceIds: [],
        },
      ],
    };
    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(/must name the audience|not clearly phrased|numeric claim/i);
  });

  it("uses retained market-source snippets when checking cross-competitor coverage", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    slides[0] = {
      ...slides[0],
      bullets: [
        ...((slides[0]?.bullets as Array<Record<string, unknown>>) ?? []),
        {
          text: "Best for retailers seeking marketplace-demand evidence across the compared games is a directional comparison, not total market share.",
          claimKind: "analysis",
          sourceIds: ["tcgplayer"],
        },
      ],
    };
    const crossBrandSnippet = CCG_SOURCES.slice(0, 9)
      .map(([, title]) => title)
      .join(", ");
    const results = CCG_SOURCES.map((source) => ({
      ...sourceResult(source),
      ...(source[0] === "tcgplayer" ? { snippet: crossBrandSnippet } : {}),
    }));
    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(results),
      args,
    });

    expect(result.report.findings).toEqual([]);
    expect(result.report).toMatchObject({ passed: true, materialClaimCount: 29, citedMaterialClaimCount: 29 });
  });

  it("does not let a model relabel a generic market source as official competitor coverage", () => {
    const args = buildStructuredCcgArgs();
    const sources = args.sources as Array<Record<string, unknown>>;
    const magic = sources.find((source) => source.id === "magic");
    const marketplace = sources.find((source) => source.id === "tcgplayer");
    expect(magic).toBeDefined();
    expect(marketplace).toBeDefined();
    magic!.role = "other";
    marketplace!.role = "official";
    const crossBrandSnippet = CCG_SOURCES.slice(0, 9)
      .map(([, title]) => title)
      .join(", ");
    const evidence = CCG_SOURCES.map((source) =>
      source[0] === "tcgplayer" ? sourceResult(source, { snippet: crossBrandSnippet }) : sourceResult(source),
    );

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(evidence),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings).toContain(
      "The CCG benchmark lacks an official canonical source for Magic: The Gathering.",
    );
  });

  it("does not let a brand-named third-party domain impersonate an authoritative official source", () => {
    const args = buildStructuredCcgArgs();
    const sources = args.sources as Array<Record<string, unknown>>;
    const magic = sources.find((source) => source.id === "magic");
    expect(magic).toBeDefined();
    magic!.role = "other";
    sources.push({
      id: "magic-spoof",
      title: "Magic deck prices",
      url: "https://www.mtggoldfish.com/prices/paper/standard",
      publisher: "MTGGoldfish",
      role: "official",
    });
    const results = [
      ...CCG_SOURCES.map(sourceResult),
      {
        title: "Magic deck prices",
        url: "https://www.mtggoldfish.com/prices/paper/standard",
        snippet: "Third-party Magic deck and card price tracking.",
        publishedAt: "2026-07-01",
      },
    ];

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(results),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings).toContain(
      "The CCG benchmark lacks an official canonical source for Magic: The Gathering.",
    );
  });

  it("does not count declared but unused independent sources as category evidence", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    const positioning = slides.find((slide) => slide.title === "Qualitative positioning map");
    expect(positioning).toBeDefined();
    positioning!.bullets = (positioning!.bullets as Array<Record<string, unknown>>).map((bullet) => ({
      ...bullet,
      sourceIds: ["magic", "pokemon"],
    }));
    const table = positioning!.table as { rows: Array<Array<Record<string, unknown>>> };
    table.rows = table.rows.map((row) =>
      row.map((cell) => ({
        ...cell,
        sourceIds: ["magic", "pokemon"],
      })),
    );

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(
      /category-level (?:claim|table cell).*must cite at least one canonical independent/i,
    );
    expect(result.report.findings).toContain(
      "The CCG benchmark requires at least two canonical independent sources to be cited by category-level analytical or comparative conclusions; 0 were used.",
    );
  });

  it("maps a full Yu-Gi-Oh product name to the fixed authoritative brand alias", () => {
    const args = buildStructuredCcgArgs();
    const research = args.research as { competitors: string[] };
    research.competitors = research.competitors.map((competitor) =>
      competitor === "Yu-Gi-Oh!" ? "Yu-Gi-Oh! Trading Card Game" : competitor,
    );
    const slides = args.slides as Array<Record<string, unknown>>;
    const matrix = slides.find((slide) => slide.archetype === "matrix")?.table as {
      rows: Array<Array<{ text: string; sourceIds: string[] }>>;
    };
    matrix.rows = matrix.rows.map((row) =>
      row[0]?.sourceIds.includes("yugioh")
        ? [{ ...row[0], text: "Yu-Gi-Oh! Trading Card Game" }, ...row.slice(1)]
        : row,
    );

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.findings).not.toContain(
      "The CCG benchmark lacks an official canonical source for Yu-Gi-Oh! Trading Card Game.",
    );
    expect(result.report.findings).toEqual([]);
    expect(result.report.passed).toBe(true);
  });

  it("classifies a context-dependent research follow-up as a structured research deck", () => {
    const userContent = "Put those findings into a PowerPoint.";
    const result = groundResearchPresentationArgs({
      userContent,
      historyMessages: [
        { role: "user", content: "Research competing note-taking apps and compare their feature fit." },
        { role: "assistant", content: "I found official feature documentation and an independent review." },
        { role: "user", content: userContent },
      ],
      priorToolRuns: [
        browserSearchRun([sourceResult(GENERAL_RESEARCH_SOURCES[0])], {
          query: "note taking app official feature documentation",
        }),
        browserSearchRun([sourceResult(GENERAL_RESEARCH_SOURCES[1])], {
          query: "note taking app independent adoption signals",
          toolRunId: "search-run-2",
        }),
      ],
      args: {
        title: "Note-taking app findings",
        slides: [{ title: "Findings", bullets: ["A generic uncited finding."] }],
      },
    });

    expect(result.report.required).toBe(true);
    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(/structured research metadata|structured sources registry/i);

    const ordinary = groundResearchPresentationArgs({
      userContent: "Put that story into a PowerPoint.",
      historyMessages: [
        { role: "user", content: "Write a short fictional story about a lighthouse." },
        { role: "assistant", content: "Once there was a lighthouse keeper." },
      ],
      args: { title: "The Lighthouse", slides: [{ title: "Story", bullets: ["A fictional scene."] }] },
    });
    expect(ordinary.report.required).toBe(false);

    const assistantOnlyResearchLanguage = groundResearchPresentationArgs({
      userContent: "Put those findings into a PowerPoint.",
      historyMessages: [
        { role: "user", content: "Tell me about a few note-taking apps." },
        { role: "assistant", content: "I researched the competitors and compared their features." },
      ],
      args: { title: "Note-taking apps", slides: [{ title: "Options", bullets: ["Several apps are available."] }] },
    });
    expect(assistantOnlyResearchLanguage.report.required).toBe(false);
  });

  it("requires multiple materially distinct successful searches for direct research decks", () => {
    const args = buildGeneralResearchArgs();
    const oneSearch = groundResearchPresentationArgs({
      userContent: "Research competing note-taking apps and put the comparison in a PowerPoint.",
      priorToolRuns: [
        browserSearchRun(GENERAL_RESEARCH_SOURCES.map(sourceResult), {
          query: "note taking app comparison evidence",
        }),
        browserSearchRun([{ title: "No canonical result" }], {
          query: "note taking app independent adoption signals",
          toolRunId: "search-run-without-usable-evidence",
        }),
      ],
      args,
    });

    expect(oneSearch.report.passed).toBe(false);
    expect(oneSearch.report.findings.join(" ")).toMatch(
      /at least 2 materially distinct successful browser\.search query families/i,
    );

    const twoSearches = groundResearchPresentationArgs({
      userContent: "Research competing note-taking apps and put the comparison in a PowerPoint.",
      priorToolRuns: [
        browserSearchRun([sourceResult(GENERAL_RESEARCH_SOURCES[0])], {
          query: "note taking app official feature documentation",
        }),
        browserSearchRun([sourceResult(GENERAL_RESEARCH_SOURCES[1])], {
          query: "note taking app independent retailer adoption signals",
          toolRunId: "search-run-2",
        }),
      ],
      args,
    });

    expect(twoSearches.report.findings).toEqual([]);
    expect(twoSearches.report.passed).toBe(true);
  });

  it("does not let one broad or repeated equivalent search satisfy the CCG benchmark", () => {
    const results = CCG_SOURCES.map(sourceResult);
    const repeatedSearches = [
      "CCG market retail official evidence",
      "official retail CCG market evidence",
      "research official retail CCG market evidence",
      "CCGs official retail market evidence",
    ].map((query, index) =>
      browserSearchRun(results, {
        query,
        toolRunId: `search-run-${index + 1}`,
      }),
    );
    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: repeatedSearches,
      args: buildStructuredCcgArgs(),
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(
      /at least 4 materially distinct successful browser\.search query families; 1 were available/i,
    );
  });

  it.each(["Widest", "Broadest"])("checks %s comparative wording inside structured table cells", (comparative) => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    const matrix = slides.find((slide) => slide.archetype === "matrix");
    const table = matrix?.table as { headers: unknown[]; rows: Array<Array<Record<string, unknown>>> };
    table.headers[1] = "Assessment";
    table.rows[0]![1] = {
      text: `${comparative} player fit among the compared games`,
      sourceIds: ["magic"],
    };

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(/comparative table cell.*lacks evidence covering/i);
  });

  it("rejects alias-covered ranking evidence that does not support the named criterion", () => {
    const args = buildStructuredCcgArgs();
    const matrix = (args.slides as Array<Record<string, unknown>>).find((slide) => slide.archetype === "matrix");
    const table = matrix?.table as { rows: Array<Array<Record<string, unknown>>> };
    table.rows[0]![1] = {
      text: "Deepest strategic depth among the compared games",
      sourceIds: CCG_SOURCES.slice(0, 9).map(([id]) => id),
    };

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(
      /comparative table cell.*lacks evidence covering the named criterion/i,
    );
  });

  it("rejects a ranking claim that never names a declared comparison criterion", () => {
    const args = buildStructuredCcgArgs();
    const matrix = (args.slides as Array<Record<string, unknown>>).find((slide) => slide.archetype === "matrix");
    const table = matrix?.table as { headers: unknown[]; rows: Array<Array<Record<string, unknown>>> };
    table.headers[1] = "Assessment";
    table.rows[0]![1] = {
      text: "Ranked #1 among the compared games",
      sourceIds: ["tcgplayer"],
    };

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(/comparative table cell.*does not name its comparison criterion/i);
  });

  it("rejects uncited numeric or analytical slide titles and plain factual table headers", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    slides[0] = {
      ...slides[0],
      title: "Magic drives 25% of retail growth",
    };
    const matrix = slides.find((slide) => slide.archetype === "matrix");
    const table = matrix?.table as { headers: unknown[] };
    table.headers[0] = "Retail demand increased";

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(/numeric slide title.*direct published\/dated canonical source/i);
    expect(result.report.findings.join(" ")).toMatch(/evidence-bearing slide title.*neutral title.*cited rich bullet/i);
    expect(result.report.findings.join(" ")).toMatch(
      /table header.*must use a structured cell with canonical sourceIds/i,
    );
  });

  it("treats an ISO as-of date in a neutral slide title as scope metadata", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    const guideIndex = slides.findIndex((slide) => slide.title === "Player fit guide");
    slides[guideIndex] = {
      ...slides[guideIndex],
      title: "Current category and retail signals as of 2026-08-06",
    };

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(true);
    expect(result.report.findings).toEqual([]);
  });

  it("applies numeric-date and cross-competitor rules to structured table headers", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    const matrix = slides.find((slide) => slide.archetype === "matrix");
    const table = matrix?.table as { headers: unknown[] };
    table.headers = [
      { text: "25% retail growth", sourceIds: ["magic"] },
      { text: "Widest player fit by retailer fit", sourceIds: ["magic"] },
    ];
    const evidence = CCG_SOURCES.map((source) =>
      source[0] === "magic" ? sourceResult(source, { publishedAt: undefined }) : sourceResult(source),
    );

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(evidence),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(/numeric table header.*direct published\/dated canonical source/i);
    expect(result.report.findings.join(" ")).toMatch(/comparative table header.*lacks evidence covering/i);
  });

  it("requires official evidence and matrix coverage for every declared CCG competitor", () => {
    const digimon = ["digimon", "Digimon Card Game", "https://world.digimoncard.com/", "official"] as const;
    const args = buildStructuredCcgArgs();
    const research = args.research as { competitors: string[] };
    research.competitors = [...research.competitors, "Digimon Card Game"];
    const missingOfficialResult = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(missingOfficialResult.report.passed).toBe(false);
    expect(missingOfficialResult.report.findings).toContain(
      "The CCG benchmark lacks an official canonical source for Digimon Card Game.",
    );

    (args.sources as Array<Record<string, unknown>>).push({
      id: digimon[0],
      title: digimon[1],
      url: digimon[2],
      publisher: new URL(digimon[2]).hostname,
      role: digimon[3],
    });
    const slides = args.slides as Array<Record<string, unknown>>;
    const matrix = slides.find((slide) => slide.archetype === "matrix");
    const table = matrix?.table as { rows: Array<Array<Record<string, unknown>>> };
    table.rows[0]![0] = {
      ...table.rows[0]![0],
      sourceIds: ["magic", digimon[0]],
    };
    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns([...CCG_SOURCES.map(sourceResult), sourceResult(digimon)]),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings).toContain("The structured comparison matrix is missing Digimon Card Game.");

    table.rows = [
      ...table.rows,
      [
        { text: digimon[1], sourceIds: [digimon[0]] },
        { text: "Documented differentiated fit", sourceIds: [digimon[0]] },
      ],
    ];
    slides.push(buildCcgProfileSlide(digimon[0], digimon[1]));
    const completeResult = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns([...CCG_SOURCES.map(sourceResult), sourceResult(digimon)]),
      args,
    });

    expect(completeResult.report.findings).toEqual([]);
    expect(completeResult.report.passed).toBe(true);
  });

  it("rejects numeric claims backed only by retrieval time", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    slides[0] = {
      ...slides[0],
      bullets: [
        ...((slides[0]?.bullets as Array<Record<string, unknown>>) ?? []),
        {
          text: "Magic lists 100 products.",
          claimKind: "fact",
          sourceIds: ["magic"],
        },
      ],
    };
    const results = CCG_SOURCES.map((source) =>
      source[0] === "magic" ? sourceResult(source, { publishedAt: undefined }) : sourceResult(source),
    );
    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(results),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(
      /numeric claim.*lacks a direct published\/dated canonical source/i,
    );
  });

  it("allows an explicitly dated retrieval observation without a publication date", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    slides[0] = {
      ...slides[0],
      bullets: [
        ...((slides[0]?.bullets as Array<Record<string, unknown>>) ?? []),
        {
          text: "As of 2026-08-06, the official Magic page displayed 100 products.",
          claimKind: "fact",
          sourceIds: ["magic"],
        },
      ],
    };
    const results = CCG_SOURCES.map((source) =>
      source[0] === "magic" ? sourceResult(source, { publishedAt: undefined }) : sourceResult(source),
    );
    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(results),
      args,
    });

    expect(result.report.findings).toEqual([]);
    expect(result.report.passed).toBe(true);
  });

  it("rejects dated numeric evidence that matches the game but not the claimed metric", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    slides[0] = {
      ...slides[0],
      bullets: [
        ...((slides[0]?.bullets as Array<Record<string, unknown>>) ?? []),
        {
          text: "Magic revenue grew 25%.",
          claimKind: "fact",
          sourceIds: ["magic"],
        },
      ],
    };
    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(
      /numeric claim.*lacks dated canonical evidence.*directly matches the claimed subject and metric/i,
    );
  });

  it("requires every declared game to cover every production benchmark field", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    const magicProfile = slides.find((slide) => String(slide.title).startsWith("Magic:"));
    const bullets = magicProfile?.bullets as Array<Record<string, unknown>>;
    bullets[1] = {
      ...bullets[1],
      text: "IP/collectibility appeal: documented brand proposition. Format/organized play: documented support.",
    };

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /competitor Magic: The Gathering.*dated entry-product and ongoing cost, or explicit not measured/i,
        ),
      ]),
    );
  });

  it("does not accept an unlabeled competitor-wide keyword bag as equal-field coverage", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    const magicProfile = slides.find((slide) => String(slide.title).startsWith("Magic:"));
    magicProfile!.bullets = [
      {
        text: "Magic mentions mechanics, benefit, learning, depth, cost, IP, formats, organized play, local, digital, retail, community, SKU, liquidity, inventory, fit, and trade-off.",
        claimKind: "analysis",
        sourceIds: ["magic"],
      },
    ];

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(
      /competitor Magic: The Gathering is missing required field coverage for:/i,
    );
  });

  it("requires a distinct matrix row for each declared competitor", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    const matrix = slides.find((slide) => slide.archetype === "matrix");
    const table = matrix?.table as { rows: unknown[][] };
    const competitors = (args.research as { competitors: string[] }).competitors;
    table.rows = [
      [
        { text: competitors.join(", "), sourceIds: CCG_SOURCES.slice(0, 9).map(([id]) => id) },
        { text: "Not measured", sourceIds: CCG_SOURCES.slice(0, 9).map(([id]) => id) },
      ],
    ];

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings.join(" ")).toMatch(/structured comparison matrix is missing Magic/i);
  });

  it("requires an analytical chart or qualitative positioning structure beyond the matrix", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    const positioningIndex = slides.findIndex((slide) => slide.title === "Qualitative positioning map");
    slides[positioningIndex] = {
      title: "Additional interpretation",
      archetype: "narrative",
      bullets: [
        {
          text: "Independent evidence provides additional directional interpretation.",
          claimKind: "analysis",
          sourceIds: ["tcgplayer", "icv2"],
        },
      ],
    };

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings).toContain(
      "The CCG benchmark requires at least one analytical visual beyond the comparison matrix: a structured chart or qualitative positioning structure.",
    );
  });

  it("does not count an empty chart shell as the required analytical visual", () => {
    const args = buildStructuredCcgArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    const positioningIndex = slides.findIndex((slide) => slide.title === "Qualitative positioning map");
    slides[positioningIndex] = {
      title: "Empty analytical chart",
      archetype: "chart",
      bullets: [],
      chart: { type: "bar", categories: [], series: [] },
    };

    const result = groundResearchPresentationArgs({
      userContent: CCG_REQUEST,
      priorToolRuns: ccgSearchRuns(),
      args,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.findings).toContain(
      "The CCG benchmark requires at least one analytical visual beyond the comparison matrix: a structured chart or qualitative positioning structure.",
    );
  });
});

const GENERAL_RESEARCH_SOURCES = [
  ["official-notes", "Official note-taking app documentation", "https://notes.example.com/features", "official"],
  ["independent-notes", "Independent note-taking app review", "https://reviews.example.org/note-apps", "independent"],
] as const;

function buildStructuredCcgArgs(): Record<string, unknown> {
  const competitors = [
    "Magic: The Gathering",
    "Pokémon",
    "Yu-Gi-Oh!",
    "One Piece",
    "Disney Lorcana",
    "Flesh and Blood",
    "Star Wars: Unlimited",
    "Riftbound",
    "Gundam",
  ];
  const profileSlides = CCG_SOURCES.slice(0, 9).map(([id, title]) => buildCcgProfileSlide(id, title));
  const matrixRows = CCG_SOURCES.slice(0, 9).map(([id, title]) => [
    { text: title, sourceIds: [id] },
    { text: "Documented differentiated fit", sourceIds: [id] },
  ]);
  return {
    path: "./workspace/goatcitadel_out/ccg-competitive-landscape-v2.pptx",
    title: "CCG Competitive Landscape 2026: Best Fits for Players and Retailers",
    research: {
      asOfDate: "2026-08-06",
      geography: "North America with global scale context",
      physicalDigitalBoundary: "Physical CCGs in the core comparison; digital clients in an adjacent appendix",
      inclusionCriteria: ["Active North American retail distribution and organized play"],
      exclusions: ["Digital-only games are separated from the physical comparison"],
      methodology: ["Compare every core physical game with the same player and retailer rubric"],
      limitations: ["Public sources do not expose directly comparable revenue for every title"],
      competitors,
      comparisonCriteria: [
        "Signature mechanics and resulting player benefit",
        "Learning curve and strategic depth",
        "Dated entry-product and ongoing cost, or explicit not measured",
        "IP and collectibility appeal",
        "Format and organized-play support",
        "Local-play and digital access",
        "Retail demand and community-building potential",
        "Release or SKU burden, singles liquidity, and inventory risk",
        "Best-fit player or store profile and major trade-off",
      ],
    },
    sources: CCG_SOURCES.map(([id, title, url, role]) => ({
      id,
      title,
      url,
      publisher: new URL(url).hostname,
      role,
    })),
    slides: [
      ...profileSlides,
      {
        title: "Physical CCG comparison matrix",
        archetype: "matrix",
        bullets: [],
        table: {
          headers: ["Game", "Differentiated fit"],
          rows: matrixRows,
        },
      },
      {
        title: "Qualitative positioning map",
        archetype: "comparison",
        bullets: [
          {
            text: "The positioning spectrum separates documented ecosystem breadth from the amount of local validation still required.",
            claimKind: "analysis",
            sourceIds: ["tcgplayer", "icv2", "retailer"],
          },
        ],
        table: {
          headers: ["Positioning axis", "Qualitative interpretation"],
          rows: [
            [
              { text: "Established ecosystem", sourceIds: ["tcgplayer", "icv2"] },
              { text: "Broader documented retail and play signals", sourceIds: ["tcgplayer", "icv2"] },
            ],
            [
              { text: "Local validation needed", sourceIds: ["retailer"] },
              { text: "Test community depth before expanding inventory", sourceIds: ["retailer"] },
            ],
          ],
        },
      },
      {
        title: "Player fit guide",
        archetype: "comparison",
        bullets: [
          {
            text: "Recommendation: Best for each player need depends on learning curve, organized play, collectibility, and local availability.",
            claimKind: "recommendation",
            sourceIds: [],
          },
        ],
      },
    ],
  };
}

function buildCcgProfileSlide(id: string, title: string): Record<string, unknown> {
  return {
    title: `${title} fit`,
    archetype: "narrative",
    bullets: [
      {
        text: `${title} mechanics/player benefit: documented gameplay creates a distinct player experience. Learning curve/strategic depth: documented rules support a qualitative fit.`,
        claimKind: "fact",
        sourceIds: [id],
      },
      {
        text: "Entry-product and ongoing cost: not measured comparably. IP/collectibility appeal: documented brand proposition. Format/organized play: documented support.",
        claimKind: "analysis",
        sourceIds: [id],
      },
      {
        text: "Local play/digital access: reviewed separately. Retail demand/community building: not measured. Release/SKU burden, singles liquidity, and inventory risk: not measured.",
        claimKind: "analysis",
        sourceIds: [id],
      },
      {
        text: `Recommendation: Best fit for players or retailers aligned with ${title}; trade-off: verify local demand and community depth.`,
        claimKind: "recommendation",
        sourceIds: [],
      },
    ],
  };
}

function buildGeneralResearchArgs(): Record<string, unknown> {
  return {
    title: "Note-taking app comparison",
    research: {
      asOfDate: "2026-08-06",
      geography: "North America",
      physicalDigitalBoundary: "Digital applications only",
      inclusionCriteria: ["Actively supported note-taking applications"],
      exclusions: [],
      methodology: ["Compare official features with independent adoption evidence"],
      limitations: ["Public evidence does not expose directly comparable active-user counts"],
      competitors: ["Official Notes", "Independent Notes"],
      comparisonCriteria: ["feature fit"],
    },
    sources: GENERAL_RESEARCH_SOURCES.map(([id, title, url, role]) => ({
      id,
      title,
      url,
      publisher: new URL(url).hostname,
      role,
    })),
    slides: [
      {
        title: "Feature evidence",
        archetype: "comparison",
        bullets: [
          {
            text: "Official and independent evidence document different feature-fit considerations.",
            claimKind: "analysis",
            sourceIds: ["official-notes", "independent-notes"],
          },
        ],
      },
    ],
  };
}

type SourceFixture = readonly [id: string, title: string, url: string, role: string];

function sourceResult(source: SourceFixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const [, title, url] = source;
  return {
    title,
    url,
    snippet: `${title} official or market evidence.`,
    publishedAt: "2026-07-01",
    ...overrides,
  };
}

function ccgSearchRuns(results: Array<Record<string, unknown>> = CCG_SOURCES.map(sourceResult)): ChatToolRunRecord[] {
  const groups = [
    {
      query: "Magic Pokemon Yu-Gi-Oh official rules products",
      results: results.slice(0, 3),
    },
    {
      query: "One Piece Lorcana Flesh and Blood organized play",
      results: results.slice(3, 6),
    },
    {
      query: "Star Wars Unlimited Riftbound Gundam official support",
      results: results.slice(6, 9),
    },
    {
      query: "North America CCG marketplace retail signals",
      results: results.slice(9),
    },
  ];
  return groups.map((group, index) =>
    browserSearchRun(group.results, {
      query: group.query,
      toolRunId: index === 0 ? "search-run" : `search-run-${index + 1}`,
    }),
  );
}

function browserSearchRun(
  results: Array<Record<string, unknown>>,
  options: { query?: string; toolRunId?: string } = {},
): ChatToolRunRecord {
  return {
    toolRunId: options.toolRunId ?? "search-run",
    turnId: "turn-research",
    sessionId: "session-research",
    toolName: "browser.search",
    status: "executed",
    args: { query: options.query ?? "CCG evidence", maxResults: 12 },
    result: { results },
    startedAt: "2026-08-06T10:00:00.000Z",
    finishedAt: "2026-08-06T10:00:01.000Z",
  };
}
