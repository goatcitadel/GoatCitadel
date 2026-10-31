import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const packageDir = path.join(repoRoot, "packages", "extensions-sdk");
const packageJsonPath = path.join(packageDir, "package.json");
const distIndexPath = path.join(packageDir, "dist", "index.js");
// 2.0.0 keeps the effective-tool snapshot helpers and the plugin manifest
// tools. A name outside this list in the built barrel means a retired helper
// has crept back in.
const EXPECTED_EXPORTS = [
  "PLUGIN_LIMITS",
  "PLUGIN_MANIFEST_FILENAME",
  "buildToolSchemaRefIndex",
  "dereferenceEffectiveToolSchema",
  "findEffectiveToolByName",
  "listEffectiveCallableTools",
  "loadPluginManifest",
  "parsePluginManifest",
  "pluginManifestSchema",
  "validateCompactToolDirectorySnapshot",
];
// The one command the package ships, and the folder inside it that holds the
// reference plugin.
const PREFLIGHT_BIN_NAME = "goatcitadel-plugin-preflight";
const REFERENCE_PLUGIN_DIR = path.join("templates", "plugins", "reference-plugin");
let gnuTarCache;

if (!fs.existsSync(distIndexPath)) {
  fail("extensions-sdk dist is missing; run `pnpm --filter @goatcitadel/extensions-sdk build` first.");
}

