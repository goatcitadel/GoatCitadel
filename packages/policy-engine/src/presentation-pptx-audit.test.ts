import { afterEach, describe, expect, it, vi } from "vitest";
import { stablePresentationSourceId } from "./presentation-model.js";
import {
  auditPresentationPptxPackage,
  createStoredZip,
  createPresentationPptxWithDiagnostics,
  readPresentationZipEntries,
  type PresentationPackageAuditExpectation,
  type PresentationPptxInput,
} from "./presentation-pptx.js";

afterEach(() => {
  vi.doUnmock("pptxgenjs");
  vi.doUnmock("sharp");
});

describe("presentation package audit and fallback parity", () => {
  it("preserves notes, citations, links, native tables, and labeled chart data in the fallback", async () => {
    vi.doMock("pptxgenjs", () => ({
      default: class UnavailablePptxGen {
        public constructor() {
          throw new Error("renderer unavailable");
        }
      },
    }));

    const input = researchInput();
    const result = await createPresentationPptxWithDiagnostics(input);

    expect(result.renderer).toBe("fallback");
    expect(result.retryAttempted).toBe(true);
    expect(result.packageAudit).toMatchObject({ passed: true });
    expect(result.manifest).toMatchObject({ tableCount: 1, chartCount: 1, visualCount: 2, authoredNoteCount: 1 });
    const entries = readPresentationZipEntries(result.buffer);
    const packageXml = [...entries.values()].map((entry) => entry.toString("utf8")).join("\n");
    const coverXml = entries.get("ppt/slides/slide1.xml")?.toString("utf8") ?? "";
    const contentXml = entries.get("ppt/slides/slide2.xml")?.toString("utf8") ?? "";
    expect(packageXml).toContain("Explain the evidence boundary to the audience.");
    expect(packageXml).toContain("Chart unavailable in compatibility renderer; data shown as a table.");
    expect(packageXml).toContain("Retail signal");
    expect(packageXml).toContain("<a:tbl>");
    expect(packageXml).toContain(`Target="${input.sources?.[0]?.url}" TargetMode="External"`);
    expect(coverXml).toMatch(/name="gc:subtitle"[\s\S]*?sz="1800"/u);
    expect(coverXml).not.toMatch(/name="gc:body"[\s\S]*?Evidence current through 2026-08-07/u);
    expect(contentXml).toMatch(/name="gc:title"[\s\S]*?sz="2800"/u);
    expect(result.manifest.minimumTitleFontSize).toBe(28);
  });

  it("passes the in-package audit on the primary rich renderer", async () => {
    const result = await createPresentationPptxWithDiagnostics(researchInput());

    expect(result.renderer).toBe("pptxgenjs");
    expect(result.retryAttempted).toBe(false);
    expect(result.packageAudit).toMatchObject({
      passed: true,
      observed: { tableCount: 1, chartCount: 1, authoredNoteCount: 1 },
    });
  });

  it("audits a structured source deck even when research metadata is absent", async () => {
    const url = "https://example.com/official-source";
    const sourceId = stablePresentationSourceId(url);
    const result = await createPresentationPptxWithDiagnostics({
      title: "Structured Source Deck",
      sources: [{ id: sourceId, title: "Official source", url, publisher: "Example", role: "official" }],
      slides: [
        {
          title: "Finding",
          bullets: [{ text: "The source supports this finding.", claimKind: "fact", sourceIds: [sourceId] }],
        },
      ],
    });

    expect(result.packageAudit).toMatchObject({ passed: true });
  });

  it("fails when one of two duplicate text occurrences is dropped from its expected slide", async () => {
    const input = placementInput("Repeated evidence", "Repeated evidence");
    const result = await createPresentationPptxWithDiagnostics(input);
    const corrupted = replaceSlideText(result.buffer, 3, [["Repeated evidence", "Dropped evidence"]]);

    const report = auditPresentationPptxPackage(corrupted, auditExpectation(input, result.manifest));

    expect(report.passed).toBe(false);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "visible-text-loss",
          message: expect.stringContaining("Slide 3 is missing 1 occurrence(s) of visible text: Repeated evidence"),
        }),
      ]),
    );
  });

  it("fails when text is moved to the wrong slide even though the package-wide multiset is unchanged", async () => {
    const input = placementInput("First-slide evidence", "Second-slide evidence");
    const result = await createPresentationPptxWithDiagnostics(input);
    const swappedFirst = replaceSlideText(result.buffer, 2, [["First-slide evidence", "Second-slide evidence"]]);
    const swappedBoth = replaceSlideText(swappedFirst, 3, [["Second-slide evidence", "First-slide evidence"]]);

    const report = auditPresentationPptxPackage(swappedBoth, auditExpectation(input, result.manifest));

    expect(report.passed).toBe(false);
    expect(report.findings.filter((item) => item.id === "visible-text-loss")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("Slide 2") }),
        expect.objectContaining({ message: expect.stringContaining("Slide 3") }),
      ]),
    );
  });

  it("accepts a semantic title that the renderer wraps across exact text runs", async () => {
    const input = placementInput("First-slide evidence", "Second-slide evidence");
    input.slides[0]!.title = "Current category signal: one comparable marketplace lens";
    const result = await createPresentationPptxWithDiagnostics(input);
    const slideXml = readPresentationZipEntries(result.buffer).get("ppt/slides/slide2.xml")?.toString("utf8") ?? "";

    expect(slideXml).not.toContain(`>${input.slides[0]!.title}<`);
    expect(auditPresentationPptxPackage(result.buffer, auditExpectation(input, result.manifest))).toMatchObject({
      passed: true,
    });
  });

  it("fails the package audit when table content or a source URL is likely to clip", async () => {
    const input = placementInput("First evidence", "Second evidence");
    const result = await createPresentationPptxWithDiagnostics(input);
    const longCell = "inventory-risk ".repeat(90).trim();
    const longUrl = `https://example.com/${"unbreakable".repeat(50)}`;
    const tableReport = auditPresentationPptxPackage(result.buffer, {
      ...auditExpectation(input, result.manifest),
      slides: [
        {
          ...input.slides[0]!,
          table: {
            headers: [{ text: "Game" }, { text: "Retail fit" }],
            rows: [[{ text: "Example" }, { text: longCell }]],
          },
        },
        input.slides[1]!,
      ],
    });
    const urlReport = auditPresentationPptxPackage(result.buffer, {
      ...auditExpectation(input, result.manifest),
      sources: [
        {
          id: stablePresentationSourceId(longUrl),
          title: "Long URL evidence",
          url: longUrl,
          publisher: "Example",
          role: "official",
        },
      ],
    });

    expect(tableReport.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "content-overflow", message: expect.stringContaining("table cell") }),
      ]),
    );
    expect(urlReport.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "content-overflow", message: expect.stringContaining("source URL") }),
      ]),
    );
  });

  it("rejects trusted direct-render notes that contain internal metadata", async () => {
    const input = placementInput("First evidence", "Second evidence");
    input.slides[0]!.speakerNotes = "provider=gpt-image-2; image prompt follows";

    await expect(createPresentationPptxWithDiagnostics(input)).rejects.toThrow(
      "contain internal render or provider metadata",
    );
  });
});

