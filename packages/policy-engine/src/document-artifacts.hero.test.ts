import { describe, expect, it } from "vitest";
import { buildArtifactDesignReport, createArtifactDesignPlan } from "./artifact-design.js";
import { createDocumentArtifact } from "./document-artifacts.js";
import { createPresentationPptxWithDiagnostics, readPresentationZipEntries } from "./presentation-pptx.js";

const sections = [
  {
    heading: "Why it matters",
    body: "Thirty minutes a day is the cheapest health intervention.",
    bullets: ["Heart", "Sleep"],
  },
  { heading: "The plan", body: "Four weeks, one slot, no pace tracking.", bullets: ["Week 1: ten minutes"] },
];

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("artifacts without provider visuals", () => {
  it("ships a polished DOCX with no placeholder hero image", async () => {
    const design = createArtifactDesignPlan({
      kind: "document",
      format: "docx",
      title: "Daily Walking Brief",
      sections,
    });
    const artifact = await createDocumentArtifact("docx", {
      title: "Daily Walking Brief",
      body: "A short brief.",
      sections,
      design,
    });
    const bytes = artifact.data as Buffer;

    expect(design.mode).toBe("polished");
    expect(bytes.subarray(0, 2).toString("utf8")).toBe("PK");
    expect(bytes.includes("word/document.xml")).toBe(true);
    expect(bytes.includes("word/media/")).toBe(false);
  });

  it("ships a PPTX with no media part and reports only the built-in primitives as used", async () => {
    const result = await createPresentationPptxWithDiagnostics({
      title: "Daily Walking",
      slides: [
        {
          title: "Why walk every day",
          bullets: ["Lowers resting heart rate", "Improves sleep onset", "Costs nothing"],
        },
      ],
    });

    expect(result.renderer).toBe("pptxgenjs");
    const mediaParts = [...readPresentationZipEntries(result.buffer).keys()].filter((name) =>
      /^ppt\/media\/.+/u.test(name),
    );
    expect(mediaParts).toEqual([]);
    expect(result.usedAssetIds).toEqual(["built-in-shapes-icons"]);
    expect(result.manifest.visualCount).toBe(0);
  });

  it("does not report the generated visual as used when a mapped image lands on a semantic slide", async () => {
    // The renderer prepends the title slide, so slideIndex 1 is the first content slide. A comparison
    // archetype keeps its semantic renderer, which never draws the mapped image.
    const result = await createPresentationPptxWithDiagnostics({
      title: "Daily Walking",
      slides: [
        {
          title: "Morning versus evening",
          archetype: "comparison",
          bullets: ["Morning: daylight anchors the habit", "Evening: winds down screen time"],
        },
      ],
      visualAssets: [
        {
          slideIndex: 1,
          asset: { bytesBase64: ONE_PIXEL_PNG_BASE64, source: "openai", sourceModel: "gpt-image-2" },
        },
      ],
    });

    expect(result.renderer).toBe("pptxgenjs");
    expect(result.manifest.layoutCounts).toMatchObject({ hero: 1, comparison: 1 });
    expect(result.manifest.visualCount).toBe(0);
    expect(result.usedAssetIds).toEqual(["built-in-shapes-icons"]);
  });

  it("marks the generated visual as skipped with a reason when nothing was supplied", () => {
    const plan = createArtifactDesignPlan({ kind: "presentation", format: "pptx", title: "Daily Walking" });
    const report = buildArtifactDesignReport(plan, { localPath: "deck.pptx", usedAssetIds: ["built-in-shapes-icons"] });

    const generated = report.skippedAssets.find((asset) => asset.id === "renderer-generated-visual");
    expect(generated?.status).toBe("skipped");
    expect(generated?.reason).toMatch(/no provider image/iu);
    expect(generated?.source).not.toMatch(/local renderer/iu);
    expect(report.assetSources.some((asset) => asset.id === "renderer-generated-visual")).toBe(false);
  });
});
