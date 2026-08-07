import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import test from "node:test";

import { auditPptxPackage, formatPptxAuditFailure, listZipEntryNames, readZipEntries } from "./pptx-package-audit.mjs";

test("ZIP reader fails closed on malformed and corrupt archives", () => {
  assert.throws(() => listZipEntryNames(Buffer.from("not a zip")), /end-of-central-directory/u);
  const zip = buildZip([{ name: "hello.txt", value: "hello", compress: true }]);
  assert.equal(readZipEntries(zip).get("hello.txt").toString("utf8"), "hello");
  const corrupt = Buffer.from(zip);
  const payloadOffset = 30 + Buffer.byteLength("hello.txt");
  corrupt[payloadOffset] ^= 0xff;
  assert.throws(() => readZipEntries(corrupt), /invalid|CRC|unexpected end|distance/iu);
});

test("PPTX audit verifies text, links, notes, fonts, native visuals, layouts, and manifest", async () => {
  const fixture = buildHealthyPptx();
  await withFixture(fixture.bytes, async (filePath) => {
    const report = await auditPptxPackage(filePath, {
      expectedVisibleText: fixture.expectedText,
      expectedExternalUrls: [fixture.sourceUrl],
      manifest: fixture.manifest,
      requireLayoutDiversity: true,
    });
    assert.equal(report.passed, true, formatPptxAuditFailure(report));
    assert.deepEqual(report.metrics, {
      slideCount: 8,
      contentSlideCount: 7,
      tableCount: 1,
      chartCount: 1,
      mediaCount: 2,
      pictureCount: 2,
      hyperlinkCount: 1,
      hyperlinkRelationshipCount: 1,
      uniqueHyperlinkTargetCount: 1,
      sourceUrlCount: 1,
      sourceCount: 1,
      continuationCount: 0,
      visualCount: 4,
      tableOverflowRiskCount: 0,
      wrappedTextOverflowRiskCount: 0,
      authoredNoteCount: 1,
      citationNoteCount: 1,
      shrinkAutofitCount: 0,
      bodyShrinkAutofitCount: 0,
      sourceShrinkAutofitCount: 0,
      tableShrinkAutofitCount: 0,
      layoutFamilyCount: 6,
      layoutFamilies: { image: 2, cards: 2, table: 1, chart: 1, columns: 1, source: 1 },
      semanticLayoutCounts: { hero: 2, cards: 2, table: 1, chart: 1, columns: 1, sources: 1 },
      layoutSignatureCount: 6,
      layoutSignatureCounts: {
        "hero::2:0:0:1": 2,
        "cards::4:0:0:0": 2,
        "table::1:1:0:0": 1,
        "chart::2:0:1:0": 1,
        "columns::3:0:0:0": 1,
        "sources::2:0:0:0": 1,
      },
      maximumConsecutiveLayoutCount: 1,
      maximumRawConsecutiveLayoutCount: 1,
      maximumConsecutiveSignatureCount: 1,
      dominantLayoutShare: 2 / 7,
      minimumFonts: { coverTitle: 34, coverSubtitle: 18, title: 28, body: 16, source: 12, table: 14 },
      minimumFontSize: 12,
      minimumCoverTitleFontSize: 34,
      minimumCoverSubtitleFontSize: 18,
      minimumTitleFontSize: 28,
      minimumBodyFontSize: 16,
      minimumTableFontSize: 14,
      minimumSourceFontSize: 12,
      minimumCitationFontSize: undefined,
      minimumSlideNumberFontSize: undefined,
    });
    assert.equal(report.externalHyperlinks[0], fixture.sourceUrl);
    assert.equal(report.noteTextNodes.includes("Presenter guidance for the retailer audience."), true);
  });
});

