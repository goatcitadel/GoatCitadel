import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { PresentationPackageAuditReport } from "./presentation-pptx.js";
import { executeArtifactTool } from "./tool-executor/artifact-executor.js";

const createdRoots: string[] = [];

afterEach(() => {
  vi.doUnmock("pptxgenjs");
  vi.doUnmock("sharp");
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("research presentation fail-closed runtime", () => {
  it("rerenders once after a failed package audit and writes only the passing result", async () => {
    const writes = installMemoryRenderer();
    const root = createRoot();
    const output = path.join(root, "repair-pass.pptx");
    const audit = vi
      .fn()
      .mockReturnValueOnce(auditReport(false, "manifest-link-count"))
      .mockReturnValueOnce(auditReport(true));
    const args = researchPresentationArgs(output);

    const result = await executeArtifactTool("presentations.create", args, createConfig(root), {
      presentationPackageAuditor: audit,
      request: groundedRequest(args),
    });

    expect(audit).toHaveBeenCalledTimes(2);
    expect(writes()).toBe(2);
    expect(fs.readFileSync(output).toString("utf8")).toBe("PKmock-2");
    expect(result).toMatchObject({
      packageAudit: { passed: true },
      designReport: { designQuality: { retryAttempted: true } },
    });
  });

  it("fails closed without writing after two failed package audits", async () => {
    const writes = installMemoryRenderer();
    const root = createRoot();
    const output = path.join(root, "double-fail.pptx");
    const audit = vi.fn().mockReturnValue(auditReport(false, "semantic-font-floor"));
    const args = researchPresentationArgs(output);

    await expect(
      executeArtifactTool("presentations.create", args, createConfig(root), {
        presentationPackageAuditor: audit,
        request: groundedRequest(args),
      }),
    ).rejects.toThrow("failed structural validation after one deterministic repair");

    expect(audit).toHaveBeenCalledTimes(2);
    expect(writes()).toBe(2);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("repairs a comparison layout that exceeds its rendered two-column geometry", async () => {
    const root = createRoot();
    const output = path.join(root, "comparison-geometry-repair.pptx");
    const args = researchPresentationArgs(output);
    args.slides = [
      {
        title: "Comparison",
        archetype: "comparison",
        bullets: Array.from({ length: 5 }, (_, index) => ({
          text: realisticLongBullet(`Comparison ${index + 1}:`, 170),
          claimKind: "fact",
          sourceIds: ["official-example"],
        })),
      },
    ];

    const result = await executeArtifactTool("presentations.create", args, createConfig(root), {
      request: groundedRequest(args),
    });

    expect(fs.existsSync(output)).toBe(true);
    expect(result).toMatchObject({
      packageAudit: { passed: true },
      designReport: { designQuality: { retryAttempted: true } },
    });
  }, 20_000);

  it("fails closed when a closing callout still exceeds rendered geometry after one repair", async () => {
    const root = createRoot();
    const output = path.join(root, "closing-geometry-double-fail.pptx");
    const args = researchPresentationArgs(output);
    args.slides = [
      {
        title: "Closing",
        archetype: "closing",
        bullets: [
          {
            text: realisticLongBullet("Closing recommendation:", 218),
            claimKind: "fact",
            sourceIds: ["official-example"],
          },
        ],
      },
    ];

    await expect(
      executeArtifactTool("presentations.create", args, createConfig(root), {
        request: groundedRequest(args),
      }),
    ).rejects.toThrow("failed structural validation after one deterministic repair");

    expect(fs.existsSync(output)).toBe(false);
  }, 20_000);

  it("treats polished layout-diversity findings as fatal before file output", async () => {
    const root = createRoot();
    const output = path.join(root, "repetitive-layout.pptx");
    const slides = Array.from({ length: 8 }, (_, index) => ({
      title: `Topic ${index + 1}`,
      archetype: "narrative",
      bullets: ["One short statement that repeats the same analytical layout family."],
    }));

    await expect(
      executeArtifactTool(
        "presentations.create",
        { path: output, title: "Repetitive Deck", slides },
        createConfig(root),
      ),
    ).rejects.toThrow("Presentation layout validation failed");

    expect(fs.existsSync(output)).toBe(false);
  });
});

function installMemoryRenderer(): () => number {
  let writeCount = 0;
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
        slide.addText = () => slide;
        slide.addTable = () => slide;
        slide.addChart = () => slide;
        slide.addNotes = () => slide;
        return slide;
      }

      public async write() {
        writeCount += 1;
        return Buffer.from(`PKmock-${writeCount}`);
      }
    },
  }));
  return () => writeCount;
}

function auditReport(passed: boolean, id = "none"): PresentationPackageAuditReport {
  return {
    passed,
    findings: passed ? [] : [{ id, message: "Synthetic structural defect.", repairable: true }],
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

function researchPresentationArgs(output: string): Record<string, unknown> {
  return {
    path: output,
    title: "Audited Research",
    research: {
      asOfDate: "2026-08-07",
      geography: "North America",
      physicalDigitalBoundary: "Physical products are primary; digital is adjacent.",
      inclusionCriteria: ["Active retail distribution"],
      exclusions: ["Inactive products"],
      methodology: ["Official source review"],
      limitations: ["Public evidence only"],
      competitors: ["Example"],
      comparisonCriteria: ["Player fit"],
    },
    sources: [
      {
        id: "official-example",
        title: "Official source",
        url: "https://example.com/official",
        publisher: "Example",
        role: "official",
      },
    ],
    slides: [
      {
        title: "Finding",
        bullets: [{ text: "Official support is active.", claimKind: "fact", sourceIds: ["official-example"] }],
      },
    ],
  };
}

function groundedRequest(args: Record<string, unknown>): ToolInvokeRequest {
  return {
    toolName: "presentations.create",
    args,
    agentId: "presentation-runtime-test-agent",
    sessionId: "presentation-runtime-test-session",
    presentationGrounding: {
      sourceTermCount: 1,
      matchedSourceTermCount: 1,
      sourceUrlCount: 1,
      matchedSourceUrlCount: 1,
    },
  };
}

function createRoot(): string {
  const root = path.join(os.tmpdir(), `goatcitadel-presentation-runtime-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  createdRoots.push(root);
  return root;
}

function realisticLongBullet(prefix: string, length: number): string {
  return `${prefix} ${"evidence remains specific, attributable, readable, and useful for the intended audience. ".repeat(4)}`.slice(
    0,
    length,
  );
}

function createConfig(root: string): ToolPolicyConfig {
  return {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [root],
      readOnlyRoots: [root],
      networkAllowlist: ["example.com"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}
