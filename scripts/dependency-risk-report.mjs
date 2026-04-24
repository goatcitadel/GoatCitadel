#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const rootPackagePath = path.join(root, "package.json");
const pnpmWorkspacePath = path.join(root, "pnpm-workspace.yaml");
const nativeRiskPattern =
  /(better-sqlite3|sharp|esbuild|playwright|onnx|sqlite|canvas|node-gyp|ffi|serialport|keytar)/i;
const buildRiskPattern = /(postinstall|install|prepare|prebuild|node-gyp|cmake|cargo|make)/i;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseArgs(rawArgs) {
  const parsed = {
    out: undefined,
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--out") {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--out requires a file path");
      }
      parsed.out = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      parsed.out = arg.slice("--out=".length);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function listPackageJsonFiles() {
  const files = [rootPackagePath];
  for (const folder of ["apps", "packages"]) {
    const absoluteFolder = path.join(root, folder);
    if (!fs.existsSync(absoluteFolder)) {
      continue;
    }
    for (const entry of fs.readdirSync(absoluteFolder, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(absoluteFolder, entry.name, "package.json");
      if (fs.existsSync(candidate)) {
        files.push(candidate);
      }
    }
  }
  return files;
}

function classifyDependencies(pkg) {
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  return Object.entries(deps)
    .filter(([name]) => nativeRiskPattern.test(name))
    .map(([name, version]) => ({ name, version, risk: "native_or_browser_runtime" }));
}

function classifyBuildScripts(pkg) {
  return Object.entries(pkg.scripts ?? {})
    .filter(([, command]) => buildRiskPattern.test(String(command)))
    .map(([name, command]) => ({ name, command }));
}

const packageFiles = listPackageJsonFiles();
const packages = packageFiles.map((filePath) => {
  const pkg = readJson(filePath);
  return {
    name: pkg.name ?? path.basename(path.dirname(filePath)),
    path: path.relative(root, filePath).replaceAll("\\", "/"),
    private: Boolean(pkg.private),
    owner: pkg.goatcitadelOwner ?? pkg.owner ?? null,
    nativeRiskDependencies: classifyDependencies(pkg),
    buildRiskScripts: classifyBuildScripts(pkg),
  };
});

const missingOwnerMetadata = packages
  .filter((pkg) => pkg.path !== "package.json" && !pkg.owner)
  .map((pkg) => ({ name: pkg.name, path: pkg.path }));

const report = {
  generatedAt: new Date().toISOString(),
  root: {
    packageJson: fs.existsSync(rootPackagePath),
    pnpmWorkspace: fs.existsSync(pnpmWorkspacePath),
    packageCount: packages.length,
  },
  packageClosure: packages.map((pkg) => ({
    name: pkg.name,
    path: pkg.path,
    private: pkg.private,
  })),
  nativeOrBuildRiskPackages: packages
    .filter((pkg) => pkg.nativeRiskDependencies.length > 0 || pkg.buildRiskScripts.length > 0)
    .map((pkg) => ({
      name: pkg.name,
      path: pkg.path,
      nativeRiskDependencies: pkg.nativeRiskDependencies,
      buildRiskScripts: pkg.buildRiskScripts,
    })),
  missingOwnerMetadata,
  releaseArtifactOutput: {
    bundleScript: "pnpm package:bundle",
    windowsInstallerScript: "pnpm package:windows",
    bootstrapInstallerScript: "pnpm package:windows:bootstrap",
  },
};

const options = parseArgs(args);
const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (options.out) {
  const outputPath = path.resolve(root, options.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, rendered, "utf8");
}
process.stdout.write(rendered);
