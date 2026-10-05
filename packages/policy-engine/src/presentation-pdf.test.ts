import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { createArtifactDesignPlan } from "./artifact-design.js";
import { measureWinAnsi, toWinAnsiBytes, wrapWinAnsi } from "./pdf-writer.js";
import { createPresentationPdf } from "./presentation-pdf.js";
import type { PresentationSlide, PresentationSource } from "./presentation-model.js";
import { executeArtifactTool } from "./tool-executor/artifact-executor.js";

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const SOURCES: PresentationSource[] = [
  {
    id: "official",
    title: "Official listing",
    url: "https://example.com/official",
    publisher: "Example",
    role: "official",
  },
];

describe("pdf writer text primitives", () => {
  it("encodes typographic punctuation as WinAnsi bytes and drops pictographs", () => {
    expect(toWinAnsiBytes("“Hi” – café 🎉 → ok")).toBe("\x93Hi\x94 \x96 caf\xe9  -> ok");
  });

  it("measures with Helvetica metrics and wraps within the width", () => {
    expect(measureWinAnsi("Hello", "regular", 10)).toBeCloseTo(22.78, 2);
    const lines = wrapWinAnsi(
      toWinAnsiBytes("The quick brown fox jumps over the lazy dog ".repeat(6)),
      "regular",
      16,
      300,
    );
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(measureWinAnsi(line, "regular", 16)).toBeLessThanOrEqual(300);
  });
});

describe("createPresentationPdf", () => {
  it("renders one valid landscape page per slide with text, citations and links", async () => {
    const slides: PresentationSlide[] = [
      {
        title: "Evening Picks",
        bullets: [
          { text: "Westfield Topanga is open until 7 PM on Sunday.", claimKind: "fact", sourceIds: ["official"] },
          "Catch a late movie or grab dinner nearby.",
        ],
      },
      {
        title: "Venue Comparison",
        archetype: "matrix",
        bullets: [],
        table: {
          headers: [{ text: "Venue" }, { text: "Closes" }],
          rows: [
            [{ text: "Westfield Topanga" }, { text: "7 PM", sourceIds: ["official"] }],
            [{ text: "Village at Topanga" }, { text: "9 PM" }],
          ],
        },
      },
      {
        title: "Crowd Levels",
        archetype: "chart",
        bullets: [],
        chart: {
          type: "column",
          categories: ["6 PM", "8 PM", "10 PM"],
          series: [{ name: "Visitors", values: [120, 340, 90] }],
        },
      },
      {
        title: "Sources",
        archetype: "sources",
        generatedSourceAppendix: true,
        bullets: [{ text: "Example: Official listing — https://example.com/official", sourceIds: ["official"] }],
      },
    ];

    const result = await createPresentationPdf({
      title: "Tonight near 91303",
      subtitle: "Fun things to do this evening",
      slides,
      sources: SOURCES,
      design: designFor("Tonight near 91303", slides),
    });

    const pdf = result.buffer.toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expectValidXref(result.buffer);
    expect(pdf.match(/\/Type \/Page /gu)).toHaveLength(slides.length + 1);
    expect(pdf).toContain("/MediaBox [0 0 960 540]");
    expect(pdf).toContain("/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding");
    expect(pdf).toContain("/URI (https://example.com/official)");
    const text = contentStreams(result.buffer).join("\n");
    expect(text).toContain("(Tonight near 91303)");
    expect(text).toContain("(Westfield Topanga)");
    expect(text).toContain("([S1])");
    expect(result.layoutNames[0]).toBe("hero");
    expect(result.manifest).toMatchObject({ slideCount: 5, tableCount: 1, chartCount: 1, sourceCount: 1 });
    expect(result.warnings).toEqual([]);
  });

  it("embeds a provided cover visual as a JPEG image XObject", async () => {
    const png = await sharp({ create: { width: 40, height: 30, channels: 4, background: "#ff000080" } })
      .png()
      .toBuffer();
    const slides: PresentationSlide[] = [{ title: "Plan", bullets: ["Pick one activity."] }];

    const result = await createPresentationPdf({
      title: "Visual Deck",
      slides,
      sources: [],
      design: designFor("Visual Deck", slides),
      visualAssets: [{ slideIndex: 0, asset: { bytesBase64: png.toString("base64"), mimeType: "image/png" } }],
    });

    const pdf = result.buffer.toString("latin1");
    expect(pdf).toContain("/Subtype /Image /Width 40 /Height 30");
    expect(pdf).toContain("/Filter /DCTDecode");
    expect(contentStreams(result.buffer)[0]).toContain("/Im0 Do");
    expect(result.manifest.visualCount).toBe(1);
  });

  it("skips an undecodable visual with a warning and still renders", async () => {
    const slides: PresentationSlide[] = [{ title: "Plan", bullets: ["Pick one activity."] }];

    const result = await createPresentationPdf({
      title: "Broken Visual",
      slides,
      sources: [],
      design: designFor("Broken Visual", slides),
      visualAsset: { bytesBase64: Buffer.from("not an image").toString("base64") },
    });

    expect(result.warnings.join(" ")).toMatch(/Skipped the visual for slide 1/u);
    expect(result.buffer.toString("latin1")).not.toContain("/Subtype /Image");
    expect(result.manifest.visualCount).toBe(0);
  });

  it("warns instead of overflowing when a slide holds more text than fits", async () => {
    const slides: PresentationSlide[] = [
      {
        title: "Everything",
        bullets: Array.from(
          { length: 30 },
          (_, index) => `Item ${index + 1}: ${"a long descriptive clause ".repeat(6)}`,
        ),
      },
    ];

    const result = await createPresentationPdf({
      title: "Overflow",
      slides,
      sources: [],
      design: designFor("Overflow", slides),
    });

    expect(result.warnings.join(" ")).toMatch(/Slide 2 text was shortened to fit the page/u);
  });
});

