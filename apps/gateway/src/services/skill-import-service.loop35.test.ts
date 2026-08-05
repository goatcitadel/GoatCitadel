import fs from "node:fs";
import { createHash } from "node:crypto";
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
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    for (let index = 0; index < 85; index += 1) {
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
    expect(await service.listHistory(1)).toEqual([
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

    expect(await service.listHistory(4)).toEqual([
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

  // HX-402 P2 (coverage-preserving remodel): hosted-bundle installs validate
  // byte-exactly but redirect into the governed Skill Hub instead of ever
  // publishing bytes or claiming the source as installed.
  it("redirects hosted bundles into the Skill Hub with exact-byte validation and no publication", async () => {
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
    const redirected = await service.installImport({
      sourceRef: "https://example.test/skill.md",
    });
    const directLookup = await service.lookupSources("https://example.test/skill.md", 5);

    // Advisory validation with exact-byte provenance still returned in full.
    expect(redirected.validation.valid).toBe(true);
    expect(redirected.validation.riskLevel).toBe("low");
    expect(redirected.validation.candidate).toMatchObject({
      sourceProvider: "external",
      sourceType: "remote_bundle",
      sourceRef: "https://example.test/skill.md",
      sourceUrl: "https://example.test/skill.md",
    });
    expect(redirected.validation.provenance?.contentIntegrity).toMatchObject({
      manifestVersion: "goatcitadel.skill-tree.v1",
      treeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    // Hosted sources map onto the governed hub review surface.
    expect(redirected.redirect).toEqual({
      owner: "skill_hub",
      reviewRoute: "/api/v1/skills/hub/reviews",
      sourceRef: "https://example.test/skill.md",
      sourceType: "remote_bundle",
      eligible: true,
    });
    // ADVERSARIAL: nothing was published and nothing claims installed truth.
    expect(fs.existsSync(path.join(rootDir, "skills", "extra"))).toBe(false);
    expect(directLookup.bestMatch).toMatchObject({
      sourceUrl: "https://example.test/skill.md",
      alreadyInstalled: false,
    });
    expect(await service.listHistory(1)).toEqual([
      expect.objectContaining({
        action: "install",
        outcome: "accepted",
        skillId: "hosted-bundle",
        details: expect.objectContaining({ disposition: "redirected_to_skill_hub" }),
      }),
    ]);
  });

  it("validates portable hosted skill bundle manifests and keeps scripts non-callable", async () => {
    const skill = [
      "---",
      "name: Portable Hosted Bundle",
      "description: Portable hosted bundle fixture with manifest hash coverage.",
      "---",
      "",
      "Review the manifest-backed bundle before activation.",
      "",
    ].join("\n");
    const reference = "# Operator Notes\n";
    const script = "Write-Output 'review only'\n";
    const manifest = {
      manifestVersion: "goatcitadel.skill-bundle.v1",
      name: "Portable Hosted Bundle",
      allowedDirectories: ["references", "templates", "scripts"],
      scriptDisposition: "review_only_non_callable",
      assets: [
        { path: "SKILL.md", kind: "skill", sha256: sha256(skill), bytes: Buffer.byteLength(skill) },
        { path: "references/operator.md", kind: "reference", sha256: sha256(reference) },
        { path: "scripts/review.ps1", kind: "script", sha256: sha256(script), callable: false },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://example.test/skill.md") {
          return new Response(skill, { status: 200 });
        }
        if (url === "https://example.test/goatcitadel.skill-bundle.json") {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        if (url === "https://example.test/references/operator.md") {
          return new Response(reference, { status: 200 });
        }
        if (url === "https://example.test/scripts/review.ps1") {
          return new Response(script, { status: 200 });
        }
        return new Response("", { status: 404 });
      }),
    );

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.validateImport({
      sourceRef: "https://example.test/skill.md",
      sourceType: "remote_bundle",
      sourceProvider: "external",
    });

    expect(result.valid).toBe(true);
    expect(result.bundleManifest).toMatchObject({
      status: "valid",
      assetsVerified: 3,
      assetPaths: ["SKILL.md", "references/operator.md", "scripts/review.ps1"],
      scriptDisposition: "review_only_non_callable",
    });
    expect(result.scriptDisposition).toMatchObject({
      action: "blocked_until_activation",
      scriptFiles: ["scripts/review.ps1"],
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Portable skill bundle manifest verified"),
        expect.stringContaining("Imported scripts remain non-callable"),
      ]),
    );
  });

  it("rejects portable skill bundle manifests with mismatched asset hashes", async () => {
    const skill = [
      "---",
      "name: Hash Mismatch Bundle",
      "description: Portable hosted bundle fixture with mismatched hashes.",
      "---",
      "",
      "Review the manifest-backed bundle before activation.",
      "",
    ].join("\n");
    const manifest = {
      manifestVersion: "goatcitadel.skill-bundle.v1",
      scriptDisposition: "review_only_non_callable",
      assets: [
        { path: "SKILL.md", kind: "skill", sha256: "0".repeat(64) },
        { path: "references/operator.md", kind: "reference", sha256: "1".repeat(64) },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://example.test/skill.md") {
          return new Response(skill, { status: 200 });
        }
        if (url === "https://example.test/goatcitadel.skill-bundle.json") {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        if (url === "https://example.test/references/operator.md") {
          return new Response("# Operator Notes\n", { status: 200 });
        }
        return new Response("", { status: 404 });
      }),
    );

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.validateImport({
      sourceRef: "https://example.test/skill.md",
      sourceType: "remote_bundle",
      sourceProvider: "external",
    });

    expect(result.valid).toBe(false);
    expect(result.bundleManifest).toMatchObject({
      status: "invalid",
      assetsVerified: 0,
    });
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("sha256 does not match manifest")]));
  });

  it("rejects portable skill bundle manifests with duplicate normalized asset paths", async () => {
    const skillDir = path.join(rootDir, "portable-duplicate");
    fs.mkdirSync(skillDir, { recursive: true });
    const skill = [
      "---",
      "name: Duplicate Bundle",
      "description: Portable local bundle fixture with duplicate assets.",
      "---",
      "",
      "Review the manifest-backed bundle before activation.",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), skill, "utf8");
    fs.writeFileSync(
      path.join(skillDir, "goatcitadel.skill-bundle.json"),
      JSON.stringify({
        manifestVersion: "goatcitadel.skill-bundle.v1",
        scriptDisposition: "review_only_non_callable",
        assets: [
          { path: "SKILL.md", kind: "skill", sha256: sha256(skill) },
          { path: "./SKILL.md", kind: "skill", sha256: sha256(skill) },
        ],
      }),
      "utf8",
    );

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.validateImport({
      sourceRef: skillDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("declared more than once")]));
  });

  it("rejects portable skill bundle manifests that escape allowed paths", async () => {
    const skillDir = path.join(rootDir, "portable-local");
    fs.mkdirSync(skillDir, { recursive: true });
    const skill = [
      "---",
      "name: Escaping Bundle",
      "description: Portable local bundle fixture with escaping paths.",
      "---",
      "",
      "Review the manifest-backed bundle before activation.",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), skill, "utf8");
    fs.writeFileSync(
      path.join(skillDir, "goatcitadel.skill-bundle.json"),
      JSON.stringify({
        manifestVersion: "goatcitadel.skill-bundle.v1",
        scriptDisposition: "review_only_non_callable",
        assets: [
          { path: "SKILL.md", kind: "skill", sha256: sha256(skill) },
          { path: "../evil.ps1", kind: "script", sha256: "2".repeat(64), callable: false },
        ],
      }),
      "utf8",
    );

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.validateImport({
      sourceRef: skillDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });

    expect(result.valid).toBe(false);
    expect(result.bundleManifest).toMatchObject({ status: "invalid" });
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("asset path may not traverse")]));
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