test("PPTX audit rejects lossy text, unsafe links, dirty notes, shrink-to-fit, and manifest drift", async () => {
  const fixture = buildUnhealthyPptx();
  await withFixture(fixture.bytes, async (filePath) => {
    const report = await auditPptxPackage(filePath, {
      expectedVisibleText: ["This exact sentence must survive rendering."],
      expectedExternalUrls: ["https://example.com/expected"],
      manifest: {
        slideCount: 2,
        hyperlinkCount: 2,
        layoutCounts: { hero: 1 },
        layoutSignatureCounts: { "not-a-package-signature": 1 },
      },
    });
    assert.equal(report.passed, false);
    const codes = new Set(report.findings.map((finding) => finding.code));
    for (const code of [
      "visible-truncation-marker",
      "missing-expected-text",
      "missing-expected-hyperlink",
      "nonhttps-hyperlink",
      "credentialed-hyperlink",
      "truncated-hyperlink",
      "forbidden-note-metadata",
      "font-below-coverTitle-floor",
      "font-below-source-floor",
      "source-shrink-autofit",
      "table-shrink-autofit",
      "table-frame-height-overflow",
      "manifest-mismatch",
      "manifest-layout-family-mismatch",
      "manifest-layout-signature-mismatch",
    ]) {
      assert.equal(codes.has(code), true, `missing expected finding ${code}`);
    }
    assert.equal(report.metrics.minimumCoverTitleFontSize, 28);
    assert.equal(report.metrics.minimumCoverSubtitleFontSize, undefined);
    assert.equal(report.metrics.bodyShrinkAutofitCount, 0);
    assert.equal(report.metrics.sourceShrinkAutofitCount, 1);
    assert.equal(report.metrics.tableShrinkAutofitCount, 1);
  });
});

test("PPTX audit counts duplicate legacy expected text occurrences", async () => {
  const entries = baseEntries([slide([shape("Repeated evidence", 3400, 200_000, { name: "gc:title" })])]);
  await withFixture(buildZip(entries), async (filePath) => {
    const report = await auditPptxPackage(filePath, {
      expectedVisibleText: ["Repeated evidence", "  Repeated   evidence  "],
    });
    assert.equal(report.passed, false);
    const finding = report.findings.find((item) => item.code === "missing-expected-text");
    assert.match(finding?.message ?? "", /required 2, found 1/u);
  });
});

test("PPTX audit detects cross-slide text swaps even when global legacy expectations pass", async () => {
  const entries = baseEntries([
    slide([shape("Alpha evidence", 3400, 200_000, { name: "gc:title" })]),
    slide([shape("Beta evidence", 2800, 200_000, { name: "gc:title" })]),
  ]);
  await withFixture(buildZip(entries), async (filePath) => {
    const report = await auditPptxPackage(filePath, {
      expectedVisibleText: ["Alpha evidence", "Beta evidence"],
      expectedVisibleTextBySlide: {
        schemaVersion: 1,
        slides: [
          { slideNumber: 1, expectedVisibleText: ["Beta evidence"] },
          { slideNumber: 2, expectedVisibleText: ["Alpha evidence"] },
        ],
      },
    });
    assert.equal(report.passed, false);
    assert.equal(report.findings.some((item) => item.code === "missing-expected-text"), false);
    const placementFindings = report.findings.filter((item) => item.code === "missing-expected-slide-text");
    assert.equal(placementFindings.length, 2);
    assert.deepEqual(
      placementFindings.map((item) => item.part),
      ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"],
    );
  });
});

test("PPTX audit enforces cover title and subtitle floors without weakening body shrink rules", async () => {
  const entries = baseEntries([
    slide([
      shape("Undersized cover", 3300, 200_000, { name: "gc:title" }),
      shape("Undersized subtitle", 1700, 1_500_000, { name: "gc:subtitle", shrink: true }),
    ]),
  ]);
  await withFixture(buildZip(entries), async (filePath) => {
    const report = await auditPptxPackage(filePath);
    assert.equal(report.passed, false);
    const codes = new Set(report.findings.map((finding) => finding.code));
    assert.equal(codes.has("font-below-coverTitle-floor"), true);
    assert.equal(codes.has("font-below-coverSubtitle-floor"), true);
    assert.equal(codes.has("body-shrink-autofit"), true);
    assert.equal(report.metrics.minimumCoverTitleFontSize, 33);
    assert.equal(report.metrics.minimumCoverSubtitleFontSize, 17);
    assert.equal(report.metrics.bodyShrinkAutofitCount, 1);
  });
});