const packageJson = readJson(packageJsonPath);
const sdk = await import(pathToFileURL(distIndexPath).href);
assertExportedNames(Object.keys(sdk), "built extensions-sdk barrel");
const exportTargets = collectExportTargets(packageJson);
if (exportTargets.length === 0) {
  fail("extensions-sdk package.json declares no export targets.");
}
for (const target of exportTargets) {
  if (!fs.existsSync(path.join(packageDir, target))) {
    fail(`extensions-sdk export target ${target} does not exist in the built package.`);
  }
}
const preflightBin = assertPreflightBin(packageJson, packageDir, "extensions-sdk");
const workspaceReferencePlugin = verifyReferencePlugin(packageDir, preflightBin, "workspace reference plugin");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-ext-pack-"));
try {
  const pnpmPack = resolvePnpmPackInvocation(tempDir);
  const pack = spawnSync(pnpmPack.command, pnpmPack.args, {
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
  const tar = spawnSync("tar", tarExtractArgs(toTarPath(tempDir, tarball), "extract"), {
    cwd: tempDir,
    encoding: "utf8",
    shell: false,
  });
  if (tar.error) {
    fail(tar.error.message);
  }
  if (tar.status !== 0) {
    fail(tar.stderr || tar.stdout || "tar extraction failed.");
  }
  const extractedPackageDir = path.join(extractDir, "package");
  const extractedPackageJsonPath = path.join(extractedPackageDir, "package.json");
  if (!fs.existsSync(extractedPackageJsonPath)) {
    fail("packed extensions-sdk artifact is missing package.json.");
  }
  const extractedPackageJson = readJson(extractedPackageJsonPath);
  if (extractedPackageJson.version !== packageJson.version) {
    fail(
      `packed extensions-sdk version drifted: expected ${packageJson.version}, found ${extractedPackageJson.version}.`,
    );
  }
  for (const target of collectExportTargets(extractedPackageJson)) {
    if (!fs.existsSync(path.join(extractedPackageDir, target))) {
      fail(`packed extensions-sdk artifact is missing export target ${target}.`);
    }
  }
  // The barrel and the command import @goatcitadel/contracts, which an install would put in node_modules.
  linkWorkspaceDependencies(extractedPackageJson, extractedPackageDir);
  const packedPreflightBin = assertPreflightBin(extractedPackageJson, extractedPackageDir, "packed extensions-sdk");
  const packedReferencePlugin = verifyReferencePlugin(
    extractedPackageDir,
    packedPreflightBin,
    "packed reference plugin",
  );
  if (packedReferencePlugin.manifestSha256 !== workspaceReferencePlugin.manifestSha256) {
    fail(
      `packed reference plugin drifted from the workspace copy: expected ${workspaceReferencePlugin.manifestSha256}, found ${packedReferencePlugin.manifestSha256}.`,
    );
  }
  const extractedSdk = await import(pathToFileURL(path.join(extractedPackageDir, "dist", "index.js")).href);
  assertExportedNames(Object.keys(extractedSdk), "packed extensions-sdk barrel");
  const skillBundleTarballName = verifyPortableSkillBundlePackageSurvivesExtraction(tempDir);
  console.log(`Verified extensions-sdk package artifact: ${path.basename(tarball)}`);
  console.log(`Verified reference plugin ${workspaceReferencePlugin.pluginId} in the workspace and the packed copy.`);
  console.log(`Verified portable skill-bundle package fixture: ${skillBundleTarballName}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// The package ships exactly one command, and its file must exist in the folder it is checked in.
function assertPreflightBin(manifest, root, label) {
  const names = manifest.bin && typeof manifest.bin === "object" ? Object.keys(manifest.bin) : [];
  if (names.length !== 1 || names[0] !== PREFLIGHT_BIN_NAME) {
    fail(`${label} must declare exactly the bin ${PREFLIGHT_BIN_NAME}; found ${JSON.stringify(manifest.bin)}.`);
  }
  const target = manifest.bin[PREFLIGHT_BIN_NAME];
  if (typeof target !== "string" || !fs.existsSync(path.join(root, target))) {
    fail(`${label} bin ${PREFLIGHT_BIN_NAME} points at ${JSON.stringify(target)}, which does not exist.`);
  }
  return path.join(root, target);
}

// Run the package's own preflight command on the reference plugin it ships, and check that every file the
// manifest names is there. The command only reads the folder it is given.
function verifyReferencePlugin(root, binPath, label) {
  const pluginDir = path.join(root, REFERENCE_PLUGIN_DIR);
  const run = spawnSync(process.execPath, [binPath, pluginDir], { encoding: "utf8", shell: false });
  if (run.error) {
    fail(run.error.message);
  }
  const match = /^ok (\S+) ([0-9a-f]{64})$/u.exec((run.stdout ?? "").trim());
  if (run.status !== 0 || !match) {
    fail(
      `${label} was refused by ${PREFLIGHT_BIN_NAME} (exit ${run.status}): ${(run.stderr || run.stdout || "no output").trim()}`,
    );
  }
  const manifest = readJson(path.join(pluginDir, "goatcitadel-plugin.json"));
  for (const piece of manifest.pieces) {
    const pieceFile =
      piece.kind === "skill"
        ? path.join(piece.path, "SKILL.md")
        : piece.kind === "prompt_pack"
          ? piece.path
          : undefined;
    if (pieceFile !== undefined && !fs.existsSync(path.join(pluginDir, pieceFile))) {
      fail(`${label} is missing ${pieceFile}, which piece ${piece.id} names.`);
    }
  }
  return { pluginId: match[1], manifestSha256: match[2] };
}

// Make the tarball's workspace dependencies resolvable, the way an install would.
function linkWorkspaceDependencies(manifest, root) {
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!name.startsWith("@goatcitadel/")) {
      continue;
    }
    const workspaceDir = path.join(repoRoot, "packages", name.slice("@goatcitadel/".length));
    if (!fs.existsSync(path.join(workspaceDir, "package.json"))) {
      fail(`extensions-sdk depends on ${name}, which is not a workspace package.`);
    }
    const linkPath = path.join(root, "node_modules", ...name.split("/"));
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(workspaceDir, linkPath, "junction");
  }
}

function assertExportedNames(actualNames, label) {
  const actual = [...actualNames].sort();
  const expected = [...EXPECTED_EXPORTS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} exports drifted: expected ${expected.join(", ")}, found ${actual.join(", ")}.`);
  }
}

// Relative file targets in "main", "types" and every condition of "exports".
function collectExportTargets(manifest) {
  const targets = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      targets.add(value.replace(/^\.\//u, ""));
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(manifest.main);
  visit(manifest.types);
  visit(manifest.exports);
  return [...targets].sort();
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
  const pack = spawnSync("tar", tarCreateArgs("portable-skill-bundle.tgz", "portable-skill-bundle"), {
    cwd: tempDir,
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
  const extract = spawnSync("tar", tarExtractArgs("portable-skill-bundle.tgz", "portable-skill-extract"), {
    cwd: tempDir,
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

function resolvePnpmPackInvocation(tempDir) {
  if (process.platform !== "win32") {
    return { command: "pnpm", args: ["pack", "--pack-destination", tempDir, "--json"] };
  }
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", `pnpm pack --pack-destination ${assertCmdSafeArg(tempDir)} --json`],
  };
}

/*
 * tar args MUST be relative forward-slash paths, with the spawn anchored via cwd.
 * When a native (non-MSYS) parent spawns Git-for-Windows' /usr/bin/tar, the MSYS
 * runtime re-parses the raw command line and C-escape-mangles absolute Windows
 * paths — "...\Temp\fast..." arrives as "...\Temp<formfeed>ast..." — so tar fails
 * on a path that exists. --force-local cannot help with that; relative paths
 * contain no drive colon or backslashes and work under both MSYS GNU tar and
 * Windows bsdtar regardless of PATH order.
 */
function tarExtractArgs(tarball, extractDir) {
  return maybeForceLocalTarArgs(["-xzf", tarball, "-C", extractDir]);
}

function tarCreateArgs(tarball, sourceDir) {
  return maybeForceLocalTarArgs(["-czf", tarball, "-C", sourceDir, "."]);
}

function toTarPath(baseDir, absolutePath) {
  const relative = path.relative(baseDir, absolutePath);
  return (relative === "" ? "." : relative).replaceAll("\\", "/");
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

function assertCmdSafeArg(value) {
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