function placementInput(first: string, second: string): PresentationPptxInput {
  return {
    title: "Per-slide Text Audit",
    subtitle: "Cover subtitle remains bound to slide one",
    slides: [
      { title: "First placement", bullets: [first] },
      { title: "Second placement", bullets: [second] },
    ],
  };
}

function auditExpectation(
  input: PresentationPptxInput,
  manifest: Awaited<ReturnType<typeof createPresentationPptxWithDiagnostics>>["manifest"],
): PresentationPackageAuditExpectation {
  return {
    title: input.title,
    subtitle: input.subtitle,
    slides: input.slides,
    sources: input.sources ?? [],
    manifest,
    renderer: "pptxgenjs",
  };
}

function replaceSlideText(
  buffer: Buffer,
  slideNumber: number,
  replacements: ReadonlyArray<readonly [string, string]>,
): Buffer {
  const target = `ppt/slides/slide${slideNumber}.xml`;
  return createStoredZip(
    [...readPresentationZipEntries(buffer)].map(([name, data]) => {
      if (name !== target) return { name, data };
      let xml = data.toString("utf8");
      for (const [before, after] of replacements) {
        expect(xml).toContain(`>${before}<`);
        xml = xml.replaceAll(`>${before}<`, `>${after}<`);
      }
      return { name, data: Buffer.from(xml, "utf8") };
    }),
  );
}

function researchInput(): PresentationPptxInput {
  const url = "https://example.com/official";
  const sourceId = stablePresentationSourceId(url);
  return {
    title: "Audited Research Deck",
    subtitle: "Evidence current through 2026-08-07",
    research: {
      asOfDate: "2026-08-07",
      geography: "North America",
      physicalDigitalBoundary: "Physical products are primary; digital is adjacent.",
      inclusionCriteria: ["Active retail distribution"],
      exclusions: ["Inactive products"],
      methodology: ["Official and independent source review"],
      limitations: ["Public evidence only"],
      competitors: ["Example"],
      comparisonCriteria: ["Player fit"],
    },
    sources: [
      {
        id: sourceId,
        title: "Official source",
        url,
        publisher: "Example",
        role: "official",
      },
    ],
    slides: [
      {
        title: "Finding",
        speakerNotes: "Explain the evidence boundary to the audience.",
        bullets: [{ text: "Official support is active.", claimKind: "fact", sourceIds: [sourceId] }],
      },
      {
        title: "Paginated Evidence",
        bullets: [
          "Retail distribution remains available.",
          "Organized play is documented.",
          "Entry products are listed.",
          "The product has an official rules resource.",
          "Public evidence defines the current limitation.",
          "A sixth claim forces a deterministic continuation.",
        ].map((text) => ({ text, claimKind: "fact" as const, sourceIds: [sourceId] })),
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
          series: [{ name: "Retail signal", values: [7], sourceIds: [sourceId] }],
        },
      },
    ],
  };
}