test("PPTX audit permits a consecutive source appendix while enforcing analytical layout diversity", async () => {
  const urls = Array.from({ length: 4 }, (_, index) => `https://source${index + 1}.example/research`);
  const slides = [
    slide([shape("Cover", 3400, 200_000), shape("Evidence", 1800, 1_500_000)], "<p:pic/>"),
    slide([
      shape("Cards", 2800, 200_000),
      shape("A", 1600, 1_200_000),
      shape("B", 1600, 2_200_000),
      shape("C", 1600, 3_200_000),
    ]),
    slide([shape("Matrix", 2800, 200_000)], `<a:tbl><a:tr><a:tc>${run("Cell", 1400)}</a:tc></a:tr></a:tbl>`),
    slide([shape("Chart", 2800, 200_000), shape("Signal", 1600, 1_400_000)], '<c:chart r:id="rIdChart"/>'),
    slide([shape("Columns", 2800, 200_000), shape("Left", 1600, 1_400_000), shape("Right", 1600, 3_000_000)]),
    ...urls.map((url, index) =>
      slide([shape(`Sources ${index + 1}`, 2800, 200_000), shape(url, 1200, 1_400_000, { hyperlinkId: "rIdSource" })]),
    ),
  ];
  const entries = baseEntries(slides);
  entries.push(
    { name: "ppt/media/image1.png", value: "image", compress: true },
    { name: "ppt/charts/chart1.xml", value: "<c:chartSpace/>", compress: true },
    {
      name: "ppt/slides/_rels/slide4.xml.rels",
      value: relationships([{ id: "rIdChart", type: "chart", target: "../charts/chart1.xml" }]),
      compress: true,
    },
    ...urls.map((url, index) => ({
      name: `ppt/slides/_rels/slide${index + 6}.xml.rels`,
      value: relationships([{ id: "rIdSource", type: "hyperlink", target: url, targetMode: "External" }]),
      compress: true,
    })),
  );
  await withFixture(buildZip(entries), async (filePath) => {
    const report = await auditPptxPackage(filePath, { requireLayoutDiversity: true, expectedExternalUrls: urls });
    assert.equal(report.passed, true, formatPptxAuditFailure(report));
    assert.equal(report.metrics.maximumRawConsecutiveLayoutCount, 4);
    assert.equal(report.metrics.maximumConsecutiveLayoutCount, 1);
    assert.equal(report.metrics.maximumConsecutiveSignatureCount, 1);
  });
});

test("PPTX audit honors renderer semantic shape names before positional heuristics", async () => {
  const entries = baseEntries([
    slide([
      shape("Semantic title", 3400, 5_500_000, { name: "gc:title" }),
      shape("Semantic body", 1800, 200_000, { name: "gc:body:stacked" }),
      shape("[S1]", 1100, 2_000_000, { name: "gc:citation" }),
      shape("7", 1000, 200_000, { name: "gc:slide-number" }),
    ]),
  ]);
  await withFixture(buildZip(entries), async (filePath) => {
    const report = await auditPptxPackage(filePath);
    assert.equal(report.passed, true, formatPptxAuditFailure(report));
    assert.deepEqual(report.metrics.minimumFonts, {
      coverTitle: 34,
      coverSubtitle: 18,
      citation: 11,
      slideNumber: 10,
    });
  });
});

