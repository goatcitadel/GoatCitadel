import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SkillImportService,
  __parseSkillImportGitTreeForTests,
  __skillImportGitSecurityForTests,
} from "./skill-import-service.js";
import { SKILL_CONTENT_INTEGRITY_LIMITS } from "./skill-content-integrity.js";

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
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("resolves SkillsMP listing URLs into review-only lookup results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("skillsmp.com/skills/")) {
          return new Response(
            '<html><body><a href="https://github.com/example/notebooklm-skill">repo</a></body></html>',
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch ${url}`);
      }),
    );

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

  it("classifies reviewed ClawHub sources with native dispositions and overlap owners", async () => {
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const expectations = [
      ["maximeprades/auto-updater", "auto_updates", "review_only", "Update Scout"],
      ["shaivpidadi/free-ride", "openclaw_experiment", "review_only", "compatibility"],
      ["steipete/github", "github_connector_playbook", "review_only", "GitHub connector"],
      ["oswalpalash/ontology", "typed_memory_ontology", "review_only", "MemoryLifecycleService"],
      ["biostartechnology/humanizer", "copy_humanizer", "review_only", "copy lint"],
      ["gpyangyoujun/multi-search-engine", "global_search_broker", "review_only", "global search broker"],
      ["halthelobster/proactive-agent", "proactive_automation", "review_only", "durable proactive"],
      ["steipete/gog", "google_cli_oauth", "review_only", "Google connector"],
      ["ivangdavila/self-improving", "safe_self_improvement", "not_installable", "native improvement ledger"],
      ["pskoett/self-improving-agent", "safe_self_improvement", "not_installable", "native improvement ledger"],
      ["matagul/desktop-control", "desktop_control_high_risk", "not_installable", "Reject direct import"],
      ["steipete/openai-whisper", "voice_transcription", "review_only", "managed local whisper"],
      ["jk-0001/automation-workflows", "automation_designer", "review_only", "Automation Designer"],
      ["0xneosoul/neosoul-decision-agent", "decision_journal", "review_only", "Decision Journal"],
      ["nextfrontierbuilds/elite-longterm-memory", "typed_memory_ontology", "review_only", "MemoryLifecycleService"],
      ["mpociot/superdesign", "frontend_review_guidance", "review_only", "frontend review"],
      ["xobi667/ui-ux-pro-max", "frontend_review_guidance", "review_only", "UI review"],
      ["lura2/canvas", "canvas_a2ui", "review_only", "A2UI"],
    ] as const;

    for (const [slug, family, installability, hint] of expectations) {
      const result = await service.lookupSources(`https://clawhub.ai/${slug}`, 5);
      expect(result.bestMatch).toMatchObject({
        sourceProvider: "clawhub",
        skillFamily: family,
        installability,
      });
      expect(result.bestMatch?.installHint).toEqual(expect.stringContaining(hint));
    }
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

  it("keeps credential-bearing direct source references raw inside the import service", async () => {
    const rawSourceUrl =
      "https://skill-user:internal-source-secret@github.com/example/private-skill.git?token=internal-source-secret";
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.lookupSources(rawSourceUrl, 5);

    expect(result.query).toBe(rawSourceUrl);
    expect(result.parsedSource).toMatchObject({
      sourceUrl: rawSourceUrl,
      repositoryUrl: rawSourceUrl,
      upstreamUrl: rawSourceUrl,
    });
    expect(result.bestMatch).toMatchObject({
      sourceUrl: rawSourceUrl,
      repositoryUrl: rawSourceUrl,
      upstreamUrl: rawSourceUrl,
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("<html><body></body></html>", { status: 200 });
      }),
    );

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.listSources("chrome", 5);

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]).toMatchObject({
      name: "Chrome Devtools Mcp",
    });
  });

  it("finds capability-style queries using deterministic ranking", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
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
      }),
    );

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.listSources("browser automation", 5);

    expect(result.items[0]).toMatchObject({
      skillFamily: "browser_automation",
      matchReason: "Capability match",
    });
  });

  it("returns an empty lookup for blank queries and marks installed fallback sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("marketplace offline");
      }),
    );
    const extraSkillDir = path.join(rootDir, "skills", "extra", "chrome-devtools-mcp");
    fs.mkdirSync(extraSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(extraSkillDir, "source.json"),
      JSON.stringify({
        candidate: {
          canonicalKey: "clawhub.ai/aiwithabidi/chrome-devtools-mcp",
          sourceRef: "https://clawhub.ai/aiwithabidi/chrome-devtools-mcp",
          sourceUrl: "https://clawhub.ai/aiwithabidi/chrome-devtools-mcp",
          repositoryUrl: "https://github.com/aiwithabidi/chrome-devtools-mcp",
        },
      }),
    );
    fs.writeFileSync(path.join(rootDir, "skills", "extra", "ignored-file.txt"), "not a skill directory");
    fs.mkdirSync(path.join(rootDir, "skills", "extra", "broken-manifest"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "skills", "extra", "broken-manifest", "source.json"), "{bad json");

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);

    await expect(service.lookupSources("   ", 5)).resolves.toMatchObject({
      query: "",
      items: [],
    });
    const listed = await service.listSources(undefined, 500);
    const chrome = listed.items.find((item) => item.name === "Chrome Devtools Mcp");

    expect(listed.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "agentskill", status: "degraded" }),
        expect.objectContaining({ provider: "skillsmp", status: "degraded" }),
      ]),
    );
    expect(chrome).toMatchObject({
      alreadyInstalled: true,
      sourceUrl: "https://clawhub.ai/aiwithabidi/chrome-devtools-mcp",
    });
  });
});

