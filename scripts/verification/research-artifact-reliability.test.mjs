import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPresentationArgs,
  deterministicEvidenceUrls,
  listZipEntryNames,
  RESEARCH_ARTIFACT_GAP_QUERIES,
  RESEARCH_ARTIFACT_GATEWAY_ENV,
  RESEARCH_ARTIFACT_PROMPT,
} from "./research-artifact-reliability.mjs";
import {
  assertResearchArtifactPromptDeckSemantics,
  evaluateResearchArtifactPromptDeckSemantics,
} from "./lib/research-artifact-prompt-contract.mjs";
import "./lib/pptx-package-audit.test.mjs";
import "./lib/scenarios/deterministic-firecrawl-stub.test.mjs";

test("research artifact lane is the explicit prompt-budget receipt consumer", () => {
  assert.equal(RESEARCH_ARTIFACT_GATEWAY_ENV.GOATCITADEL_DEBUG_PROMPT_CONTEXT_BUDGET_RECEIPTS, "1");
});

test("ZIP central-directory parser fails closed on non-archives", () => {
  assert.throws(() => listZipEntryNames(Buffer.from("not a zip")), /end-of-central-directory/u);
});

test("CCG regression fixture is evidence-rich, scoped, comparable, and non-lossy", () => {
  const args = buildPresentationArgs(1);
  assert.equal(args.title, "CCG Competitive Landscape 2026: Best Fits for Players and Retailers");
  assert.equal(args.research.asOfDate, "2026-08-06");
  for (const field of [
    "inclusionCriteria",
    "exclusions",
    "methodology",
    "limitations",
    "competitors",
    "comparisonCriteria",
  ]) {
    assert.ok(Array.isArray(args.research[field]) && args.research[field].length > 0, `${field} is empty`);
  }
  assert.equal(args.research.competitors.length, 9);
  assert.ok(args.slides.length >= 12);
  assert.ok(args.sources.length >= 12);
  const sourceIds = new Set(args.sources.map((source) => source.id));
  const sourceUrls = new Set(args.sources.map((source) => source.url));
  const sourceDomains = new Set(args.sources.map((source) => new URL(source.url).hostname));
  assert.equal(sourceUrls.size, args.sources.length);
  assert.ok(sourceDomains.size >= 8);
  assert.ok(args.sources.every((source) => new URL(source.url).protocol === "https:"));
  for (const role of ["official", "independent", "marketplace", "financial"]) {
    assert.ok(
      args.sources.some((source) => source.role === role),
      `missing ${role} source`,
    );
  }

  for (const slide of args.slides) {
    for (const bullet of slide.bullets ?? []) {
      assert.equal(typeof bullet, "object");
      assert.ok(bullet.text.length <= 240, `bullet exceeds 240 characters: ${bullet.text}`);
      assert.doesNotMatch(bullet.text, /\.\.\.|…/u);
      assert.ok(["fact", "analysis", "recommendation"].includes(bullet.claimKind));
      assert.ok(
        bullet.sourceIds.every((sourceId) => sourceIds.has(sourceId)),
        `unknown source ID on ${slide.title}`,
      );
      if (bullet.claimKind !== "recommendation") {
        assert.ok(bullet.sourceIds.length > 0, `uncited material claim on ${slide.title}`);
      }
    }

    for (const header of slide.table?.headers ?? []) {
      assert.equal(typeof header, "object", `unstructured table header on ${slide.title}`);
      assert.ok(header.sourceIds.length > 0, `uncited table header on ${slide.title}`);
      assert.ok(
        header.sourceIds.every((sourceId) => sourceIds.has(sourceId)),
        `unknown table-header source ID on ${slide.title}`,
      );
    }
    for (const row of slide.table?.rows ?? []) {
      for (const cell of row) {
        assert.equal(typeof cell, "object", `unstructured table cell on ${slide.title}`);
        assert.ok(cell.sourceIds.length > 0, `uncited table cell on ${slide.title}`);
        assert.ok(
          cell.sourceIds.every((sourceId) => sourceIds.has(sourceId)),
          `unknown table-cell source ID on ${slide.title}`,
        );
      }
    }
  }

  const chartSlides = args.slides.filter((slide) => slide.archetype === "chart" && slide.chart);
  assert.ok(chartSlides.length >= 1, "fixture must exercise the native chart path");
  for (const slide of chartSlides) {
    for (const series of slide.chart.series ?? []) {
      assert.ok(series.sourceIds.length > 0, `uncited chart series on ${slide.title}`);
      assert.match(`${slide.title}: ${series.name}`, /\bas of 2026-08-06\b/iu);
    }
  }

  const matrixSlides = args.slides.filter((slide) => slide.archetype === "matrix" && slide.table);
  assert.ok(matrixSlides.length >= 3);
  const matrixText = matrixSlides
    .flatMap((slide) => slide.table.rows)
    .flatMap((row) => row.map((cell) => cell.text ?? cell));
  for (const competitor of args.research.competitors) {
    assert.ok(matrixText.includes(competitor), `matrix omitted ${competitor}`);
  }

  const promptContract = assertResearchArtifactPromptDeckSemantics({
    prompt: RESEARCH_ARTIFACT_PROMPT,
    args,
    acquiredEvidenceUrls: deterministicEvidenceUrls(),
  });
  assert.equal(promptContract.metrics.authoritativeOfficialCoverage, 9);
  assert.equal(promptContract.metrics.coveredMatrixFields, 10);
  assert.ok(promptContract.metrics.analyticalVisualCount >= 1);
});

