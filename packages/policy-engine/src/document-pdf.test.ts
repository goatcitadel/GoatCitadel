import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { createArtifactDesignPlan } from "./artifact-design.js";
import { createDocumentPdf, createPlainDocumentPdf, formatLocalDate, type DocumentPdfSection } from "./document-pdf.js";
import { executeArtifactTool } from "./tool-executor/artifact-executor.js";

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const SECTIONS: DocumentPdfSection[] = [
  { heading: "Summary", body: "Los Angeles trails grouped by the kind of day you want.", bullets: [] },
  {
    heading: "Iconic city hikes",
    body: "",
    bullets: ["Hollywood Sign: about 6 miles, moderate", "Griffith Observatory loop: about 2.5 miles"],
  },
  { heading: "Serious summits", body: "Start early and carry extra water.", bullets: ["Mt. Baldy", "San Gorgonio"] },
];

describe("createDocumentPdf", () => {
  it("draws the cover band and accents in the brand colors", () => {
    const design = createArtifactDesignPlan({
      kind: "pdf",
      title: "Best Hiking Trails in Los Angeles",
      format: "pdf",
      design: { mode: "polished", brand: { name: "LA Trail Guide", colors: ["#1F5E4B", "#E07A3F"] } },
    });
    const pdf = createDocumentPdf({ title: "Best Hiking Trails in Los Angeles", sections: SECTIONS, design });
    const streams = contentStreams(pdf.buffer).join("\n");

    expect(pdf.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // #1F5E4B already gives white text 4.5:1, so the band keeps the exact brand color.
    expect(streams).toContain("0.122 0.369 0.294 rg");
    expect(streams).toContain("(REPORT) Tj");
    expect(streams).toContain("(Iconic city hikes) Tj");
    expect(streams).toContain("(Hollywood Sign: about 6 miles, moderate) Tj");
    expect(pdf.layouts).toEqual(["report-cover", "callout-box", "title-body"]);
    expect(pdf.warnings).toEqual([]);
  });

  it("prints the cover date as the local day, not the UTC day", () => {
    const design = createArtifactDesignPlan({
      kind: "pdf",
      title: "Late",
      format: "pdf",
      design: { mode: "polished" },
    });
    // 01:32Z on Nov 1 is still the evening of Oct 31 in Los Angeles.
    const createdAt = new Date("2026-11-01T01:32:00Z");
    const pdf = createDocumentPdf({
      title: "Late",
      sections: SECTIONS,
      design,
      createdAt,
      timeZone: "America/Los_Angeles",
    });
    const streams = contentStreams(pdf.buffer).join("\n");

    expect(streams).toContain("(2026-10-31) Tj");
    expect(streams).not.toContain("(2026-11-01) Tj");
    expect(formatLocalDate(createdAt, "UTC")).toBe("2026-11-01");
    expect(formatLocalDate(createdAt, "Not/AZone")).toBe(formatLocalDate(createdAt));
  });

  it("darkens a light accent until white cover text reaches 4.5:1", () => {
    const design = createArtifactDesignPlan({
      kind: "pdf",
      title: "Light Accent",
      format: "pdf",
      design: { mode: "polished", brand: { colors: ["#7DD3FC"] } },
    });
    const pdf = createDocumentPdf({ title: "Light Accent", sections: SECTIONS, design });
    const coverBand = /q ([\d. ]+) rg 0 492 612 300 re f Q/u.exec(contentStreams(pdf.buffer)[0] ?? "");

    expect(coverBand).not.toBeNull();
    const [r, g, b] = (coverBand?.[1] ?? "").split(" ").map(Number) as [number, number, number];
    expect(contrastWithWhite(r, g, b)).toBeGreaterThanOrEqual(4.5);
  });

  it("paginates rows as a table and repeats the header on each page", () => {
    const design = createArtifactDesignPlan({ kind: "pdf", title: "Trail Table", format: "pdf" });
    const rows = Array.from({ length: 60 }, (_, index) => ({
      Trail: `Trail number ${index + 1}`,
      Distance: `${index + 2} miles`,
      Difficulty: index % 3 === 0 ? "Hard" : "Moderate",
    }));
    const pdf = createDocumentPdf({ title: "Trail Table", sections: [], rows, design });
    const pagesWithHeader = contentStreams(pdf.buffer).filter((stream) => stream.includes("(Distance) Tj"));

    expect(pdf.layouts).toEqual(["report-cover", "data-table"]);
    expect(pdf.pageCount).toBeGreaterThan(1);
    expect(pagesWithHeader.length).toBe(pdf.pageCount);
    expect(contentStreams(pdf.buffer).join("\n")).toContain("(Trail number 60) Tj");
  });

  it("warns about characters the Latin font cannot show", () => {
    const design = createArtifactDesignPlan({ kind: "pdf", title: "Emoji", format: "pdf" });
    const pdf = createDocumentPdf({ title: "Trails \u{1F97E}", sections: SECTIONS, design });

    expect(pdf.warnings).toEqual([expect.stringContaining("1 character(s)")]);
  });

  it("keeps white cover text at 4.5:1 on a dark preset whose text token is light", () => {
    const design = createArtifactDesignPlan({
      kind: "pdf",
      title: "Ops",
      format: "pdf",
      design: { mode: "polished", preset: "cyberpunk-ops" },
    });
    const pdf = createDocumentPdf({ title: "Ops", sections: SECTIONS, design });
    const coverBand = /q ([\d. ]+) rg 0 492 612 300 re f Q/u.exec(contentStreams(pdf.buffer)[0] ?? "");
    const [r, g, b] = (coverBand?.[1] ?? "").split(" ").map(Number) as [number, number, number];

    expect(contrastWithWhite(r, g, b)).toBeGreaterThanOrEqual(4.5);
  });

  it("counts the cover audience line in the Latin warning", () => {
    const design = createArtifactDesignPlan({
      kind: "pdf",
      title: "Audience",
      format: "pdf",
      design: { mode: "polished", audience: "富士 hikers" },
    });
    const pdf = createDocumentPdf({ title: "Audience", sections: SECTIONS, design });

    expect(pdf.warnings).toEqual([expect.stringContaining("2 character(s)")]);
  });

  it("counts table cells in the Latin warning", () => {
    const design = createArtifactDesignPlan({ kind: "pdf", title: "Table", format: "pdf" });
    const rows = [{ Trail: "Mt. Baldy \u{1F3D4}", Note: "富士" }];
    const pdf = createDocumentPdf({ title: "Table", sections: [], rows, design });

    expect(pdf.warnings).toEqual([expect.stringContaining("3 character(s)")]);
  });

  it("keeps the bullets of a summary section promoted to the cover callout", () => {
    const design = createArtifactDesignPlan({ kind: "pdf", title: "Summary", format: "pdf" });
    const withBody = createDocumentPdf({
      title: "Summary",
      sections: [{ heading: "Summary", body: "Short overview.", bullets: ["Start early", "Carry water"] }],
      design,
    });
    const bulletsOnly = createDocumentPdf({
      title: "Summary",
      sections: [{ heading: "Overview", body: "", bullets: ["Only bullets here"] }],
      design,
    });
    const withBodyText = contentStreams(withBody.buffer).join("\n");
    const bulletsOnlyText = contentStreams(bulletsOnly.buffer).join("\n");

    expect(withBodyText).toContain("(Short overview.) Tj");
    expect(withBodyText).toContain("(Start early) Tj");
    expect(withBodyText).toContain("(Carry water) Tj");
    expect(bulletsOnlyText).toContain("(Overview) Tj");
    expect(bulletsOnlyText).toContain("(Only bullets here) Tj");
  });

  it("shortens a table cell taller than a page instead of drawing past the page", () => {
    const design = createArtifactDesignPlan({ kind: "pdf", title: "Long Cell", format: "pdf" });
    const rows = [
      { Trail: "Short", Notes: "Fine." },
      { Trail: "Long", Notes: Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ") },
    ];
    const pdf = createDocumentPdf({ title: "Long Cell", sections: [], rows, design });
    const baselines = contentStreams(pdf.buffer).flatMap((stream) =>
      [...stream.matchAll(/ (-?[\d.]+) Td \(/gu)].map((match) => Number(match[1])),
    );

    expect(pdf.warnings).toEqual([expect.stringContaining("1 table cell(s) were too long")]);
    // PDF y runs upward; the page footer sits at 792 - 760 = 32, so body text must stay above it.
    expect(Math.min(...baselines)).toBeGreaterThanOrEqual(32);
    expect(contentStreams(pdf.buffer).join("\n")).toContain("\x85) Tj");
  });

  it("keeps checkboxes, arrows, and non-Latin letters by embedding a fallback font (#504)", async () => {
    const design = createArtifactDesignPlan({ kind: "pdf", title: "Launch checklist", format: "pdf" });
    const lines = ["☐ Book the venue", "☑ Send invites → guests", "✓ Café für Жанна", "Ελληνικά ő ł ş"];
    const pdf = createDocumentPdf({
      title: "Launch checklist ☐",
      sections: [{ heading: "Tasks", body: "", bullets: lines }],
      design,
    });
    const text = await extractPdfText(pdf.buffer);

    // The bundled fonts have no Arrows block, so "→" keeps its readable ASCII stand-in.
    const expected = [...lines.map((line) => line.replace("→", "->")), "Launch checklist ☐"];
    for (const line of expected) expect(text).toContain(line);
    expect(pdf.warnings).toEqual([]);
    // Latin text keeps the standard Helvetica face; only the other characters use the embedded font.
    expect(contentStreams(pdf.buffer).join("\n")).toContain("(Tasks) Tj");
    expect(pdf.buffer.toString("latin1")).toMatch(/\/FontFile2 \d+ 0 R/u);
  });

  it("draws a visible substitute for characters no embedded font covers, and says so", async () => {
    const design = createArtifactDesignPlan({ kind: "pdf", title: "Unsupported", format: "pdf" });
    const pdf = createDocumentPdf({
      title: "Unsupported",
      sections: [{ heading: "Notes", body: "", bullets: ["Party 🎉 in 中文"] }],
      design,
    });
    const text = await extractPdfText(pdf.buffer);

    expect(text).toContain("Party � in ��");
    expect(pdf.warnings).toEqual([expect.stringContaining("3 character(s)")]);
    expect(pdf.warnings[0]).toContain("�");
  });

  it("keeps indentation and aligned spacing in plain PDFs, and the indent on wrapped lines", () => {
    const longIndented = `    ${Array.from({ length: 30 }, (_, index) => `step${index}`).join(" ")}`;
    const pdf = createPlainDocumentPdf("Plain", ["    run step", "name    value", "", longIndented, "Жанна ☐"]);
    const streams = contentStreams(pdf.buffer).join("\n");
    const wrappedLines = [...streams.matchAll(/Td \((\s*step[^)]*)\) Tj/gu)].map((match) => match[1] ?? "");

    expect(streams).toContain("(    run step) Tj");
    expect(streams).toContain("(name    value) Tj");
    expect(wrappedLines.length).toBeGreaterThan(1);
    for (const line of wrappedLines) expect(line.startsWith("    step")).toBe(true);
    expect(wrappedLines.join(" ").replace(/\s+/gu, " ").trim()).toBe(longIndented.trim());
    expect(pdf.warnings).toEqual([]);
  });
});

async function extractPdfText(buffer: Buffer): Promise<string> {
  // unpdf's bundled type declarations do not resolve under this package's settings, as in native-document-parser.ts.
  const { extractText, getDocumentProxy } = (await import("unpdf" as string)) as {
    extractText: (document: unknown, options: { mergePages: true }) => Promise<{ text: string }>;
    getDocumentProxy: (data: Uint8Array) => Promise<unknown>;
  };
  const document = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(document, { mergePages: true });
  return text;
}

describe("documents.create pdf design report", () => {
  it("reports the layouts the renderer drew and the design colors it used", async () => {
    const root = createRoot();
    const result = await executeArtifactTool(
      "documents.create",
      {
        path: path.join(root, "trails.pdf"),
        format: "pdf",
        title: "Best Hiking Trails in Los Angeles",
        sections: SECTIONS,
        rows: [{ Trail: "Mt. Baldy", Distance: "11 miles" }],
        design: { skillId: "impeccable", mode: "polished", brand: { colors: ["#1F5E4B"] } },
      },
      createConfig(root),
    );
    const report = result.designReport as Record<string, unknown>;

    expect(report.layouts).toEqual(["report-cover", "callout-box", "title-body", "data-table"]);
    expect(report.residualRisks).toContain(
      "PDF reports use Helvetica text and built-in color shapes, embedding bundled Noto glyphs only for characters Helvetica lacks; photos are not embedded, and emoji or CJK text is shown as a substitute glyph.",
    );
    expect(contentStreams(fs.readFileSync(path.join(root, "trails.pdf"))).join("\n")).toContain("0.122 0.369 0.294 rg");
  });

  it("shows body-only input once, but keeps an explicit section that repeats the body", async () => {
    const root = createRoot();
    const create = async (name: string, extra: Record<string, unknown>) => {
      const file = path.join(root, `${name}.pdf`);
      await executeArtifactTool(
        "documents.create",
        { path: file, format: "pdf", title: "Body Only", body: "One overview paragraph.", ...extra },
        createConfig(root),
      );
      return contentStreams(fs.readFileSync(file)).join("\n");
    };
    const occurrences = (text: string) => text.split("(One overview paragraph.) Tj").length - 1;

    const bodyOnly = await create("body-only", {});
    const explicit = await create("explicit", {
      sections: [{ heading: "Summary", body: "One overview paragraph.", bullets: [] }],
    });

    expect(occurrences(bodyOnly)).toBe(1);
    expect(bodyOnly).not.toContain("(Summary) Tj");
    expect(occurrences(explicit)).toBe(2);
    expect(explicit).toContain("(Summary) Tj");
  });

  it("keeps plain PDFs as unstyled text and says so", async () => {
    const root = createRoot();
    const result = await executeArtifactTool(
      "documents.create",
      {
        path: path.join(root, "plain.pdf"),
        format: "pdf",
        title: "Plain Notes",
        body: "Just the text.",
        design: { mode: "plain" },
      },
      createConfig(root),
    );
    const report = result.designReport as Record<string, unknown>;

    expect(report.layouts).toEqual(["plain-text"]);
    expect(report.residualRisks).toContain("Plain PDF output is unstyled text: no cover, color, callouts, or tables.");
  });

  it("renders long bullets in full and reports any text a limit still cuts", async () => {
    const root = createRoot();
    // A 247-character bullet like the one the old 220-character cap cut mid-sentence.
    const longBullet =
      "Why it matters: higher-trust people are likelier to help neighbors (82% vs 67% would bring in a neighbor's mail or water plants) and trust is associated with better economic and democratic functioning, though cause and effect are hard to separate.";
    const full = path.join(root, "long-bullets.pdf");
    const fits = await executeArtifactTool(
      "documents.create",
      {
        path: full,
        format: "pdf",
        title: "Long Bullets",
        sections: [{ heading: "Trust", bullets: [longBullet] }],
        design: { mode: "polished" },
      },
      createConfig(root),
    );
    const text = (await extractPdfText(fs.readFileSync(full))).replace(/\s+/gu, " ");

    expect(text).toContain("though cause and effect are hard to separate.");
    expect(fits.warnings).toBeUndefined();

    const cut = await executeArtifactTool(
      "documents.create",
      {
        path: path.join(root, "cut.pdf"),
        format: "pdf",
        title: "Cut",
        sections: [
          { heading: "Too long", bullets: ["x".repeat(1300), ...Array.from({ length: 13 }, (_, i) => `b${i}`)] },
        ],
        design: { mode: "polished" },
      },
      createConfig(root),
    );

    expect(cut.warnings).toEqual([
      "Some text is missing from the document: Cut 1 bullet(s) to 1200 characters. Dropped 2 bullet(s) past 12 per section. Split the content and write the document again.",
    ]);
    expect((cut.designReport as Record<string, unknown>).residualRisks).toEqual(
      expect.arrayContaining([expect.stringContaining("Some text is missing from the document")]),
    );
  });

  it("marks the design receipt injected only when a design skill was activated", async () => {
    const root = createRoot();
    const create = (skillId: string) =>
      executeArtifactTool(
        "documents.create",
        { path: path.join(root, `${randomUUID()}.pdf`), format: "pdf", title: "Receipt", sections: SECTIONS },
        createConfig(root),
        { request: requestWithSkill(skillId) },
      );

    const withDesign = designQuality(await create("bundled:impeccable"));
    const withResearchOnly = designQuality(await create("bundled:research"));
    const withNoRequest = designQuality(
      await executeArtifactTool(
        "documents.create",
        { path: path.join(root, "none.pdf"), format: "pdf", title: "Receipt", sections: SECTIONS },
        createConfig(root),
      ),
    );

    expect(withDesign.runtimeInstructions).toMatchObject({
      status: "injected",
      skills: [{ skillId: "bundled:impeccable" }],
    });
    expect(withResearchOnly.runtimeInstructions).toEqual({ status: "not_injected", skills: [] });
    expect(withNoRequest.runtimeInstructions).toEqual({ status: "not_injected", skills: [] });
  });
});

function designQuality(result: Record<string, unknown>): Record<string, unknown> {
  return (result.designReport as { designQuality: Record<string, unknown> }).designQuality;
}

function requestWithSkill(skillId: string): ToolInvokeRequest {
  return {
    toolName: "documents.create",
    args: {},
    agentId: "assistant",
    sessionId: "sess_document_pdf",
    runtimeSkillApplications: [
      { skillId, treeSha256: "a".repeat(64), instructionSha256: "b".repeat(64), modules: ["main"] },
    ],
  } as ToolInvokeRequest;
}

function contrastWithWhite(r: number, g: number, b: number): number {
  const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return 1.05 / (luminance + 0.05);
}

function contentStreams(buffer: Buffer): string[] {
  const pdf = buffer.toString("latin1");
  const streams: string[] = [];
  const pattern = /<<([^]*?)>>\nstream\n/gu;
  for (let match = pattern.exec(pdf); match; match = pattern.exec(pdf)) {
    const length = Number(/\/Length (\d+)/u.exec(match[1] ?? "")?.[1]);
    const start = match.index + match[0].length;
    const raw = buffer.subarray(start, start + length);
    streams.push((/\/FlateDecode/u.test(match[1] ?? "") ? inflateSync(raw) : raw).toString("latin1"));
  }
  return streams;
}

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-document-pdf-"));
  createdRoots.push(root);
  return root;
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
