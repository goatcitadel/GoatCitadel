import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasBlockingDesignQualityFindings, readDesignQualityEvidence } from "./design-quality.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("design-quality evidence", () => {
  it("passes a complete design-quality fixture", async () => {
    const root = await createFixture();

    const snapshot = readDesignQualityEvidence(root);

    expect(snapshot.state).toBe("available");
    expect(snapshot.summary.blockingCount).toBe(0);
    expect(snapshot.checks.map((check) => check.id)).toContain("design-intelligence.modules");
    expect(snapshot.checks.map((check) => check.id)).toContain("design-quality.proof-lanes");
    expect(hasBlockingDesignQualityFindings(snapshot)).toBe(false);
  });

  it("blocks when a required design-intelligence module is missing", async () => {
    const root = await createFixture({ omitSkillModule: "audit.md" });

    const snapshot = readDesignQualityEvidence(root);

    expect(snapshot.summary.blockingCount).toBeGreaterThan(0);
    expect(snapshot.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "design-intelligence.modules",
          severity: "P0",
          status: "blocking",
        }),
      ]),
    );
    expect(hasBlockingDesignQualityFindings(snapshot)).toBe(true);
  });

  it("blocks unresolved local links in the design-intelligence skill", async () => {
    const root = await createFixture({ skillAppend: "\n[Missing module](./missing-module.md)\n" });

    const snapshot = readDesignQualityEvidence(root);

    expect(snapshot.summary.blockingCount).toBeGreaterThan(0);
    expect(snapshot.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "design-intelligence.placeholders",
          severity: "P0",
          status: "blocking",
          nextAction: expect.stringContaining("broken-link:./missing-module.md"),
        }),
      ]),
    );
  });

  it("reports calibrated anti-slop hits as advisory evidence", async () => {
    const root = await createFixture({
      appSource: "export const hero = '#6366f1';",
    });

    const snapshot = readDesignQualityEvidence(root);

    expect(snapshot.summary.blockingCount).toBe(0);
    expect(snapshot.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mission-control.anti-slop.scan",
          severity: "P2",
          status: "advisory",
        }),
      ]),
    );
  });
});

async function createFixture(
  options: {
    omitSkillModule?: string;
    appSource?: string;
    skillAppend?: string;
  } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-design-quality-"));
  tempRoots.push(root);
  const skillDir = path.join(root, "skills", "bundled", "design-intelligence");
  const stylesDir = path.join(root, "apps", "mission-control-next", "src", "styles");
  const appDir = path.join(root, "apps", "mission-control-next", "src");
  const sharedDir = path.join(root, "packages", "mission-control-shared", "src");
  const skillsSrcDir = path.join(root, "packages", "skills", "src");

  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(stylesDir, { recursive: true });
  await fs.mkdir(appDir, { recursive: true });
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.mkdir(skillsSrcDir, { recursive: true });

  const skillText = [
    "---",
    "name: design-intelligence",
    "description: Design quality.",
    "---",
    "# Design Intelligence",
    "## Design Quality V1",
    "Start Iterate Polish Maintain",
    "surface intent design system/tokens craft rules Pre-Ship Loop five-dimension critique",
    options.skillAppend ?? "",
  ].join("\n");
  const modules: Array<[string, string]> = [
    ["SKILL.md", skillText],
    ["enforcement.md", "# Enforcement\nAccessible controls."],
    ["audit.md", "# Audit\nEvidence checks."],
    ["components.md", "# Components\nButtons."],
    ["layout.md", "# Layout\nResponsive."],
    ["taste.md", "# Taste\nCalibrated anti-slop."],
    ["assets.md", "# Assets\nIcons."],
    ["calibration.md", "# Calibration\nDials."],
    ["examples.md", "# Examples\nGood examples."],
  ];
  for (const [file, content] of modules) {
    if (file === options.omitSkillModule) continue;
    await fs.writeFile(path.join(skillDir, file), content, "utf8");
  }

  for (const file of [
    "mission-control-next-tokens.css",
    "mission-control-next-foundation.css",
    "mission-control-next.css",
  ]) {
    await fs.writeFile(path.join(stylesDir, file), ":root { --accent: oklch(70% 0.1 190); }\n", "utf8");
  }

  await fs.writeFile(path.join(appDir, "QualityCard.tsx"), options.appSource ?? "export const ok = true;\n", "utf8");
  await fs.writeFile(path.join(sharedDir, "index.ts"), "export const shared = true;\n", "utf8");
  await fs.writeFile(
    path.join(skillsSrcDir, "routing-hints.generated.ts"),
    "design quality anti-slop visual polish design-system audit",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: {
        "verify:design:quality": "pnpm tsx scripts/verify-design-quality.ts",
        "verify:surface:regression": "node scripts/verification/run.mjs surface-regression",
        "verify:visual:regression": "node scripts/verification/run.mjs visual-regression",
      },
    }),
    "utf8",
  );

  return root;
}