test("prompt-to-deck semantic contract fails when an official source is relabeled or a game loses equal fields", () => {
  const relabeled = structuredClone(buildPresentationArgs(1));
  const magic = relabeled.sources.find((source) => source.id === "magic");
  magic.url = "https://www.tcgplayer.com/categories/trading-and-collectible-card-games";
  magic.publisher = "Marketplace relabeled as official";
  magic.role = "official";
  const relabeledReport = evaluateResearchArtifactPromptDeckSemantics({
    prompt: RESEARCH_ARTIFACT_PROMPT,
    args: relabeled,
    acquiredEvidenceUrls: deterministicEvidenceUrls(),
  });
  assert.equal(relabeledReport.passed, false);
  assert.match(relabeledReport.findings.join(" "), /Magic.*canonical authoritative official source/iu);

  const incomplete = structuredClone(buildPresentationArgs(1));
  const retailerMatrix = incomplete.slides.find((slide) => slide.title === "Physical CCG matrix: retailer proposition");
  retailerMatrix.table.rows.pop();
  assert.throws(
    () =>
      assertResearchArtifactPromptDeckSemantics({
        prompt: RESEARCH_ARTIFACT_PROMPT,
        args: incomplete,
        acquiredEvidenceUrls: deterministicEvidenceUrls(),
      }),
    /Gundam Card Game appears in 1 of 2 comparison matrices/iu,
  );
});

test("prompt-to-deck semantic contract treats non-root trailing slashes as canonical URL equivalents", () => {
  const args = structuredClone(buildPresentationArgs(1));
  for (const source of args.sources) {
    const parsed = new URL(source.url);
    if (parsed.pathname !== "/") source.url = source.url.replace(/\/+$/u, "");
  }
  const report = evaluateResearchArtifactPromptDeckSemantics({
    prompt: RESEARCH_ARTIFACT_PROMPT,
    args,
    acquiredEvidenceUrls: deterministicEvidenceUrls(),
  });
  assert.equal(report.passed, true, report.findings.join("\n"));
});

test("prompt-to-deck semantic contract requires explicit unknowns and a non-matrix analytical visual", () => {
  const fabricatedComparable = structuredClone(buildPresentationArgs(1));
  const playerMatrix = fabricatedComparable.slides.find(
    (slide) => slide.title === "Physical CCG matrix: player proposition",
  );
  playerMatrix.table.rows[0][3].text = "Low ongoing cost";
  fabricatedComparable.slides = fabricatedComparable.slides.filter((slide) => slide.archetype !== "chart");
  const report = evaluateResearchArtifactPromptDeckSemantics({
    prompt: RESEARCH_ARTIFACT_PROMPT,
    args: fabricatedComparable,
    acquiredEvidenceUrls: deterministicEvidenceUrls(),
  });
  assert.equal(report.passed, false);
  assert.match(report.findings.join(" "), /Magic.*costSignal.*not measured/iu);
  assert.match(report.findings.join(" "), /additional analytical visual/iu);
});

test("prompt-to-deck semantic contract is bound to the original research, comparison, and PowerPoint intent", () => {
  const report = evaluateResearchArtifactPromptDeckSemantics({
    prompt: "Write a short note.",
    args: buildPresentationArgs(1),
    acquiredEvidenceUrls: deterministicEvidenceUrls(),
  });
  assert.equal(report.passed, false);
  assert.match(report.findings.join(" "), /marketResearch intent/iu);
  assert.match(report.findings.join(" "), /powerPoint intent/iu);
});

test("CCG reliability lane schedules materially different gap-closing searches", () => {
  assert.ok(RESEARCH_ARTIFACT_GAP_QUERIES.length >= 3);
  const normalized = new Set(
    RESEARCH_ARTIFACT_GAP_QUERIES.map((query) => query.toLowerCase().split(/\W+/u).filter(Boolean).sort().join(" ")),
  );
  assert.equal(normalized.size, RESEARCH_ARTIFACT_GAP_QUERIES.length);
});