test("PPTX audit verifies production layout-family aliases against package semantics", async () => {
  const entries = baseEntries([
    slide(
      [
        shape("Cover", 3400, 200_000, { name: "gc:title" }),
        shape("Research scope", 1800, 1_500_000, { name: "gc:subtitle" }),
        markerShape("gc:layout:hero"),
      ],
      "<p:pic/>",
    ),
    slide(
      [
        shape("Image and text", 2800, 200_000, { name: "gc:title" }),
        shape("Narrative evidence", 1600, 1_500_000),
        markerShape("gc:layout:image-text"),
      ],
      "<p:pic/>",
    ),
    slide([
      shape("Stat callout", 2800, 200_000, { name: "gc:title" }),
      shape("Directional signal", 1600, 1_500_000),
      markerShape("gc:layout:stat-callout"),
    ]),
    slide(
      [shape("Matrix — Continued", 2800, 200_000, { name: "gc:title" }), markerShape("gc:layout:table-continuation")],
      `<a:tbl><a:tr><a:tc>${run("Cell", 1400)}</a:tc></a:tr></a:tbl>`,
    ),
    slide([
      shape("Closing — Continued", 2800, 200_000, { name: "gc:title" }),
      shape("Final uncertainty", 1600, 1_500_000),
      markerShape("gc:layout:closing"),
    ]),
  ]);
  await withFixture(buildZip(entries), async (filePath) => {
    const report = await auditPptxPackage(filePath, {
      manifest: {
        slideCount: 5,
        layoutCounts: { hero: 1, "image-text": 1, "stat-callout": 1, "table-continuation": 1, closing: 1 },
      },
    });
    assert.equal(report.passed, true, formatPptxAuditFailure(report));
    assert.deepEqual(report.metrics.semanticLayoutCounts, { hero: 1, narrative: 2, table: 1, closing: 1 });
    assert.equal(
      report.findings.some((finding) => finding.code === "manifest-layout-family-unverifiable"),
      false,
    );
    assert.equal(
      report.findings.some((finding) => finding.code === "manifest-layout-family-mismatch"),
      false,
    );
  });
});

test("PPTX audit treats same-title pages as one section while preserving adjacent matrix boundaries", async () => {
  const table = `<a:tbl><a:tr><a:tc>${run("Cell", 1400)}</a:tc></a:tr></a:tbl>`;
  const slides = [
    slide([shape("Cover", 3400, 200_000)], "<p:pic/>"),
    slide(
      [shape("Physical comparison matrix I", 2800, 200_000), shape("Scope", 1600, 1_500_000)],
      table,
    ),
    slide([shape("Physical comparison matrix I", 2800, 200_000)], table),
    slide([shape("Physical comparison matrix I — Continued", 2800, 200_000)], table),
    slide(
      [shape("Physical comparison matrix I — Continued", 2800, 200_000), markerShape("gc:layout:table-continuation")],
      table,
    ),
    slide(
      [shape("Physical comparison matrix II", 2800, 200_000), shape("Scope", 1600, 1_500_000)],
      table,
    ),
    slide(
      [shape("Physical comparison matrix II", 2800, 200_000)],
      table,
    ),
    slide(
      [shape("Physical comparison matrix II — Continued", 2800, 200_000), markerShape("gc:layout:table-continuation")],
      table,
    ),
    slide([shape("Player fit", 2800, 200_000), shape("A", 1600, 1_500_000), shape("B", 1600, 3_000_000)]),
    slide([
      shape("Retailer fit", 2800, 200_000),
      shape("A", 1600, 1_200_000),
      shape("B", 1600, 2_200_000),
      shape("C", 1600, 3_200_000),
    ]),
    slide([shape("Closing", 2800, 200_000), shape("Conditional recommendation", 1600, 1_500_000)]),
  ];
  const entries = baseEntries(slides);
  entries.push({ name: "ppt/media/image1.png", value: "image", compress: true });
  await withFixture(buildZip(entries), async (filePath) => {
    const report = await auditPptxPackage(filePath, { requireLayoutDiversity: true });
    assert.equal(report.passed, true, formatPptxAuditFailure(report));
    assert.equal(report.metrics.maximumRawConsecutiveLayoutCount, 7);
    assert.equal(report.metrics.maximumConsecutiveLayoutCount, 1);
    assert.equal(report.metrics.maximumConsecutiveSignatureCount, 2);
    assert.equal(report.metrics.continuationCount, 3);
  });
});

