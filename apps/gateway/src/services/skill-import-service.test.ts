import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillImportService } from "./skill-import-service.js";

function createSystemSettingsRepo() {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string): { value: T } | undefined {
      if (!store.has(key)) {
        return undefined;
      }
      return { value: store.get(key) as T };
    },
    set(key: string, value: unknown) {
      store.set(key, value);
    },
  };
}

describe("SkillImportService lookup", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-skill-lookup-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("resolves SkillsMP listing URLs into review-only lookup results", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("skillsmp.com/skills/")) {
        return new Response(
          '<html><body><a href="https://github.com/example/notebooklm-skill">repo</a></body></html>',
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.lookupSources("https://skillsmp.com/skills/example-notebooklm-skill", 5);

    expect(result.parsedSource).toMatchObject({
      sourceProvider: "skillsmp",
      sourceKind: "marketplace_listing",
      installability: "review_only",
      upstreamUrl: "https://github.com/example/notebooklm-skill",
    });
    expect(result.bestMatch).toMatchObject({
      name: "Example Notebooklm Skill",
      matchReason: "Direct listing match",
      installability: "review_only",
      upstreamUrl: "https://github.com/example/notebooklm-skill",
    });
  });

  it("resolves curated ClawHub listing URLs into review-only lookup results", async () => {
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.lookupSources("https://clawhub.ai/aiwithabidi/chrome-devtools-mcp", 5);

    expect(result.parsedSource).toMatchObject({
      sourceProvider: "clawhub",
      sourceKind: "marketplace_listing",
      installability: "review_only",
    });
    expect(result.bestMatch).toMatchObject({
      name: "Chrome Devtools Mcp",
      sourceProvider: "clawhub",
      installability: "review_only",
      skillFamily: "browser_automation",
    });
  });

  it("treats Animal House as a non-installable external reference", async () => {
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.lookupSources("https://animalhouse.ai/skills/animal-house", 5);

    expect(result.parsedSource).toMatchObject({
      sourceProvider: "external",
      sourceKind: "reference",
      installability: "not_installable",
      repositoryUrl: "https://github.com/geeks-accelerator/animal-house-ai",
    });
    expect(result.bestMatch).toMatchObject({
      name: "Animal House",
      sourceProvider: "external",
      installability: "not_installable",
    });
  });

  it("resolves Animal House repositoryUrl as a curated non-installable match", async () => {
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.lookupSources("https://github.com/geeks-accelerator/animal-house-ai", 5);

    expect(result.parsedSource).toMatchObject({
      sourceProvider: "external",
      sourceKind: "reference",
      installability: "not_installable",
    });
    expect(result.bestMatch).toMatchObject({
      name: "Animal House",
      sourceProvider: "external",
      installability: "not_installable",
    });
  });

  it("treats direct GitHub URLs as installable upstream sources", async () => {
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.lookupSources("https://github.com/example/playwright-skill", 5);

    expect(result.parsedSource).toMatchObject({
      sourceProvider: "github",
      sourceKind: "upstream_repo",
      installability: "direct",
    });
    expect(result.bestMatch).toMatchObject({
      sourceProvider: "github",
      installability: "direct",
      matchReason: "Direct source match",
    });
  });

  it("treats hosted skill.md URLs as direct installable bundles", async () => {
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.lookupSources("https://www.moltbook.com/skill.md", 5);

    expect(result.parsedSource).toMatchObject({
      sourceProvider: "external",
      sourceKind: "reference",
      installability: "direct",
      sourceUrl: "https://www.moltbook.com/skill.md",
    });
    expect(result.bestMatch).toMatchObject({
      sourceProvider: "external",
      installability: "direct",
      matchReason: "Direct source match",
    });
  });

  it("ranks Chrome Devtools MCP first for a 'chrome' query", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      return new Response("<html><body></body></html>", { status: 200 });
    }));

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.listSources("chrome", 5);

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]).toMatchObject({
      name: "Chrome Devtools Mcp",
    });
  });

  it("finds capability-style queries using deterministic ranking", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://skillsmp.com/") {
        return new Response(
          `
            <html>
              <body>
                <a href="/skills/playwright-interactive">Playwright</a>
                <a href="/skills/slides">Slides</a>
              </body>
            </html>
          `,
          { status: 200 },
        );
      }
      if (url === "https://agentskill.sh/") {
        return new Response(
          `
            <html>
              <body>
                <a href="/skills/doc-writer">Docs</a>
              </body>
            </html>
          `,
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.listSources("browser automation", 5);

    expect(result.items[0]).toMatchObject({
      skillFamily: "browser_automation",
      matchReason: "Capability match",
    });
  });
});

