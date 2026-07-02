import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const packageDir = path.join(repoRoot, "packages", "extensions-sdk");
const rootManifestPath = path.join(
  repoRoot,
  "templates",
  "integration-plugins",
  "reference-integration-plugin",
  "goatcitadel.integration-plugin.json",
);
const packageManifestPath = path.join(
  packageDir,
  "templates",
  "integration-plugins",
  "reference-integration-plugin",
  "goatcitadel.integration-plugin.json",
);
const distValidatorPath = path.join(packageDir, "dist", "integration-plugins.js");
let gnuTarCache;

if (!fs.existsSync(distValidatorPath)) {
  fail("extensions-sdk dist is missing; run `pnpm --filter @goatcitadel/extensions-sdk build` first.");
}

const { validateIntegrationPluginAuthorManifest } = await import(pathToFileURL(distValidatorPath).href);
const rootManifest = readJson(rootManifestPath);
const packageManifest = readJson(packageManifestPath);
const packageTemplateManifests = listManifestFiles(path.join(packageDir, "templates"));

validateIntegrationPluginAuthorManifest(rootManifest);
validateIntegrationPluginAuthorManifest(packageManifest);

if (JSON.stringify(rootManifest) !== JSON.stringify(packageManifest)) {
  fail("packaged reference integration-plugin manifest drifted from the repo reference scaffold.");
}
if (packageTemplateManifests.length === 0) {
  fail("extensions-sdk templates do not include any distributed GoatCitadel manifests.");
}
for (const relativeManifestPath of packageTemplateManifests) {
  readJson(path.join(packageDir, "templates", relativeManifestPath));
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-ext-pack-"));
try {
  const pack = spawnSync(resolvePnpmPackCommand(), resolvePnpmPackArgs(tempDir), {
    cwd: packageDir,
    encoding: "utf8",
    shell: false,
  });
  if (pack.error) {
    fail(pack.error.message);
  }
  if (pack.status !== 0) {
    fail(pack.stderr || pack.stdout || "pnpm pack failed.");
  }
  const tarball = findPackedTarball(tempDir, pack.stdout);
  const extractDir = path.join(tempDir, "extract");
  fs.mkdirSync(extractDir, { recursive: true });
  const tar = spawnSync("tar", tarExtractArgs(tarball, extractDir), {
    encoding: "utf8",
    shell: false,
  });
  if (tar.error) {
    fail(tar.error.message);
  }
  if (tar.status !== 0) {
    fail(tar.stderr || tar.stdout || "tar extraction failed.");
  }
  const extractedManifestPath = path.join(
    extractDir,
    "package",
    "templates",
    "integration-plugins",
    "reference-integration-plugin",
    "goatcitadel.integration-plugin.json",
  );
  if (!fs.existsSync(extractedManifestPath)) {
    fail("packed extensions-sdk artifact is missing the reference integration-plugin manifest.");
  }
  const extractedManifest = readJson(extractedManifestPath);
  validateIntegrationPluginAuthorManifest(extractedManifest);
  if (JSON.stringify(extractedManifest) !== JSON.stringify(rootManifest)) {
    fail("extracted reference integration-plugin manifest drifted from the repo reference scaffold.");
  }
  const extractedTemplateRoot = path.join(extractDir, "package", "templates");
  const extractedTemplateManifests = listManifestFiles(extractedTemplateRoot);
  if (JSON.stringify(extractedTemplateManifests) !== JSON.stringify(packageTemplateManifests)) {
    fail(
      `packed extensions-sdk artifact manifest set drifted: expected ${packageTemplateManifests.join(", ")}, found ${extractedTemplateManifests.join(", ")}`,
    );
  }
  for (const relativeManifestPath of extractedTemplateManifests) {
    readJson(path.join(extractedTemplateRoot, relativeManifestPath));
  }
  const skillBundleTarballName = verifyPortableSkillBundlePackageSurvivesExtraction(tempDir);
  console.log(`Verified extensions-sdk package artifact: ${path.basename(tarball)}`);
  console.log(`Verified portable skill-bundle package fixture: ${skillBundleTarballName}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listManifestFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const out = [];
  walkManifestFiles(rootDir, rootDir, out);
  return out.sort();
}

function walkManifestFiles(rootDir, currentDir, out) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkManifestFiles(rootDir, fullPath, out);
      continue;
    }
    if (entry.isFile() && /^goatcitadel\..+\.json$/u.test(entry.name)) {
      out.push(path.relative(rootDir, fullPath).replaceAll("\\", "/"));
    }
  }
}

function findPackedTarball(tempDir, stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      const candidate = typeof entry?.filename === "string" ? path.resolve(packageDir, entry.filename) : undefined;
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Fall back to scanning the pack destination below.
  }
  const candidates = fs
    .readdirSync(tempDir)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => path.join(tempDir, entry));
  if (candidates.length !== 1) {
    fail(`Expected one packed tarball in ${tempDir}, found ${candidates.length}.`);
  }
  return candidates[0];
}

function verifyPortableSkillBundlePackageSurvivesExtraction(tempDir) {
  const bundleDir = path.join(tempDir, "portable-skill-bundle");
  const extractDir = path.join(tempDir, "portable-skill-extract");
  fs.mkdirSync(path.join(bundleDir, "references"), { recursive: true });
  fs.mkdirSync(path.join(bundleDir, "scripts"), { recursive: true });

  const files = [
    {
      path: "SKILL.md",
      kind: "skill",
      content: [
        "---",
        "name: Package Proof Skill",
        "description: Portable package fixture for manifest survival proof.",
        "---",
        "",
        "This fixture proves portable skill-bundle assets survive packaging intact.",
        "",
      ].join("\n"),
    },
    {
      path: "references/operator.md",
      kind: "reference",
      content: "# Operator reference\n\nReview evidence only.\n",
    },
    {
      path: "scripts/review.ps1",
      kind: "script",
      content: "Write-Output 'review-only fixture'\n",
      callable: false,
    },
  ];

  for (const file of files) {
    fs.writeFileSync(path.join(bundleDir, file.path), file.content, "utf8");
  }
  const manifest = {
    manifestVersion: "goatcitadel.skill-bundle.v1",
    name: "Package Proof Skill",
    provenance: {
      source: "verify:extensions:package",
      generatedAt: "1970-01-01T00:00:00.000Z",
    },
    trust: {
      disposition: "review_only",
      callableCatalogImpact: "none",
    },
    scriptDisposition: "review_only_non_callable",
    assets: files.map((file) => ({
      path: file.path,
      kind: file.kind,
      sha256: sha256(file.content),
      ...(file.kind === "script" ? { callable: false } : {}),
    })),
  };
  fs.writeFileSync(
    path.join(bundleDir, "goatcitadel.skill-bundle.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const tarball = path.join(tempDir, "portable-skill-bundle.tgz");
  const pack = spawnSync("tar", tarCreateArgs(tarball, bundleDir), {
    encoding: "utf8",
    shell: false,
  });
  if (pack.error) {
    fail(pack.error.message);
  }
  if (pack.status !== 0) {
    fail(pack.stderr || pack.stdout || "portable skill-bundle tar creation failed.");
  }

  fs.mkdirSync(extractDir, { recursive: true });
  const extract = spawnSync("tar", tarExtractArgs(tarball, extractDir), {
    encoding: "utf8",
    shell: false,
  });
  if (extract.error) {
    fail(extract.error.message);
  }
  if (extract.status !== 0) {
    fail(extract.stderr || extract.stdout || "portable skill-bundle extraction failed.");
  }

  const extractedManifestPath = path.join(extractDir, "goatcitadel.skill-bundle.json");
  if (!fs.existsSync(extractedManifestPath)) {
    fail("portable skill-bundle package is missing goatcitadel.skill-bundle.json after extraction.");
  }
  const extractedManifest = readJson(extractedManifestPath);
  if (extractedManifest.manifestVersion !== "goatcitadel.skill-bundle.v1") {
    fail("portable skill-bundle manifestVersion did not survive extraction.");
  }
  if (extractedManifest.scriptDisposition !== "review_only_non_callable") {
    fail("portable skill-bundle script disposition did not survive extraction.");
  }
  if (extractedManifest.trust?.callableCatalogImpact !== "none") {
    fail("portable skill-bundle callable catalog impact did not survive extraction.");
  }
  const extractedAssets = Array.isArray(extractedManifest.assets) ? extractedManifest.assets : [];
  if (extractedAssets.length !== files.length) {
    fail(
      `portable skill-bundle asset count drifted after extraction: expected ${files.length}, found ${extractedAssets.length}.`,
    );
  }
  for (const file of files) {
    const asset = extractedAssets.find((candidate) => candidate?.path === file.path);
    if (!asset) {
      fail(`portable skill-bundle manifest is missing asset ${file.path}.`);
    }
    const extractedPath = path.join(extractDir, file.path);
    if (!fs.existsSync(extractedPath)) {
      fail(`portable skill-bundle package is missing asset ${file.path} after extraction.`);
    }
    const extractedContent = fs.readFileSync(extractedPath, "utf8");
    if (asset.sha256 !== sha256(extractedContent)) {
      fail(`portable skill-bundle asset hash mismatch after extraction for ${file.path}.`);
    }
    if (file.kind === "script" && asset.callable !== false) {
      fail(`portable skill-bundle script asset ${file.path} must remain non-callable after extraction.`);
    }
  }
  return path.basename(tarball);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolvePnpmPackCommand() {
  return process.platform === "win32" ? "cmd.exe" : "pnpm";
}

function resolvePnpmPackArgs(tempDir) {
  if (process.platform !== "win32") {
    return ["pack", "--pack-destination", tempDir, "--json"];
  }
  return ["/d", "/s", "/c", `pnpm pack --pack-destination ${quoteCmdSafeArg(tempDir)} --json`];
}

function tarExtractArgs(tarball, extractDir) {
  return maybeForceLocalTarArgs(["-xzf", tarball, "-C", extractDir]);
}

function tarCreateArgs(tarball, sourceDir) {
  return maybeForceLocalTarArgs(["-czf", tarball, "-C", sourceDir, "."]);
}

function maybeForceLocalTarArgs(args) {
  return process.platform === "win32" && isGnuTar() ? ["--force-local", ...args] : args;
}

function isGnuTar() {
  if (gnuTarCache !== undefined) {
    return gnuTarCache;
  }
  const result = spawnSync("tar", ["--version"], { encoding: "utf8", shell: false });
  gnuTarCache = /gnu tar/i.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return gnuTarCache;
}

function quoteCmdSafeArg(value) {
  if (/[\s"]/u.test(value)) {
    fail(
      "Temporary pack destination contains whitespace or quote characters unsupported by the Windows pnpm pack verifier.",
    );
  }
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