test("PPTX audit ignores cosmetic empty shapes when checking repeated continuation signatures", async () => {
  const table = `<a:tbl><a:tr><a:tc>${run("Cell", 1400)}</a:tc></a:tr></a:tbl>`;
  const slides = [
    slide([shape("Cover", 3400, 200_000)], "<p:pic/>"),
    slide([shape("Physical matrix", 2800, 200_000)], table),
    slide([shape("Physical matrix — Continued", 2800, 200_000), markerShape("Cosmetic flourish A")], table),
    slide([shape("Physical matrix — Continued", 2800, 200_000), markerShape("Cosmetic flourish B")], table),
    slide([shape("Physical matrix — Continued", 2800, 200_000)], table),
    slide([shape("Player fit", 2800, 200_000), shape("Left", 1600, 1_400_000), shape("Right", 1600, 3_000_000)]),
    slide([
      shape("Retail fit", 2800, 200_000),
      shape("A", 1600, 1_300_000),
      shape("B", 1600, 2_400_000),
      shape("C", 1600, 3_500_000),
    ]),
    slide([shape("Closing", 2800, 200_000), shape("Conditional conclusion", 1600, 1_500_000)]),
  ];
  const entries = baseEntries(slides);
  entries.push({ name: "ppt/media/image1.png", value: "image", compress: true });
  await withFixture(buildZip(entries), async (filePath) => {
    const report = await auditPptxPackage(filePath, { requireLayoutDiversity: true });
    assert.equal(report.passed, false);
    assert.equal(report.metrics.maximumConsecutiveSignatureCount, 4);
    assert.equal(
      report.findings.some((finding) => finding.code === "repeated-layout-signature-run"),
      true,
    );
  });
});