describe("SkillImportService validation", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-skill-validate-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("rejects not_installable curated sources at import time", async () => {
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    await expect(
      service.validateImport({
        sourceRef: "https://animalhouse.ai/skills/animal-house",
      }),
    ).rejects.toThrow(/not installable/i);
  });

  it("rejects not_installable sources via repositoryUrl match", async () => {
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    await expect(
      service.validateImport({
        sourceRef: "https://github.com/geeks-accelerator/animal-house-ai",
        sourceType: "git_url",
      }),
    ).rejects.toThrow(/not installable/i);
  });

  it("warns when the security scan skips oversized files", async () => {
    const skillDir = path.join(rootDir, "oversized-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: Oversized Audit Skill",
      "description: Valid fixture for security scan coverage.",
      "---",
      "",
      "Use this skill to validate import scanning.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n");
    fs.writeFileSync(path.join(skillDir, "bundle.js"), "a".repeat(230_000));

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.validateImport({
      sourceRef: skillDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });

    expect(result.valid).toBe(true);
    expect(result.riskLevel).toBe("medium");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Security scan skipped large files"),
      expect.stringContaining("bundle.js"),
    ]));
  });

  it("hard-blocks imports that overlap GoatCitadel native capability families", async () => {
    const skillDir = path.join(rootDir, "self-improving-agent-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: Self Improving Agent",
      "description: Keeps improving itself through continuous memory and rule updates.",
      "---",
      "",
      "Use this skill to improve future execution quality.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n");

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.validateImport({
      sourceRef: skillDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("native bounded memory-maintenance path for this family"),
    ]));
    expect(result.nativeOverlaps).toEqual([
      expect.objectContaining({
        overlapFamily: "safe_self_improvement",
        nativeAlternativeName: "Native memory maintenance",
        nativeDestination: "Observe > Artifacts > Memory",
      }),
    ]);
  });

  it("validates hosted skill bundles fetched from a raw skill.md URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://www.moltbook.com/skill.md") {
        return new Response([
          "---",
          "name: Moltbook",
          "description: Hosted skill bundle for joining and using Moltbook safely.",
          "---",
          "",
          "Follow the hosted instructions and store credentials locally.",
          "",
        ].join("\n"), { status: 200 });
      }
      if (url === "https://www.moltbook.com/skill.json") {
        return new Response('{"name":"moltbook"}', { status: 200 });
      }
      return new Response("", { status: 404 });
    }));

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.validateImport({
      sourceRef: "https://www.moltbook.com/skill.md",
    });

    expect(result.valid).toBe(true);
    expect(result.candidate).toMatchObject({
      sourceProvider: "external",
      sourceType: "remote_bundle",
      sourceRef: "https://www.moltbook.com/skill.md",
    });
    expect(result.inferredSkillName).toBe("Moltbook");
  });

  it("rejects curated overlap with GoatCitadel's bundled safe self-improvement skill", async () => {
    const skillDir = path.join(rootDir, "self-improving");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: Self Improving",
      "description: Iteratively review and improve the runtime by replaying prior work.",
      "---",
      "",
      "Review the repo and replay improvement cycles.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n");

    const service = new SkillImportService("F:/code/personal-ai", createSystemSettingsRepo() as never);
    await expect(service.validateImport({
      sourceRef: skillDir,
      sourceType: "local_path",
      sourceProvider: "local",
    })).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.stringContaining("native safe self-improvement bundle"),
      ]),
    });
  });

  it("blocks overlapping Cloudflare-family installs into skills/extra", async () => {
    const firstSkillDir = path.join(rootDir, "cloudflare-api");
    fs.mkdirSync(firstSkillDir, { recursive: true });
    fs.writeFileSync(path.join(firstSkillDir, "SKILL.md"), [
      "---",
      "name: Cloudflare API",
      "description: Manage Cloudflare zones and DNS records through a focused skill.",
      "---",
      "",
      "Use Cloudflare APIs to inspect and update DNS records.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(firstSkillDir, "LICENSE"), "MIT\n");

    const secondSkillDir = path.join(rootDir, "cloudflare-manager");
    fs.mkdirSync(secondSkillDir, { recursive: true });
    fs.writeFileSync(path.join(secondSkillDir, "SKILL.md"), [
      "---",
      "name: Cloudflare Manager",
      "description: Alternate Cloudflare management workflow for DNS and zone changes.",
      "---",
      "",
      "Manage Cloudflare resources and DNS state.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(secondSkillDir, "LICENSE"), "MIT\n");

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    await service.installImport({
      sourceRef: firstSkillDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });

    const validation = await service.validateImport({
      sourceRef: secondSkillDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('Duplicate skill family "cloudflare_dns"'),
      expect.stringContaining("skills/extra/cloudflare-api"),
    ]));
  });

  it("writes enriched source metadata for repo-managed installs", async () => {
    const skillDir = path.join(rootDir, "cloudflare-api");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: Cloudflare API",
      "description: Manage Cloudflare zones and DNS records through a focused skill.",
      "---",
      "",
      "Use Cloudflare APIs to inspect and update DNS records.",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n");

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const installed = await service.installImport({
      sourceRef: skillDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });
    const manifest = JSON.parse(fs.readFileSync(installed.sourceManifestPath, "utf8")) as Record<string, unknown>;

    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.duplicateFamily).toBe("cloudflare_dns");
    expect(manifest.reviewDisposition).toBe("allow");
    expect(typeof manifest.installedAt).toBe("string");
    expect(typeof manifest.lastReviewedAt).toBe("string");
    expect(typeof manifest.lastCheckedAt).toBe("string");
    expect(manifest).toHaveProperty("resolvedUpstream");
  });
});