describe("presentations.create PDF output", () => {
  it("writes a deck-style PDF when format is pdf, correcting a .pptx extension", async () => {
    const root = createRoot();
    const result = await executeArtifactTool(
      "presentations.create",
      {
        path: path.join(root, "tonight.pptx"),
        format: "pdf",
        title: "Tonight near 91303",
        slides: [
          { title: "Evening Picks", bullets: ["Westfield Topanga is open until 7 PM.", "Grab dinner nearby."] },
          { title: "Late Options", bullets: ["Catch a late movie.", "Walk the outdoor promenade."] },
        ],
      },
      createConfig(root),
    );

    const output = path.join(root, "tonight.pdf");
    expect(result).toMatchObject({
      path: output,
      format: "pdf",
      mimeType: "application/pdf",
      renderer: "native-pdf",
      slideCount: 3,
    });
    expect(fs.readFileSync(output).subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(fs.existsSync(path.join(root, "tonight.pptx"))).toBe(false);
    const validation = (result.designReport as { validation: Array<{ id: string; status: string }> }).validation;
    expect(validation.find((check) => check.id === "pdf-render")?.status).toBe("passed");
    expect(validation.some((check) => check.id === "pptx-package")).toBe(false);
  });

  it("infers PDF output from a .pdf path", async () => {
    const root = createRoot();
    const result = await executeArtifactTool(
      "presentations.create",
      { path: path.join(root, "deck.pdf"), title: "Deck", slides: [{ title: "One", bullets: ["A clear point."] }] },
      createConfig(root),
    );

    expect(result).toMatchObject({ format: "pdf", path: path.join(root, "deck.pdf") });
  });

  it("rejects an unsupported deck format before writing", async () => {
    const root = createRoot();
    await expect(
      executeArtifactTool(
        "presentations.create",
        {
          path: path.join(root, "deck.key"),
          format: "keynote",
          title: "Deck",
          slides: [{ title: "One", bullets: ["A clear point."] }],
        },
        createConfig(root),
      ),
    ).rejects.toThrow('presentations.create format must be "pptx" or "pdf"');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

function designFor(title: string, slides: PresentationSlide[]) {
  return createArtifactDesignPlan({
    kind: "presentation",
    title,
    format: "pdf",
    slides: slides.map((slide) => ({
      title: slide.title,
      bullets: slide.bullets.map((bullet) => (typeof bullet === "string" ? bullet : bullet.text)),
    })),
  });
}

function contentStreams(buffer: Buffer): string[] {
  const pdf = buffer.toString("latin1");
  const streams: string[] = [];
  const pattern = /<<([^]*?)>>\nstream\n/gu;
  for (let match = pattern.exec(pdf); match; match = pattern.exec(pdf)) {
    const length = Number(/\/Length (\d+)/u.exec(match[1] ?? "")?.[1]);
    if (/\/Subtype \/Image/u.test(match[1] ?? "")) continue;
    const start = match.index + match[0].length;
    const raw = buffer.subarray(start, start + length);
    streams.push((/\/FlateDecode/u.test(match[1] ?? "") ? inflateSync(raw) : raw).toString("latin1"));
  }
  return streams;
}

function expectValidXref(buffer: Buffer): void {
  const pdf = buffer.toString("latin1");
  const startxref = Number(/startxref\n(\d+)\n%%EOF/u.exec(pdf)?.[1]);
  expect(pdf.slice(startxref, startxref + 4)).toBe("xref");
  const [, countText] = /^xref\n0 (\d+)\n/u.exec(pdf.slice(startxref)) ?? [];
  const count = Number(countText);
  const entries = pdf
    .slice(startxref)
    .split("\n")
    .slice(3, 3 + count - 1);
  entries.forEach((entry, index) => {
    const offset = Number(entry.slice(0, 10));
    expect(pdf.slice(offset, offset + 12)).toMatch(new RegExp(`^${index + 1} 0 obj\\n`, "u"));
  });
}

function createRoot(): string {
  const root = path.join(os.tmpdir(), `goatcitadel-presentation-pdf-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
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