test("PPTX audit rejects likely wrapped overflow in body, source URL, and table-cell geometry", async () => {
  const longBody = "Dense analytical body content ".repeat(30).trim();
  const longUrl = `https://evidence.example.com/${"long-source-segment/".repeat(22)}detail`;
  const longCell = "Not measured comparably; retailer inventory uncertainty requires local validation. "
    .repeat(14)
    .trim();
  const table = `<p:graphicFrame><p:xfrm><a:off x="500000" y="1400000"/><a:ext cx="2286000" cy="444500"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="2286000"/></a:tblGrid><a:tr h="444500"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1400"/><a:t>${escapeXml(longCell)}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const entries = baseEntries([
    slide([shape("Cover", 3400, 200_000)]),
    slide([
      shape("Body capacity", 2800, 200_000),
      shape(longBody, 1600, 1_200_000, { name: "gc:body:stacked", width: 2_743_200, height: 457_200 }),
    ]),
    slide([
      shape("Source capacity", 2800, 200_000),
      shape(longUrl, 1200, 1_200_000, {
        name: "gc:source",
        width: 3_657_600,
        height: 411_480,
        hyperlinkId: "rIdSource",
      }),
    ]),
    slide([shape("Table capacity", 2800, 200_000)], table),
  ]);
  entries.push({
    name: "ppt/slides/_rels/slide3.xml.rels",
    value: relationships([{ id: "rIdSource", type: "hyperlink", target: longUrl, targetMode: "External" }]),
    compress: true,
  });
  await withFixture(buildZip(entries), async (filePath) => {
    const report = await auditPptxPackage(filePath, { expectedExternalUrls: [longUrl] });
    assert.equal(report.passed, false);
    const codes = new Set(report.findings.map((finding) => finding.code));
    assert.equal(codes.has("body-wrapped-text-overflow-risk"), true);
    assert.equal(codes.has("source-wrapped-text-overflow-risk"), true);
    assert.equal(codes.has("table-cell-wrapped-text-overflow-risk"), true);
    assert.equal(report.metrics.tableOverflowRiskCount, 0, "legacy row-height sums should not catch this fixture");
    assert.equal(report.metrics.wrappedTextOverflowRiskCount, 3);
  });
});

function buildHealthyPptx() {
  const sourceUrl = "https://example.com/research/ccg-market";
  const slideXml = [
    slide([shape("Cover", 3400, 200_000), shape("North American physical CCGs", 1800, 1_600_000)], "<p:pic/>"),
    slide([
      shape("Bottom line", 2800, 200_000),
      shape("Best for broad collecting", 1600, 1_300_000),
      shape("Best for deep formats", 1600, 2_400_000),
      shape("Best for store events", 1600, 3_500_000),
    ]),
    slide(
      [shape("Comparison matrix", 2800, 200_000)],
      `<a:tbl><a:tr><a:tc>${run("Game", 1400)}</a:tc><a:tc>${run("Retail fit", 1400)}</a:tc></a:tr></a:tbl>`,
    ),
    slide(
      [shape("Category signals", 2800, 200_000), shape("Comparable evidence only", 1600, 1_500_000)],
      '<c:chart r:id="rIdChart"/>',
    ),
    slide([
      shape("Two audiences", 2800, 200_000),
      shape("Players value onboarding and depth", 1600, 1_400_000),
      shape("Retailers value demand and manageable releases", 1600, 3_000_000),
    ]),
    slide(
      [shape("Community", 2800, 200_000), shape("Organized play supports repeat visits", 1600, 1_600_000)],
      "<p:pic/>",
    ),
    slide([
      shape("Watchlist", 2800, 200_000),
      shape("New entrants need current evidence", 1600, 1_300_000),
      shape("Inventory risk remains game-specific", 1600, 2_400_000),
      shape("Digital substitutes are assessed separately", 1600, 3_500_000),
    ]),
    slide([shape("Sources", 2800, 200_000), shape(sourceUrl, 1200, 1_600_000, { hyperlinkId: "rIdSource" })]),
  ];
  const entries = baseEntries(slideXml);
  entries.push(
    { name: "ppt/media/image1.png", value: "image-one", compress: true },
    { name: "ppt/media/image2.png", value: "image-two", compress: true },
    {
      name: "ppt/charts/chart1.xml",
      value:
        '<c:chartSpace xmlns:c="c"><c:ser><c:cat><c:strCache><c:pt><c:v>Official game sources</c:v></c:pt></c:strCache></c:cat></c:ser></c:chartSpace>',
      compress: true,
    },
    {
      name: "ppt/slides/_rels/slide1.xml.rels",
      value: relationships([{ id: "rIdNotes", type: "notesSlide", target: "../notesSlides/notesSlide1.xml" }]),
      compress: true,
    },
    {
      name: "ppt/slides/_rels/slide4.xml.rels",
      value: relationships([{ id: "rIdChart", type: "chart", target: "../charts/chart1.xml" }]),
      compress: true,
    },
    {
      name: "ppt/slides/_rels/slide8.xml.rels",
      value: relationships([
        { id: "rIdSource", type: "hyperlink", target: sourceUrl, targetMode: "External" },
        { id: "rIdNotes", type: "notesSlide", target: "../notesSlides/notesSlide8.xml" },
      ]),
      compress: true,
    },
    {
      name: "ppt/notesSlides/notesSlide1.xml",
      value: slide([shape("Presenter guidance for the retailer audience.", 1200, 1_000_000)]),
      compress: true,
    },
    {
      name: "ppt/notesSlides/notesSlide8.xml",
      value: slide([shape(`Sources: ${sourceUrl}`, 1100, 1_000_000)]),
      compress: true,
    },
  );
  return {
    bytes: buildZip(entries),
    sourceUrl,
    expectedText: ["North American physical CCGs", "Official game sources", "Inventory risk remains game-specific"],
    manifest: {
      slideCount: 8,
      tableCount: 1,
      chartCount: 1,
      mediaCount: 2,
      hyperlinkCount: 1,
      authoredNoteCount: 1,
      layoutCounts: { image: 2, cards: 2, matrix: 1, chart: 1, comparison: 1, sources: 1 },
      layoutSignatureCounts: {
        "hero::2:0:0:1": 2,
        "cards::4:0:0:0": 2,
        "table::1:1:0:0": 1,
        "chart::2:0:1:0": 1,
        "columns::3:0:0:0": 1,
        "sources::2:0:0:0": 1,
      },
    },
  };
}

function buildUnhealthyPptx() {
  const unsafeUrl = "http://user:secret@example.com/source...";
  const entries = baseEntries([
    slide(
      [
        shape("Bad deck", 2800, 200_000),
        shape("This sentence was silently cut...", 1000, 1_500_000, { shrink: true }),
        shape(unsafeUrl, 900, 4_500_000, { hyperlinkId: "rIdUnsafe" }),
      ],
      `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="100000"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tr h="200000"><a:tc><a:txBody><a:bodyPr><a:normAutofit/></a:bodyPr>${run("Overflow", 1400)}</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
    ),
  ]);
  entries.push(
    {
      name: "ppt/slides/_rels/slide1.xml.rels",
      value: relationships([
        { id: "rIdUnsafe", type: "hyperlink", target: unsafeUrl, targetMode: "External" },
        { id: "rIdNotes", type: "notesSlide", target: "../notesSlides/notesSlide1.xml" },
      ]),
      compress: true,
    },
    {
      name: "ppt/notesSlides/notesSlide1.xml",
      value: slide([shape("GoatCitadel design provenance\nRevised prompt: make it glossy", 1200, 1_000_000)]),
      compress: true,
    },
  );
  return { bytes: buildZip(entries) };
}

