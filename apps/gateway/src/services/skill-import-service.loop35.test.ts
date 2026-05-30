import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillImportService } from "./skill-import-service.js";

describe("SkillImportService loop 35 import behavior", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-skill-loop35-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("persists rejected validation diagnostics for malformed high-risk local sources", async () => {
    const sourceDir = path.join(rootDir, "malformed-risky-skill");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "This is not valid skill frontmatter.\n", "utf8");
    fs.writeFileSync(
      path.join(sourceDir, "000-risk.sh"),
      "curl https://example.test/install.sh\nrm -rf /tmp/goatcitadel-loop35\n",
      "utf8",
    );
    for (let index = 0; index < 225; index += 1) {
      fs.writeFileSync(path.join(sourceDir, `filler-${String(index).padStart(3, "0")}.txt`), "x", "utf8");
    }

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.validateImport({
      sourceRef: sourceDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });

    expect(result).toMatchObject({
      valid: false,
      riskLevel: "high",
      checks: {
        frontmatterValid: false,
        suspiciousScripts: true,
        networkIndicators: true,
        licenseDetected: false,
      },
    });
    expect(result.errors).toEqual([expect.stringContaining("Invalid SKILL.md")]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Potentially risky script indicators detected.",
        "Network usage indicators detected in skill files.",
        "Security scan reached the file inspection limit; review the remaining files manually.",
        "No license file detected.",
      ]),
    );
    expect(service.listHistory(1)).toEqual([
      expect.objectContaining({
        action: "validate",
        outcome: "rejected",
        sourceProvider: "local",
        sourceType: "local_path",
        riskLevel: "high",
        details: expect.objectContaining({
          errors: [expect.stringContaining("Invalid SKILL.md")],
          warnings: expect.arrayContaining(["Potentially risky script indicators detected."]),
        }),
      }),
    ]);
  });

  it("records remote bundle fetch failures and blocks marketplace listings before import", async () => {
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);

    await expect(
      service.validateImport({
        sourceRef: path.join(rootDir, "missing.zip"),
        sourceType: "local_zip",
        sourceProvider: "local",
      }),
    ).rejects.toThrow("Local zip path is not a file");

    await expect(
      service.validateImport({
        sourceRef: "https://skillsmp.com/skills/browser-helper",
      }),
    ).rejects.toThrow("Marketplace listing URLs are reference-only");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://example.test/skill.md") {
          return new Response("missing", { status: 503 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      }),
    );

    await expect(
      service.validateImport({
        sourceRef: "https://example.test/skill.md",
      }),
    ).rejects.toThrow("Failed to fetch hosted skill bundle");

    await expect(
      service.validateImport({
        sourceRef: path.join(rootDir, "not-a-git-repo"),
        sourceType: "git_url",
        sourceProvider: "github",
      }),
    ).rejects.toThrow("Failed to clone git source");

    expect(service.listHistory(4)).toEqual([
      expect.objectContaining({
        action: "validate",
        outcome: "failed",
        sourceProvider: "github",
        sourceType: "git_url",
        details: expect.objectContaining({
          error: expect.stringContaining("Failed to clone git source"),
        }),
      }),
      expect.objectContaining({
        action: "validate",
        outcome: "failed",
        sourceProvider: "external",
        sourceType: "remote_bundle",
        sourceRef: "https://example.test/skill.md",
        details: expect.objectContaining({
          error: expect.stringContaining("Failed to fetch hosted skill bundle"),
        }),
      }),
      expect.objectContaining({
        action: "validate",
        outcome: "failed",
        sourceProvider: "skillsmp",
        sourceType: "git_url",
        details: expect.objectContaining({
          error: expect.stringContaining("Marketplace listing URLs are reference-only"),
        }),
      }),
      expect.objectContaining({
        action: "validate",
        outcome: "failed",
        sourceProvider: "local",
        sourceType: "local_zip",
        details: expect.objectContaining({
          error: expect.stringContaining("Local zip path is not a file"),
        }),
      }),
    ]);
  });

  it("blocks hosted bundle private hosts and private redirects", async () => {
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      service.validateImport({
        sourceRef: "http://127.0.0.1/skill.md",
        sourceType: "remote_bundle",
        sourceProvider: "external",
      }),
    ).rejects.toThrow(/Private|loopback|reserved|hosted skill bundle/i);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://example.test/skill.md") {
        return new Response("", {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      }
      throw new Error(`Unexpected private follow ${url}`);
    });

    await expect(
      service.validateImport({
        sourceRef: "https://example.test/skill.md",
        sourceType: "remote_bundle",
        sourceProvider: "external",
      }),
    ).rejects.toThrow(/Private|metadata|reserved|hosted skill bundle/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("installs hosted bundles, writes source metadata, and marks the direct source installed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://example.test/skill.md") {
          return new Response(
            [
              "---",
              "name: Hosted Bundle",
              "description: Hosted bundle fixture for installation metadata coverage.",
              "---",
              "",
              "Use this hosted bundle for deterministic import tests.",
              "",
            ].join("\n"),
            { status: 200 },
          );
        }
        if (url === "https://example.test/heartbeat.md") {
          return new Response("# Heartbeat\n", { status: 200 });
        }
        if (url === "https://example.test/skill.json") {
          return new Response('{"name":"hosted-bundle"}', { status: 200 });
        }
        return new Response("", { status: 404 });
      }),
    );

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const installed = await service.installImport({
      sourceRef: "https://example.test/skill.md",
    });
    const manifest = JSON.parse(fs.readFileSync(installed.sourceManifestPath, "utf8")) as Record<string, unknown>;
    const directLookup = await service.lookupSources("https://example.test/skill.md", 5);

    expect(fs.existsSync(path.join(installed.installedPath, "HEARTBEAT.md"))).toBe(true);
    expect(fs.existsSync(path.join(installed.installedPath, "RULES.md"))).toBe(false);
    expect(manifest).toMatchObject({
      manifestVersion: 2,
      riskLevel: "low",
      candidate: expect.objectContaining({
        sourceProvider: "external",
        sourceType: "remote_bundle",
        sourceRef: "https://example.test/skill.md",
        sourceUrl: "https://example.test/skill.md",
      }),
      resolvedUpstream: {
        url: "https://example.test/skill.md",
      },
    });
    expect(directLookup.bestMatch).toMatchObject({
      sourceUrl: "https://example.test/skill.md",
      alreadyInstalled: true,
      installability: "direct",
    });
    expect(service.listHistory(1)).toEqual([
      expect.objectContaining({
        action: "install",
        outcome: "accepted",
        skillId: "hosted-bundle",
        details: expect.objectContaining({ installedPath: "skills/extra/hosted-bundle" }),
      }),
    ]);
  });

  it("classifies direct ssh git, generic reference, and local zip lookup sources", async () => {
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);

    await expect(service.lookupSources("git@github.com:Owner/Repo.git", 5)).resolves.toMatchObject({
      parsedSource: {
        sourceProvider: "github",
        sourceKind: "upstream_repo",
        installability: "direct",
      },
      bestMatch: expect.objectContaining({
        sourceProvider: "github",
        repositoryUrl: "git@github.com:Owner/Repo.git",
        matchReason: "Direct source match",
      }),
    });
    await expect(service.lookupSources("https://docs.example.test/skill-guide", 5)).resolves.toMatchObject({
      parsedSource: {
        sourceProvider: "external",
        sourceKind: "reference",
        installability: "review_only",
      },
      bestMatch: expect.objectContaining({
        sourceProvider: "external",
        installHint: expect.stringContaining("direct repository"),
      }),
    });
    await expect(service.lookupSources(".\\fixtures\\bundle.zip", 5)).resolves.toMatchObject({
      parsedSource: {
        sourceProvider: "local",
        sourceKind: "local",
        installability: "direct",
      },
      bestMatch: expect.objectContaining({
        name: "Local zip skill source",
        tags: ["local", "zip"],
      }),
    });
  });
});

function createSystemSettingsRepo() {
  const values = new Map<string, { value: unknown }>();
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, { value });
    },
  };
}
