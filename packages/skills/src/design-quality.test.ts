import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasBlockingDesignQualityFindings, readDesignQualityEvidence } from "./design-quality.js";
import { enumerateSkillRoutes, IMPECCABLE_SKILL_ID, IMPECCABLE_SKILL_NAME } from "./skill-module-routes.js";

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
    const ids = snapshot.checks.map((check) => check.id);
    expect(ids).toContain("impeccable.modules");
    expect(ids).toContain("impeccable.provenance");
    expect(ids).toContain("impeccable.launcher-strings");
    expect(ids).toContain("impeccable.artifacts-budget");
    expect(ids).toContain("design-quality.proof-lanes");
    expect(ids.some((id) => id.startsWith("design-intelligence."))).toBe(false);
    expect(hasBlockingDesignQualityFindings(snapshot)).toBe(false);
  });

  it("blocks when a required impeccable module is missing", async () => {
    const root = await createFixture({ omitSkillModule: "reference/craft-floor.md" });

    const snapshot = readDesignQualityEvidence(root);

    expect(snapshot.summary.blockingCount).toBeGreaterThan(0);
    expect(snapshot.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "impeccable.modules",
          severity: "P0",
          status: "blocking",
          nextAction: expect.stringContaining("reference/craft-floor.md"),
        }),
      ]),
    );
    expect(hasBlockingDesignQualityFindings(snapshot)).toBe(true);
  });

  it("requires every module a skill route injects, not only the hand-picked ones", async () => {
    const root = await createFixture({ omitSkillModule: "reference/bolder.md" });

    const check = readDesignQualityEvidence(root).checks.find((item) => item.id === "impeccable.modules");

    expect(check).toMatchObject({ severity: "P0", status: "blocking" });
    expect(check?.nextAction).toContain("reference/bolder.md");
  });

  it("blocks unresolved local links in the impeccable skill", async () => {
    const root = await createFixture({ skillAppend: "\n[Missing module](./missing-module.md)\n" });

    const snapshot = readDesignQualityEvidence(root);

    expect(snapshot.summary.blockingCount).toBeGreaterThan(0);
    expect(snapshot.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "impeccable.placeholders",
          severity: "P0",
          status: "blocking",
          nextAction: expect.stringContaining("broken-link:./missing-module.md"),
        }),
      ]),
    );
  });

  it("blocks when the vendored provenance files are missing", async () => {
    const root = await createFixture({ omitProvenanceFile: "NOTICE" });

    const check = readDesignQualityEvidence(root).checks.find((item) => item.id === "impeccable.provenance");

    expect(check).toMatchObject({ severity: "P0", status: "blocking" });
    expect(check?.nextAction).toContain("NOTICE");
  });

  it("blocks when UPSTREAM.md does not pin a commit", async () => {
    const root = await createFixture({ upstreamText: "# Upstream provenance: impeccable\n- Commit: `main`\n" });

    const check = readDesignQualityEvidence(root).checks.find((item) => item.id === "impeccable.provenance");

    expect(check).toMatchObject({ severity: "P0", status: "blocking" });
    expect(check?.nextAction).toContain("commit");
  });

  it("blocks launcher or banned provider strings in the injectable files", async () => {
    const root = await createFixture({ skillAppend: "\nRun `npx impeccable detect` first.\n" });

    const check = readDesignQualityEvidence(root).checks.find((item) => item.id === "impeccable.launcher-strings");

    expect(check).toMatchObject({ severity: "P0", status: "blocking" });
    expect(check?.nextAction).toContain("npx impeccable");
  });

  it("catches the launcher behind npx options such as -y", async () => {
    const root = await createFixture({ skillAppend: "\nRun `npx -y impeccable` to set up.\n" });

    const check = readDesignQualityEvidence(root).checks.find((item) => item.id === "impeccable.launcher-strings");

    expect(check).toMatchObject({ severity: "P0", status: "blocking" });
  });

  it("scans only the injectable files, not the provenance notes that document the launcher", async () => {
    const root = await createFixture({
      upstreamText:
        "# Upstream provenance: impeccable\n- Commit: `c63b8dd7dd5a5f3c32eaabe1af76d0694f863ed2`\n- The `{{scripts_path}}` placeholder and `npx impeccable` launcher steps are removed by the sync.\n",
    });

    const check = readDesignQualityEvidence(root).checks.find((item) => item.id === "impeccable.launcher-strings");

    expect(check).toMatchObject({ severity: "P3", status: "passing" });
  });

  it("reports an oversized artifacts module as advisory, measuring UTF-8 bytes rather than string length", async () => {
    // 4,200 two-byte characters: 8,400 bytes but a string length well under 8 KiB.
    const root = await createFixture({ artifactsPadding: "é".repeat(4200) });

    const check = readDesignQualityEvidence(root).checks.find((item) => item.id === "impeccable.artifacts-budget");

    expect(check).toMatchObject({ severity: "P1", status: "advisory" });
    expect(check?.nextAction).toContain("8 KiB");
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

// Every module any impeccable route injects, read from the same route table the runtime uses.
const IMPECCABLE_MODULES: Array<[string, string]> = [
  ...new Set(
    enumerateSkillRoutes({ skillId: IMPECCABLE_SKILL_ID, skillName: IMPECCABLE_SKILL_NAME }).flatMap((route) =>
      route.modules.map((module) => module.relativePath),
    ),
  ),
]
  .filter((relativePath) => relativePath !== "SKILL.md")
  .map((relativePath) => [relativePath, `# ${path.basename(relativePath, ".md")}\nModule text.`]);

async function createFixture(
  options: {
    omitSkillModule?: string;
    omitProvenanceFile?: "UPSTREAM.md" | "LICENSE" | "NOTICE";
    upstreamText?: string;
    artifactsPadding?: string;
    appSource?: string;
    skillAppend?: string;
  } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-design-quality-"));
  tempRoots.push(root);
  const skillDir = path.join(root, "skills", "bundled", "impeccable");
  const stylesDir = path.join(root, "apps", "mission-control-next", "src", "styles");
  const appDir = path.join(root, "apps", "mission-control-next", "src");
  const sharedDir = path.join(root, "packages", "mission-control-shared", "src");
  const skillsSrcDir = path.join(root, "packages", "skills", "src");

  await fs.mkdir(path.join(skillDir, "reference", "critique"), { recursive: true });
  await fs.mkdir(stylesDir, { recursive: true });
  await fs.mkdir(appDir, { recursive: true });
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.mkdir(skillsSrcDir, { recursive: true });

  const skillText = [
    "---",
    "name: impeccable",
    "description: Design work.",
    "---",
    "> Vendored from pbakaus/impeccable at a pinned commit.",
    "Read the workspace PRODUCT.md and DESIGN.md first.",
    "Core principles:",
    "Not available in this vendored build: `craft`, `live`, `generate`.",
    options.skillAppend ?? "",
  ].join("\n");
  const modules: Array<[string, string]> = [["SKILL.md", skillText], ...IMPECCABLE_MODULES];
  for (const [file, content] of modules) {
    if (file === options.omitSkillModule) continue;
    const body =
      file === "reference/artifacts.md" && options.artifactsPadding
        ? `${content}\n${options.artifactsPadding}`
        : content;
    await fs.mkdir(path.dirname(path.join(skillDir, file)), { recursive: true });
    await fs.writeFile(path.join(skillDir, file), body, "utf8");
  }
  const provenance: Array<[string, string]> = [
    [
      "UPSTREAM.md",
      options.upstreamText ??
        "# Upstream provenance: impeccable\n- Commit: `c63b8dd7dd5a5f3c32eaabe1af76d0694f863ed2`\n",
    ],
    ["LICENSE", "Apache License 2.0"],
    ["NOTICE", "Vendored with modifications."],
  ];
  for (const [file, content] of provenance) {
    if (file === options.omitProvenanceFile) continue;
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
    "design quality anti-slop visual polish design-system audit document design presentation design pptx deck html artifact",
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

describe("craft-floor advisory scan", () => {
  it("reports cockpit and shared-component hits as an advisory with per-rule counts", async () => {
    const root = await createFixture();
    const cockpitDir = path.join(root, "apps", "mission-control-next", "src", "cockpit", "areas", "work");
    await fs.mkdir(cockpitDir, { recursive: true });
    await fs.writeFile(
      path.join(cockpitDir, "Panel.tsx"),
      'export const Panel = () => <div className="backdrop-blur-md"><p className="eyebrow">Work</p></div>;\n',
      "utf8",
    );

    const snapshot = readDesignQualityEvidence(root);
    const check = snapshot.checks.find((item) => item.id === "mission-control.craft-floor.scan");

    expect(snapshot.summary.blockingCount).toBe(0);
    expect(check).toMatchObject({ severity: "P2", status: "advisory", owner: "mission-control-next" });
    expect(check?.nextAction).toContain("glass-by-default: 1");
    expect(check?.nextAction).toContain("kicker-eyebrow: 1");
  });

  it("ignores the retiring Classic shell and passes a clean cockpit", async () => {
    const root = await createFixture();
    const classicDir = path.join(root, "apps", "mission-control-next", "src", "features", "native-routes", "work");
    await fs.mkdir(classicDir, { recursive: true });
    await fs.writeFile(
      path.join(classicDir, "Legacy.tsx"),
      'export const Legacy = () => <div className="backdrop-blur-md" />;\n',
      "utf8",
    );

    const check = readDesignQualityEvidence(root).checks.find((item) => item.id === "mission-control.craft-floor.scan");

    expect(check).toMatchObject({ severity: "P3", status: "passing" });
  });
});

describe("raw-color budget token sources", () => {
  const palette = Array.from(
    { length: 100 },
    (_, index) => `  --c-${index}: #${(index + 0x100000).toString(16)};`,
  ).join("\n");
  const rawColorCheck = (root: string) =>
    readDesignQualityEvidence(root).checks.find((check) => check.id === "mission-control.raw-color-budget");

  it("treats the dedicated cockpit token file as a token source", async () => {
    const root = await createFixture();
    const cockpitStyles = path.join(root, "apps", "mission-control-next", "src", "cockpit", "styles");
    await fs.mkdir(cockpitStyles, { recursive: true });
    await fs.writeFile(path.join(cockpitStyles, "cockpit-tokens.css"), `:root {\n${palette}\n}\n`, "utf8");
    expect(rawColorCheck(root)?.status).toBe("passing");
  });

  it("still counts raw colors in every other cockpit stylesheet, including a look-alike name", async () => {
    for (const name of ["cockpit.css", "not-cockpit-tokens.css"]) {
      const root = await createFixture();
      const cockpitStyles = path.join(root, "apps", "mission-control-next", "src", "cockpit", "styles");
      await fs.mkdir(cockpitStyles, { recursive: true });
      await fs.writeFile(path.join(cockpitStyles, name), `:root {\n${palette}\n}\n`, "utf8");
      expect(rawColorCheck(root)?.status, name).toBe("blocking");
    }
  });
});