function baseEntries(slides) {
  return [
    { name: "[Content_Types].xml", value: "<Types/>", compress: true },
    {
      name: "ppt/presentation.xml",
      value: '<p:presentation xmlns:p="p"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
      compress: true,
    },
    ...slides.map((value, index) => ({ name: `ppt/slides/slide${index + 1}.xml`, value, compress: index % 2 === 0 })),
  ];
}

function slide(shapes, extra = "") {
  return `<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r" xmlns:c="c"><p:cSld><p:spTree>${shapes.join("")}${extra}</p:spTree></p:cSld></p:sld>`;
}

function shape(text, fontSize, y, options = {}) {
  const autofit = options.shrink ? "<a:normAutofit/>" : "<a:noAutofit/>";
  const hyperlink = options.hyperlinkId ? `<a:hlinkClick r:id="${options.hyperlinkId}"/>` : "";
  const nonVisualProperties = options.name
    ? `<p:nvSpPr><p:cNvPr id="1" name="${escapeXml(options.name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    : "";
  const extent =
    Number.isFinite(options.width) && Number.isFinite(options.height)
      ? `<a:ext cx="${options.width}" cy="${options.height}"/>`
      : "";
  return `<p:sp>${nonVisualProperties}<p:spPr><a:xfrm><a:off x="500000" y="${y}"/>${extent}</a:xfrm></p:spPr><p:txBody><a:bodyPr>${autofit}</a:bodyPr><a:p><a:r><a:rPr sz="${fontSize}">${hyperlink}</a:rPr><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function markerShape(name) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="91" name="${escapeXml(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>`;
}

function run(text, fontSize) {
  return `<a:p><a:r><a:rPr sz="${fontSize}"/><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
}

function relationships(items) {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(
      (item) =>
        `<Relationship Id="${item.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${item.type}" Target="${escapeXml(item.target)}"${item.targetMode ? ` TargetMode="${item.targetMode}"` : ""}/>`,
    )
    .join("")}</Relationships>`;
}

function escapeXml(value) {
  return String(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

async function withFixture(bytes, run) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "pptx-audit-"));
  const filePath = path.join(directory, "fixture.pptx");
  try {
    await fs.writeFile(filePath, bytes);
    await run(filePath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function buildZip(items) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name, "utf8");
    const value = Buffer.from(item.value);
    const compressed = item.compress ? deflateRawSync(value) : value;
    const method = item.compress ? 8 : 0;
    const crc = crc32(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(value.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(value.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.byteLength + name.byteLength + compressed.byteLength;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(items.length, 8);
  eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(centralDirectory.byteLength, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
