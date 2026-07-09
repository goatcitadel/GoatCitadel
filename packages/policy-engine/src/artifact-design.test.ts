import { describe, expect, it } from "vitest";
import { buildArtifactDesignReport, createArtifactDesignPlan } from "./artifact-design.js";

describe("artifact design brief selection", () => {
  it("defaults designed presentation requests to polished content-specific styling", () => {
    const plan = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Benefits of Daily Walking",
      slides: [
        {
          title: "Mental Well-Being",
          bullets: ["Can reduce stress", "May improve mood and focus"],
        },
      ],
    });

    expect(plan.mode).toBe("polished");
    expect(plan.preset).toBe("wellness");
    expect(plan.visualLevel).toBe("polished");
    expect(plan.assetPolicy).toBe("generated-first");
    expect(plan.layouts.map((layout) => layout.name)).toContain("hero");
    expect(plan.assetPlan.some((asset) => asset.type === "generated" && asset.status === "planned")).toBe(true);
  });

  it("keeps raw data artifacts minimal", () => {
    const plan = createArtifactDesignPlan({
      kind: "data",
      format: "json",
      title: "Raw API Logs",
      body: "Return plain JSON logs.",
    });

    expect(plan.mode).toBe("minimal");
    expect(plan.assetPolicy).toBe("none");
    expect(plan.layouts).toEqual([
      { name: "plain-data", purpose: "Preserve machine-readable output without decoration." },
    ]);

    const report = buildArtifactDesignReport(plan, { localPath: "out.json" });
    expect(report.residualRisks).not.toContain(
      "Some external or web assets were skipped because source, license, provider, or approval data was unavailable.",
    );
  });

  it("honors explicit design overrides", () => {
    const plan = createArtifactDesignPlan({
      kind: "document",
      format: "docx",
      title: "Gateway Runtime Brief",
      design: {
        mode: "polished",
        preset: "cyberpunk-ops",
        visualLevel: "rich",
        assetPolicy: "built-in-only",
        brand: { colors: ["#22D3EE", "#F472B6"], fonts: ["Aptos Display", "Aptos"] },
      },
    });

    expect(plan.preset).toBe("cyberpunk-ops");
    expect(plan.visualLevel).toBe("rich");
    expect(plan.assetPolicy).toBe("built-in-only");
    expect(plan.tokens.accent).toBe("22D3EE");
    expect(plan.tokens.accent2).toBe("F472B6");
  });

  it("maps Google presentation destinations to hybrid conversion status", () => {
    const plan = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Quarterly Pitch",
      destination: "google",
    });

    expect(plan.destination).toMatchObject({ kind: "google-slides", convert: true });
    expect(plan.validationChecks.map((check) => check.id)).toContain("google-import");
    expect(plan.validationChecks.map((check) => check.id)).toContain("presentation-template");
    expect(plan.validationChecks.map((check) => check.id)).toContain("content-density");
  });

  it("marks renderer-used assets and completed local checks in reports", () => {
    const plan = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Quarterly Pitch",
    });

    const report = buildArtifactDesignReport(plan, {
      localPath: "deck.pptx",
      usedAssetIds: ["renderer-generated-visual", "built-in-shapes-icons"],
    });

    expect(report.assetSources.find((asset) => asset.id === "renderer-generated-visual")?.status).toBe("used");
    expect(report.validation.filter((check) => check.status === "planned")).toHaveLength(0);
    expect(report.validation.find((check) => check.id === "pptx-package")?.status).toBe("passed");
    expect(report.validation.find((check) => check.id === "presentation-template")?.status).toBe("passed");
    expect(report.validation.find((check) => check.id === "design-skill-applied")?.status).toBe("passed");
    expect(report.validation.find((check) => check.id === "artifact-audit")?.status).toBe("passed");
    expect(report.designQuality).toMatchObject({
      skillId: "design-intelligence",
      register: "brand/marketing",
      lifecycle: "Polish",
      status: "applied",
      retryAttempted: true,
      findings: [],
    });
  });

  it("allows renderer-specific validation details in design reports", () => {
    const plan = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Quarterly Pitch",
    });

    const report = buildArtifactDesignReport(plan, {
      localPath: "deck.pptx",
      validationResults: {
        "content-density": {
          status: "warning",
          detail: "One content slide had no supporting bullets.",
        },
      },
    });

    expect(report.validation.find((check) => check.id === "content-density")).toMatchObject({
      status: "warning",
      detail: "One content slide had no supporting bullets.",
    });
    expect(report.validation.find((check) => check.id === "presentation-template")?.status).toBe("passed");
  });

  it("skips design-quality visual checks for raw data reports", () => {
    const plan = createArtifactDesignPlan({
      kind: "data",
      format: "csv",
      title: "Raw Export",
    });

    const report = buildArtifactDesignReport(plan, { localPath: "out.csv" });

    expect(report.designQuality).toMatchObject({
      skillId: "design-intelligence",
      register: "data/plain",
      status: "skipped",
      retryAttempted: false,
    });
    expect(report.validation.find((check) => check.id === "design-skill-applied")?.status).toBe("skipped");
    expect(report.validation.find((check) => check.id === "asset-specificity")?.status).toBe("skipped");
  });

  it("surfaces artifact design-quality findings as warnings and residual risks", () => {
    const plan = createArtifactDesignPlan({
      kind: "presentation",
      format: "pptx",
      title: "Weekend Fun",
    });

    const report = buildArtifactDesignReport(plan, {
      localPath: "deck.pptx",
      designQuality: {
        findings: [
          {
            id: "asset-specificity",
            severity: "P2",
            dimension: "Visual Coherence",
            message: "Presentation used local renderer-only visuals.",
            repaired: false,
          },
        ],
      },
    });

    expect(report.designQuality?.status).toBe("warning");
    expect(report.validation.find((check) => check.id === "asset-specificity")?.status).toBe("warning");
    expect(report.validation.find((check) => check.id === "artifact-audit")?.status).toBe("warning");
    expect(report.residualRisks).toContain("Presentation used local renderer-only visuals.");
  });
});