describe("SkillImportService materialized review scope", () => {
  it("scrubs inherited Git configuration and permits only exact HTTPS transport without redirects", () => {
    const inherited = {
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
      GIT_ALLOW_PROTOCOL: process.env.GIT_ALLOW_PROTOCOL,
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
    };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "url.file:///tmp/rewrite.insteadOf";
    process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
    process.env.GIT_ALLOW_PROTOCOL = "file:ssh:https";
    process.env.GIT_SSH_COMMAND = "attacker-controlled-ssh";
    try {
      const security = __skillImportGitSecurityForTests();
      expect(security.args).toEqual([
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "http.followRedirects=false",
      ]);
      expect(security.cloneArgs).toEqual([
        ...security.args,
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--single-branch",
        "--no-tags",
        "--no-checkout",
        `--filter=blob:limit=${SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes + 1}`,
        "--",
        "https://github.com/example/repo.git",
        "C:/bounded/repo",
      ]);
      expect(security.env).toMatchObject({
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      });
      expect(security.env.GIT_CONFIG_GLOBAL).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
      expect(security.env.GIT_CONFIG_SYSTEM).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
      expect(security.env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(security.env.GIT_CONFIG_KEY_0).toBeUndefined();
      expect(security.env.GIT_CONFIG_VALUE_0).toBeUndefined();
      expect(security.env.GIT_ALLOW_PROTOCOL).toBeUndefined();
      expect(security.env.GIT_SSH_COMMAND).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("rejects non-regular and non-portable Git tree entries before worktree materialization", () => {
    const oid = "a".repeat(40);
    expect(__parseSkillImportGitTreeForTests(`100644 blob ${oid}\tSKILL.md\0`)).toEqual([
      { objectId: oid, relativePath: "SKILL.md", bytes: 0 },
    ]);
    for (const listing of [
      `120000 blob ${oid}\tSKILL.md\0`,
      `100755 blob ${oid}\tscripts/run\0`,
      `160000 commit ${oid}\tdependencies/submodule\0`,
      `100644 blob ${oid}\treferences/payload.txt:stream\0`,
      `100644 blob ${oid}\t.git/config\0`,
      `100644 blob ${oid}\treferences/CON.txt\0`,
      `100644 blob ${oid}\tReferences/a.txt\0` + `100644 blob ${oid}\treferences/A.txt\0`,
    ]) {
      expect(() => __parseSkillImportGitTreeForTests(listing)).toThrow();
    }
  });

  it("rejects sources with more than one canonical SKILL.md instead of selecting by enumeration order", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-skill-review-ambiguous-"));
    const sourceDir = path.join(rootDir, "ambiguous-skill-source");
    for (const child of ["alpha", ".github"]) {
      const skillDir = path.join(sourceDir, child);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        `---\nname: ${child}\ndescription: Ambiguous source identity fixture.\n---\n\nDo not select by filesystem order.\n`,
      );
    }

    try {
      const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
      await expect(
        service.validateImport({
          sourceRef: sourceDir,
          sourceType: "local_path",
          sourceProvider: "local",
        }),
      ).rejects.toThrow(/ambiguous.*multiple SKILL\.md/i);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("keeps a remote source alive only for the awaited callback and cleans it after callback failure", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-skill-review-scope-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://example.com/skill.md") {
          return new Response(
            "---\nname: scoped-review\ndescription: A bounded review callback test skill.\nmetadata:\n  tools: []\n---\n\nReview safely.\n",
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    let ephemeralDir = "";

    try {
      await expect(
        service.withMaterializedValidation(
          { sourceRef: "https://example.com/skill.md", sourceType: "remote_bundle" },
          async ({ skillDir, validation, validateExactDirectory }) => {
            ephemeralDir = skillDir;
            expect(validation.valid).toBe(true);
            await expect(validateExactDirectory(skillDir)).resolves.toMatchObject({ valid: true });
            await expect(fsPromises.stat(path.join(skillDir, "SKILL.md"))).resolves.toBeDefined();
            throw new Error("callback failure");
          },
        ),
      ).rejects.toThrow("callback failure");
      await expect(fsPromises.stat(ephemeralDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllGlobals();
      fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("bounds aggregate hosted-bundle bytes before materializing all remote assets", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-skill-review-bounds-"));
    const largeAsset = Buffer.alloc(2_097_100, 0x61);
    const manifest = JSON.stringify({
      manifestVersion: "goatcitadel.skill-bundle.v1",
      scriptDisposition: "review_only_non_callable",
      assets: [
        { path: "SKILL.md", sha256: "a".repeat(64), kind: "skill" },
        { path: "references/a.bin", sha256: "b".repeat(64), kind: "reference" },
        { path: "references/b.bin", sha256: "c".repeat(64), kind: "reference" },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://example.com/skill.md") {
          return new Response(
            "---\nname: bounded-review\ndescription: A bounded hosted review fixture skill.\n---\n\nReview safely.\n",
            { status: 200 },
          );
        }
        if (url === "https://example.com/goatcitadel.skill-bundle.json") {
          return new Response(manifest, { status: 200 });
        }
        if (url.endsWith("/references/a.bin") || url.endsWith("/references/b.bin")) {
          return new Response(largeAsset, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    try {
      const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
      await expect(
        service.withMaterializedValidation(
          { sourceRef: "https://example.com/skill.md", sourceType: "remote_bundle" },
          () => undefined,
        ),
      ).rejects.toThrow(/total bytes/i);
    } finally {
      vi.unstubAllGlobals();
      fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
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
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("rejects not_installable curated sources at import time", async () => {
    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    await expect(
      service.validateImport({
        sourceRef: "https://animalhouse.ai/skills/animal-house",
      }),
    ).rejects.toThrow(/not installable/i);
  });

  it("rejects Windows alternate-stream and device-name zip entries", async () => {
    for (const [name, unsafePath] of [
      ["ads", "references/payload.txt:stream"],
      ["device", "references/CON.txt"],
    ] as const) {
      const zip = new AdmZip();
      zip.addFile(
        "SKILL.md",
        Buffer.from(
          "---\nname: zip-path-review\ndescription: A bounded zip path review fixture skill.\n---\n\nReview safely.\n",
        ),
      );
      zip.addFile(unsafePath, Buffer.from("unsafe path fixture"));
      const zipPath = path.join(rootDir, `unsafe-${name}.zip`);
      zip.writeZip(zipPath);
      const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
      await expect(
        service.validateImport({ sourceRef: zipPath, sourceType: "local_zip", sourceProvider: "local" }),
      ).rejects.toThrow(/unsafe zip entry path/i);
    }
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
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Oversized Audit Skill",
        "description: Valid fixture for security scan coverage.",
        "---",
        "",
        "Use this skill to validate import scanning.",
        "",
      ].join("\n"),
    );
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
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Security scan skipped large files"),
        expect.stringContaining("bundle.js"),
      ]),
    );
  });

  it("records import provenance, script gating, and tool-name mappings", async () => {
    const skillDir = path.join(rootDir, "mapped-tool-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Mapped Tool Skill",
        "description: Valid fixture that declares tools and a script for import posture.",
        "metadata:",
        "  tools:",
        "    - web_search",
        "    - shell",
        "    - custom.external",
        "---",
        "",
        "Use this skill to validate import provenance and activation posture.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n");
    fs.writeFileSync(path.join(skillDir, "probe.ps1"), "Write-Output 'review before activation'\n");

    const settings = createSystemSettingsRepo();
    const service = new SkillImportService(rootDir, settings as never);
    const result = await service.validateImport({
      sourceRef: skillDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });

    expect(result.valid).toBe(true);
    expect(result.provenance).toMatchObject({
      sourceProvider: "local",
      sourceType: "local_path",
      sourceRef: skillDir,
      contentIntegrity: {
        manifestVersion: "goatcitadel.skill-tree.v1",
        algorithm: "sha256",
        fileCount: 3,
      },
      nonCallableUntilActivated: true,
    });
    expect(result.scriptDisposition).toMatchObject({
      action: "blocked_until_activation",
      scriptFiles: ["probe.ps1"],
    });
    expect(result.externalToolMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ declaredTool: "web_search", mappedCapabilityLabel: "browser.search" }),
        expect.objectContaining({ declaredTool: "shell", mappedCapabilityLabel: "shell.exec" }),
        expect.objectContaining({ declaredTool: "custom.external", disposition: "unmapped" }),
      ]),
    );
    expect(service.listHistory(1)[0]?.details).toMatchObject({
      provenance: expect.objectContaining({ sourceRef: skillDir, nonCallableUntilActivated: true }),
      scriptDisposition: expect.objectContaining({ action: "blocked_until_activation" }),
    });
  });

  it("surfaces Agent Skills and AGENTS.md compatibility as review-only metadata", async () => {
    const skillDir = path.join(rootDir, "agent-skills-compat");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Agent Skills Compat",
        "description: Valid fixture for Agent Skills and AGENTS.md compatibility metadata review.",
        "---",
        "",
        "Use this skill to validate compatibility metadata without activating scripts.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(skillDir, "AGENTS.md"), "Keep this guidance review-only.\n");
    fs.writeFileSync(path.join(skillDir, "skill.json"), '{"name":"agent-skills-compat"}\n');
    fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n");
    fs.writeFileSync(path.join(skillDir, "scripts.mjs"), "console.log('review only');\n");

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.validateImport({
      sourceRef: skillDir,
      sourceType: "local_path",
      sourceProvider: "agentskill",
    });

    expect(result.valid).toBe(true);
    expect(result.compatibility).toMatchObject({
      sources: expect.arrayContaining(["skill_md", "agent_skills", "agents_md"]),
      callability: "review_only",
      warnings: expect.arrayContaining([
        expect.stringContaining("Agent Skills compatibility metadata detected"),
        expect.stringContaining("AGENTS.md guidance detected as provenance only"),
        expect.stringContaining("Imported scripts remain non-callable"),
      ]),
    });
    expect(result.candidate.compatibility).toEqual(result.compatibility);
    expect(result.warnings).toEqual(expect.arrayContaining(result.compatibility?.warnings ?? []));
    expect(service.listHistory(1)[0]?.details).toMatchObject({
      compatibility: expect.objectContaining({
        callability: "review_only",
        sources: expect.arrayContaining(["agent_skills", "agents_md"]),
      }),
    });
  });

  it("hard-blocks imports that overlap GoatCitadel native capability families", async () => {
    const skillDir = path.join(rootDir, "self-improving-agent-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Self Improving Agent",
        "description: Keeps improving itself through continuous memory and rule updates.",
        "---",
        "",
        "Use this skill to improve future execution quality.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n");

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const result = await service.validateImport({
      sourceRef: skillDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("native bounded memory-maintenance path for this family")]),
    );
    expect(result.nativeOverlaps).toEqual([
      expect.objectContaining({
        overlapFamily: "safe_self_improvement",
        nativeAlternativeName: "Native memory maintenance",
        nativeDestination: "Observe > Artifacts > Memory",
      }),
    ]);
  });

  it("validates hosted skill bundles fetched from a raw skill.md URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://www.moltbook.com/skill.md") {
          return new Response(
            [
              "---",
              "name: Moltbook",
              "description: Hosted skill bundle for joining and using Moltbook safely.",
              "---",
              "",
              "Follow the hosted instructions and store credentials locally.",
              "",
            ].join("\n"),
            { status: 200 },
          );
        }
        if (url === "https://www.moltbook.com/skill.json") {
          return new Response('{"name":"moltbook"}', { status: 200 });
        }
        return new Response("", { status: 404 });
      }),
    );

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
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Self Improving",
        "description: Iteratively review and improve the runtime by replaying prior work.",
        "---",
        "",
        "Review the repo and replay improvement cycles.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n");

    const service = new SkillImportService("F:/code/personal-ai", createSystemSettingsRepo() as never);
    await expect(
      service.validateImport({
        sourceRef: skillDir,
        sourceType: "local_path",
        sourceProvider: "local",
      }),
    ).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringContaining("native safe self-improvement bundle")]),
    });
  });

  it("marks Harness Engineer as reference-only with a native harness alternative", async () => {
    const skillDir = path.join(rootDir, "harness-engineer");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Harness Engineer",
        "description: Audit and improve the harness around skills, routing, memory, permissions, and trust.",
        "---",
        "",
        "Review the local harness and propose improvements.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n");

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    await expect(
      service.validateImport({
        sourceRef: skillDir,
        sourceType: "local_path",
        sourceProvider: "local",
      }),
    ).resolves.toMatchObject({
      valid: false,
      reviewDisposition: "reference_only",
      reviewMessage: expect.stringContaining("reference pattern only"),
      nativeOverlaps: [
        expect.objectContaining({
          overlapFamily: "harness_engineering",
          nativeAlternativeName: "Native harness audit and operator governance",
        }),
      ],
    });
  });

  it("rejects Capability Evolver-style autonomous self-modification imports", async () => {
    const skillDir = path.join(rootDir, "capability-evolver");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Capability Evolver",
        "description: Analyze runtime history and evolve the agent by autonomously updating memory and code.",
        "---",
        "",
        "Run an autonomous evolution loop over prior traces.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n");

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    await expect(
      service.validateImport({
        sourceRef: skillDir,
        sourceType: "local_path",
        sourceProvider: "local",
      }),
    ).resolves.toMatchObject({
      valid: false,
      reviewDisposition: "reject",
      reviewMessage: expect.stringContaining("autonomous self-modification"),
      errors: expect.arrayContaining([expect.stringContaining("trust posture")]),
    });
  });

  it("blocks overlapping Cloudflare-family validations against historically installed skills/extra", async () => {
    // HX-402 P2: the legacy install can no longer publish, so the historical
    // installed skill is seeded directly (pre-retirement installs remain on
    // disk); advisory duplicate-family validation still blocks the overlap.
    const historicalInstallDir = path.join(rootDir, "skills", "extra", "cloudflare-api");
    fs.mkdirSync(historicalInstallDir, { recursive: true });
    fs.writeFileSync(
      path.join(historicalInstallDir, "SKILL.md"),
      [
        "---",
        "name: Cloudflare API",
        "description: Manage Cloudflare zones and DNS records through a focused skill.",
        "---",
        "",
        "Use Cloudflare APIs to inspect and update DNS records.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(historicalInstallDir, "LICENSE"), "MIT\n");
    fs.writeFileSync(
      path.join(historicalInstallDir, "source.json"),
      JSON.stringify({
        manifestVersion: 3,
        duplicateFamily: "cloudflare_dns",
        candidate: {
          canonicalKey: "local:local_path:cloudflare-api",
          sourceRef: path.join(rootDir, "cloudflare-api"),
        },
      }),
      "utf8",
    );

    const secondSkillDir = path.join(rootDir, "cloudflare-manager");
    fs.mkdirSync(secondSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(secondSkillDir, "SKILL.md"),
      [
        "---",
        "name: Cloudflare Manager",
        "description: Alternate Cloudflare management workflow for DNS and zone changes.",
        "---",
        "",
        "Manage Cloudflare resources and DNS state.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(secondSkillDir, "LICENSE"), "MIT\n");

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const validation = await service.validateImport({
      sourceRef: secondSkillDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Duplicate skill family "cloudflare_dns"'),
        expect.stringContaining("skills/extra/cloudflare-api"),
      ]),
    );
  });

  it("returns enriched validation provenance on the redirect instead of a published manifest", async () => {
    const skillDir = path.join(rootDir, "cloudflare-api");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Cloudflare API",
        "description: Manage Cloudflare zones and DNS records through a focused skill.",
        "---",
        "",
        "Use Cloudflare APIs to inspect and update DNS records.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n");

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const redirected = await service.installImport({
      sourceRef: skillDir,
      sourceType: "local_path",
      sourceProvider: "local",
    });

    // HX-402 P2: the enriched metadata is the advisory validation result and
    // the immutable history detail — never a published source manifest.
    expect(redirected.disposition).toBe("redirected_to_skill_hub");
    expect(redirected.validation).toMatchObject({
      valid: true,
      provenance: expect.objectContaining({
        contentIntegrity: expect.objectContaining({
          manifestVersion: "goatcitadel.skill-tree.v1",
          algorithm: "sha256",
          treeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          fileCount: 2,
          totalBytes: expect.any(Number),
          files: expect.arrayContaining([
            expect.objectContaining({ path: "LICENSE" }),
            expect.objectContaining({ path: "SKILL.md" }),
          ]),
        }),
      }),
    });
    expect(service.listHistory(1)[0]).toMatchObject({
      action: "install",
      outcome: "accepted",
      details: expect.objectContaining({ disposition: "redirected_to_skill_hub" }),
    });
    expect(fs.existsSync(path.join(rootDir, "skills", "extra"))).toBe(false);
  });

  it("never moves or copies any payload into skills/extra even for valid confirmed installs", async () => {
    const skillDir = path.join(rootDir, "staging-race-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Staging Race Skill",
        "description: Valid fixture for exact-byte import retirement proof.",
        "---",
        "",
        "Use the validated instructions only.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n");

    // ADVERSARIAL: observe every rename/copy the install performs and prove
    // none of them can target the runtime skills/extra root.
    const extraRoot = path.join(rootDir, "skills", "extra");
    const observedTargets: string[] = [];
    const originalRename = fsPromises.rename.bind(fsPromises);
    vi.spyOn(fsPromises, "rename").mockImplementation(async (oldPath, newPath) => {
      observedTargets.push(String(newPath));
      return originalRename(oldPath, newPath);
    });
    const originalCp = fsPromises.cp.bind(fsPromises);
    vi.spyOn(fsPromises, "cp").mockImplementation(async (source, destination, options) => {
      observedTargets.push(String(destination));
      return originalCp(source, destination, options as never);
    });

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const redirected = await service.installImport({
      sourceRef: skillDir,
      sourceType: "local_path",
      sourceProvider: "local",
      force: true,
      confirmHighRisk: true,
    });

    expect(redirected.disposition).toBe("redirected_to_skill_hub");
    expect(observedTargets.length).toBeGreaterThan(0);
    expect(observedTargets.some((target) => path.resolve(target).startsWith(path.resolve(extraRoot)))).toBe(false);
    expect(fs.existsSync(extraRoot)).toBe(false);
    // The advisory source tree is untouched.
    expect(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8")).toContain("validated instructions");
  });

  it("rejects an oversized local tree before copying it into managed staging", async () => {
    const skillDir = path.join(rootDir, "oversized-local-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Oversized Local Skill",
        "description: Valid metadata paired with a payload that exceeds import limits.",
        "---",
        "",
        "This content must never reach managed staging.",
        "",
      ].join("\n"),
    );
    const oversizedPath = path.join(skillDir, "oversized.bin");
    fs.writeFileSync(oversizedPath, "");
    fs.truncateSync(oversizedPath, SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes + 1);
    const copySpy = vi.spyOn(fsPromises, "cp");

    const service = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    await expect(
      service.installImport({
        sourceRef: skillDir,
        sourceType: "local_path",
        sourceProvider: "local",
      }),
    ).rejects.toThrow(`exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes} bytes`);

    expect(copySpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(rootDir, "skills", "extra", "oversized-local-skill"))).toBe(false);
    expect(service.listHistory(1)[0]).toMatchObject({
      action: "install",
      outcome: "failed",
      details: { error: expect.stringContaining("exceeds") },
    });
  });

  it("requires explicit confirmation before installing high-risk local skills", async () => {
    const skillDir = path.join(rootDir, "dangerous-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Dangerous Skill",
        "description: Valid fixture that deliberately trips script risk detection.",
        "---",
        "",
        "Use this skill to validate import risk handling.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(skillDir, "LICENSE"), "MIT\n");
    fs.writeFileSync(path.join(skillDir, "install.sh"), "rm -rf /tmp/goatcitadel-risk-fixture\n");

    const settings = createSystemSettingsRepo();
    const service = new SkillImportService(rootDir, settings as never);

    await expect(
      service.installImport({
        sourceRef: skillDir,
        sourceType: "local_path",
        sourceProvider: "local",
      }),
    ).rejects.toThrow(/High-risk skill import requires explicit confirmation/);

    expect(service.listHistory(5)).toEqual([
      expect.objectContaining({
        action: "install",
        outcome: "failed",
        details: expect.objectContaining({
          error: "High-risk skill import requires explicit confirmation.",
        }),
      }),
      expect.objectContaining({
        action: "install",
        outcome: "rejected",
        riskLevel: "high",
        details: expect.objectContaining({ error: "high_risk_confirmation_required" }),
      }),
    ]);
    expect(fs.existsSync(path.join(rootDir, "skills", "extra", "dangerous-skill"))).toBe(false);
  });
});
