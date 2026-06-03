import { spawnSync } from "node:child_process";
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
  const tar = spawnSync("tar", ["-xzf", tarball, "-C", extractDir], {
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
  console.log(`Verified extensions-sdk package artifact: ${path.basename(tarball)}`);
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

function resolvePnpmPackCommand() {
  return process.platform === "win32" ? "cmd.exe" : "pnpm";
}

function resolvePnpmPackArgs(tempDir) {
  if (process.platform !== "win32") {
    return ["pack", "--pack-destination", tempDir, "--json"];
  }
  return ["/d", "/s", "/c", `pnpm pack --pack-destination ${quoteCmdSafeArg(tempDir)} --json`];
}

function quoteCmdSafeArg(value) {
  if (/[\s"]/u.test(value)) {
    fail("Temporary pack destination contains whitespace or quote characters unsupported by the Windows pnpm pack verifier.");
  }
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
