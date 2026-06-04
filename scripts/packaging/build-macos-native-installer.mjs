#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requirePackagingTarget } from "./lib/packaging-targets.mjs";
import { renderMacTauriConfig } from "./lib/package-renderers.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const desktopDir = path.join(repoRoot, "apps", "mission-control-desktop");
const desktopTauriDir = path.join(desktopDir, "src-tauri");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const allowedTargets = ["macos-arm64"];

const args = parseArgs(process.argv.slice(2));
const target = args.target;
let targetInfo;
try {
  targetInfo = requirePackagingTarget(target, { allowedTargets });
} catch {
  printUsage();
  process.exit(1);
}

const version = args.version || packageJson.version;
const outDir = path.resolve(args.outDir || path.join(repoRoot, "artifacts", "installers", "macos"));
const bundleDir = path.resolve(
  args.bundleDir ||
    path.join(repoRoot, "artifacts", "installers", "bundles", `GoatCitadel-${version}-${target}`),
);
const configPath = path.resolve(args.configOut || path.join(outDir, `GoatCitadel-${target}.tauri.conf.json`));
const dmgFileName = `GoatCitadel-${version}-${target}.dmg`;
const outDmgPath = path.join(outDir, dmgFileName);
const signingIdentity = args.signingIdentity || process.env.GOATCITADEL_MACOS_SIGNING_IDENTITY || "-";

await main();

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  writeMacTauriConfig(configPath, bundleDir);

  if (args.emitOnly) {
    console.log(`Wrote macOS Tauri config: ${configPath}`);
    return;
  }

  if (process.platform !== "darwin") {
    throw new Error("macOS DMG packaging must run on macOS because Tauri app bundles, ad-hoc signing, and DMG creation require Apple tooling.");
  }

  if (!fs.existsSync(bundleDir)) {
    runNode([
      path.join(scriptDir, "build-bundle.mjs"),
      "--target",
      target,
      "--version",
      version,
      "--skip-desktop",
      ...(args.skipBuild ? ["--skip-build"] : []),
      ...(args.nodeVersion ? ["--node-version", args.nodeVersion] : []),
      ...(args.nodeSha256 ? ["--node-sha256", args.nodeSha256] : []),
    ]);
  }

  if (!fs.existsSync(path.join(bundleDir, "app", "release-manifest.json"))) {
    throw new Error(`macOS bundle directory is missing app/release-manifest.json: ${bundleDir}`);
  }

  ensureRustTarget(targetInfo.tauriTriple);
  if (!args.skipBuild) {
    runPnpm(["--dir", desktopDir, "build"]);
  }
  runPnpm([
    "--dir",
    desktopDir,
    "exec",
    "tauri",
    "build",
    "--target",
    targetInfo.tauriTriple,
    "--config",
    configPath,
    "--bundles",
    "dmg",
  ]);

  const builtDmg = findBuiltDmg(targetInfo.tauriTriple);
  fs.copyFileSync(builtDmg, outDmgPath);
  if (args.notarize) {
    notarizeAndStapleDmg(outDmgPath);
  }
  fs.writeFileSync(`${outDmgPath}.sha256`, `${sha256(outDmgPath)} *${path.basename(outDmgPath)}\n`, "utf8");
  console.log(`Built experimental macOS installer: ${outDmgPath}`);
}

function parseArgs(argv) {
  const parsed = { emitOnly: false, skipBuild: false, notarize: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--target") {
      parsed.target = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--version") {
      parsed.version = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--bundle-dir") {
      parsed.bundleDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--out-dir") {
      parsed.outDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--node-version") {
      parsed.nodeVersion = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--node-sha256") {
      parsed.nodeSha256 = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--config-out") {
      parsed.configOut = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--signing-identity") {
      parsed.signingIdentity = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--notarize") {
      parsed.notarize = true;
      continue;
    }
    if (value === "--notary-apple-id") {
      parsed.notaryAppleId = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--notary-team-id") {
      parsed.notaryTeamId = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--notary-password") {
      parsed.notaryPassword = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--skip-build") {
      parsed.skipBuild = true;
      continue;
    }
    if (value === "--emit-only") {
      parsed.emitOnly = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

function printUsage() {
  console.log(
    "Usage: node scripts/packaging/build-macos-native-installer.mjs --target <macos-arm64> [--version <semver>] [--bundle-dir <dir>] [--out-dir <dir>] [--node-version <vX.Y.Z>] [--node-sha256 <hex>] [--config-out <path>] [--signing-identity <identity>] [--notarize --notary-apple-id <id> --notary-team-id <team> --notary-password <password>] [--skip-build] [--emit-only]",
  );
}

function writeMacTauriConfig(currentConfigPath, currentBundleDir) {
  const config = renderMacTauriConfig({
    bundleDir: path.resolve(currentBundleDir),
    version,
    signingIdentity,
  });
  fs.mkdirSync(path.dirname(currentConfigPath), { recursive: true });
  fs.writeFileSync(currentConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function notarizeAndStapleDmg(dmgPath) {
  const appleId = args.notaryAppleId || process.env.GOATCITADEL_MACOS_NOTARY_APPLE_ID;
  const teamId = args.notaryTeamId || process.env.GOATCITADEL_MACOS_NOTARY_TEAM_ID;
  const password = args.notaryPassword || process.env.GOATCITADEL_MACOS_NOTARY_PASSWORD;
  if (!appleId || !teamId || !password) {
    throw new Error(
      "macOS notarization requires --notary-apple-id, --notary-team-id, and --notary-password, or matching GOATCITADEL_MACOS_NOTARY_* environment variables.",
    );
  }

  runCommand("xcrun", [
    "notarytool",
    "submit",
    dmgPath,
    "--apple-id",
    appleId,
    "--team-id",
    teamId,
    "--password",
    password,
    "--wait",
  ]);
  runCommand("xcrun", ["stapler", "staple", dmgPath]);
  runCommand("xcrun", ["stapler", "validate", dmgPath]);
}

function runNode(nodeArgs) {
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  assertSuccessful(result, `node ${nodeArgs.join(" ")}`);
}

function runPnpm(pnpmArgs) {
  const result = spawnSync("pnpm", pnpmArgs, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  assertSuccessful(result, `pnpm ${pnpmArgs.join(" ")}`);
}

function runCommand(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  assertSuccessful(result, `${command} ${commandArgs.join(" ")}`);
}

function ensureRustTarget(triple) {
  const result = spawnSync("rustup", ["target", "add", triple], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error && result.error.code === "ENOENT") {
    return;
  }
  assertSuccessful(result, `rustup target add ${triple}`);
}

function assertSuccessful(result, label) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} exited with code ${result.status}`);
  }
}

function findBuiltDmg(triple) {
  const roots = [
    path.join(desktopTauriDir, "target", triple, "release", "bundle", "dmg"),
    path.join(desktopTauriDir, "target", "release", "bundle", "dmg"),
  ];
  const matches = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".dmg")) {
        matches.push(path.join(root, entry.name));
      }
    }
  }
  matches.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  const match = matches[0];
  if (!match) {
    throw new Error(`Unable to locate built macOS DMG under ${roots.join(", ")}`);
  }
  return match;
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
