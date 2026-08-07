import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzePresentationContentQuality,
  buildSyntheticPresentationCreateArgs,
  buildWorkspaceFileDownloadHref,
  getExecutedWorkspaceFileWriteReceipt,
  mergePresentationArtifactDeliveryContent,
  mergeWorkspaceFileDownloadContent,
} from "./artifact-write-helpers.js";

const research = `# Dating Across a Large Age Gap

## What helps
- Discuss life stage, children, career, retirement, caregiving, health, and long-term commitment explicitly.
- Keep decisions balanced so higher income or age does not silently become authority.
- Meet both social circles and choose activities that accommodate differences in energy and mobility.

## Watch especially for
- One partner controlling money, transportation, housing, social access, or major decisions.
- A parent-child or teacher-student dynamic replacing an adult partnership.
- Pressure to move faster because fertility, retirement, or health timelines differ.

## Practical check-ins
- Ask whether decisions feel balanced and whether the age difference is creating pressure.
- Preserve independent interests, friendships, and financial agency.

## Sources
- American Psychological Association — https://www.apa.org/topics/relationships`;

describe("thread-grounded presentation artifacts", () => {
  it("blocks a missing title when the supplied slides cannot be safely promoted", () => {
    const report = analyzePresentationContentQuality({
      content: "Create a one-slide PowerPoint about release readiness.",
      args: {
        path: "./workspace/goatcitadel_out/release-readiness.pptx",
        slides: [
          {
            title: "Release Readiness",
            bullets: ["Build is green", "Smoke tests passed", "Rollback is documented"],
          },
        ],
      },
    });

    expect(report.passed).toBe(false);
    expect(report.findings).toContain(
      "The deck is missing a specific title for the automatically generated title slide.",
    );
  });

  it("builds only jailed workspace download links and replaces stale sandbox links", () => {
    const workspaceRoot = path.resolve("workspace");
    const artifactPath = path.join(workspaceRoot, "goatcitadel_out", "funny jokes.pptx");
    const downloadHref = buildWorkspaceFileDownloadHref(artifactPath, workspaceRoot);
    const content = mergePresentationArtifactDeliveryContent(
      "Done. [Download](sandbox:/mnt/data/wrong.pptx)",
      {
        toolRunId: "tool-run-download",
        sessionId: "session-download",
        turnId: "turn-download",
        toolName: "presentations.create",
        status: "executed",
        result: { path: artifactPath, bytesWritten: 42, slideCount: 6 },
        startedAt: "2026-08-06T00:00:00.000Z",
        finishedAt: "2026-08-06T00:00:01.000Z",
      },
      { downloadHref },
    );

    expect(downloadHref).toBe("/api/v1/files/download?relativePath=goatcitadel_out%2Ffunny+jokes.pptx");
    expect(content).not.toContain("sandbox:/");
    expect(content).toContain(`[Download the PowerPoint](${downloadHref})`);
    expect(buildWorkspaceFileDownloadHref(path.resolve("..", "deck.pptx"), workspaceRoot)).toBeUndefined();
    expect(
      buildWorkspaceFileDownloadHref(path.join(workspaceRoot, "goatcitadel_out", "notes.txt"), workspaceRoot),
    ).toBe("/api/v1/files/download?relativePath=goatcitadel_out%2Fnotes.txt");
  });

  it("upgrades matching legacy sandbox links for governed document writes", () => {
    const workspaceRoot = path.resolve("workspace");
    const artifactPath = path.join(workspaceRoot, "goatcitadel_out", "research brief.docx");
    const toolRun = {
      toolRunId: "tool-run-document-download",
      sessionId: "session-download",
      turnId: "turn-download",
      toolName: "documents.create",
      status: "executed",
      result: { path: artifactPath, bytesWritten: 128 },
      startedAt: "2026-08-06T00:00:00.000Z",
      finishedAt: "2026-08-06T00:00:01.000Z",
    } as const;
    const downloadHref = buildWorkspaceFileDownloadHref(artifactPath, workspaceRoot);

    expect(getExecutedWorkspaceFileWriteReceipt(toolRun)).toEqual({ artifactPath, bytesWritten: 128 });
    expect(
      mergeWorkspaceFileDownloadContent(
        "Done. [Download the document](sandbox:/mnt/data/research%20brief.docx)",
        toolRun,
        downloadHref,
      ),
    ).toBe(`Done. [Download the document](${downloadHref})`);
    expect(
      mergeWorkspaceFileDownloadContent("Done. [Unrelated file](sandbox:/mnt/data/other.docx)", toolRun, downloadHref),
    ).toContain(`[Download the document](${downloadHref})`);
    expect(
      getExecutedWorkspaceFileWriteReceipt({
        ...toolRun,
        status: "failed",
      }),
    ).toBeUndefined();
  });

  it.each(["presentations.create", "documents.create", "artifacts.create", "fs.write"])(
    "recognizes executed %s output as a downloadable file receipt",
    (toolName) => {
      expect(
        getExecutedWorkspaceFileWriteReceipt({
          toolRunId: `tool-run-${toolName}`,
          sessionId: "session-download",
          turnId: "turn-download",
          toolName,
          status: "executed",
          result: { path: path.resolve("workspace", "goatcitadel_out", "output.bin"), bytesWritten: 64 },
          startedAt: "2026-08-06T00:00:00.000Z",
          finishedAt: "2026-08-06T00:00:01.000Z",
        }),
      ).toMatchObject({ bytesWritten: 64 });
    },
  );

  it("builds a subject-specific deck from prior assistant research without visible Cowork copy", () => {
    const historyMessages = [
      { role: "user" as const, content: "What should a 24-year-old and 48-year-old consider when dating?" },
      { role: "assistant" as const, content: research },
      { role: "user" as const, content: "Put all that information into a presentation." },
    ];
    const args = buildSyntheticPresentationCreateArgs({
      sessionId: "session-grounding",
      content: "Put all that information into a presentation.",
      historyMessages,
    });

    expect(args.title).toBe("Dating Across a 24-Year Age Gap");
    expect(args.slides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "What Helps" }),
        expect.objectContaining({ title: "Sources" }),
      ]),
    );
    expect(JSON.stringify(args)).not.toMatch(/Generated by GoatCitadel Cowork/i);
    expect(
      analyzePresentationContentQuality({
        args,
        content: "Put all that information into a presentation.",
        historyMessages,
      }),
    ).toMatchObject({ passed: true });
  });

  it("blocks prompt echo and generic template copy", () => {
    const historyMessages = [
      { role: "assistant" as const, content: research },
      { role: "user" as const, content: "Put all that information into a presentation." },
    ];
    const report = analyzePresentationContentQuality({
      content: "Put all that information into a presentation.",
      historyMessages,
      args: {
        title: "Presentation",
        slides: [
          {
            title: "Presentation",
            bullets: [
              "Summarizes the requested topic",
              "Keeps the deck concise",
              "Put all that information into a presentation",
            ],
          },
        ],
      },
    });
    expect(report.passed).toBe(false);
    expect(report.findings.join(" ")).toMatch(/generic|repeats|duplicates|grounded/i);
  });

  it("does not mistake a food product dating source URL and temperature values for relationship ages", () => {
    const historyMessages = [
      {
        role: "user" as const,
        content:
          "Research practical, evidence-backed ways for a household to reduce food waste. Organize the findings by measurement, shopping, storage, leftovers, and composting.",
      },
      {
        role: "assistant" as const,
        content: `## Shopping
- Interpret date labels correctly and buy realistic quantities of perishables.
- USDA FSIS, Food Product Dating: https://www.fsis.usda.gov/food-safety/food-product-dating

## Storage
- Keep the refrigerator at 40°F (4°C) and follow food-specific storage guidance.
- Refrigerate perishables within 2 hours, or 1 hour above 90°F (32°C).

## Leftovers
- Label leftovers and use refrigerated leftovers within 3–4 days.

## Composting
- Compost unavoidable scraps after prevention efforts.`,
      },
      { role: "user" as const, content: "Put all that information into a polished presentation." },
    ];

    const args = buildSyntheticPresentationCreateArgs({
      sessionId: "session-food-waste",
      content: "Put all that information into a polished presentation.",
      historyMessages,
    });

    expect(args.title).toBe("Reducing Household Food Waste");
    expect(args.title).not.toMatch(/dating|age gap/i);
    expect(args.slides).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Storage" })]));
    expect(JSON.stringify(args)).toContain("https://www.fsis.usda.gov/food-safety/food-product-dating");
    expect(
      analyzePresentationContentQuality({
        args,
        content: "Put all that information into a polished presentation.",
        historyMessages,
      }),
    ).toMatchObject({ sourceUrlCount: 1, matchedSourceUrlCount: 1 });
  });

  it("truncates long slide bullets at sentence or word boundaries", () => {
    const longSentence =
      "Avoid discarding food solely because a date has passed. Most date labels indicate quality rather than safety. Consult product-specific guidance when safety is uncertain. " +
      "This additional explanation is intentionally long enough to exceed the presentation bullet limit without ending in a clipped word fragment.";
    const historyMessages = [
      { role: "user" as const, content: "Research practical ways to reduce household food waste." },
      { role: "assistant" as const, content: `## Shopping\n- ${longSentence}` },
      { role: "user" as const, content: "Put all that information into a presentation." },
    ];

    const args = buildSyntheticPresentationCreateArgs({
      sessionId: "session-safe-truncation",
      content: "Put all that information into a presentation.",
      historyMessages,
    });
    const bullet = (args.slides as Array<{ bullets: string[] }>)[0]?.bullets[0];

    expect(bullet).toBeTruthy();
    expect(bullet).toMatch(/[.!?…]$/u);
    expect(bullet).not.toMatch(/\b(?:pr|produc|additio)$/iu);
  });

  it("blocks thin generic direct decks while allowing an explicitly requested one-slide brief", () => {
    const generic = analyzePresentationContentQuality({
      content: "Create a presentation about safe daily walking routines.",
      args: {
        title: "Overview",
        slides: [{ title: "Key Points", bullets: ["Walking is useful."] }],
      },
    });
    const boundedSingleSlide = analyzePresentationContentQuality({
      content: "Create one slide about safe daily walking routines.",
      args: {
        title: "A Safe Daily Walking Routine",
        slides: [
          {
            title: "Start Small and Progress Gradually",
            bullets: [
              "Choose a consistent time and comfortable route.",
              "Increase duration gradually and stop when symptoms make activity unsafe.",
            ],
          },
        ],
      },
    });

    expect(generic).toMatchObject({ passed: false });
    expect(generic.findings.join(" ")).toMatch(/generic|enough substantive/i);
    expect(boundedSingleSlide).toMatchObject({ passed: true });
  });
});
