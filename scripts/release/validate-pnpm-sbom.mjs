#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_CDXGEN_VERSION = "12.7.1";
const EXPECTED_CYCLONEDX_SPEC_VERSION = "1.6";
const MAX_INPUT_BYTES = 32 * 1024 * 1024;

export function validatePnpmSbom({ repoRoot, sbomFile, expectedCdxgenVersion = EXPECTED_CDXGEN_VERSION } = {}) {
  if (process.env.NODE_PATH) {
    throw new Error("NODE_PATH must be unset while validating the release SBOM.");
  }

  const resolvedRepoRoot = path.resolve(repoRoot ?? path.resolve(fileURLToPath(import.meta.url), "../../.."));
  const resolvedSbomFile = path.resolve(
    sbomFile ?? path.join(resolvedRepoRoot, "artifacts", "release", "goatcitadel.cyclonedx.json"),
  );
  const packageJsonPath = path.join(resolvedRepoRoot, "package.json");
  const lockfilePath = path.join(resolvedRepoRoot, "pnpm-lock.yaml");

  const installedCdxgen = resolveInstalledCdxgen();
  if (installedCdxgen.version !== expectedCdxgenVersion) {
    throw new Error(
      `Resolved @cyclonedx/cdxgen version ${installedCdxgen.version} does not match ${expectedCdxgenVersion}.`,
    );
  }

  const rootManifest = readJsonFile(packageJsonPath, "root package manifest");
  if (rootManifest.devDependencies?.["@cyclonedx/cdxgen"] !== expectedCdxgenVersion) {
    throw new Error(`Root package.json must pin @cyclonedx/cdxgen exactly to ${expectedCdxgenVersion}.`);
  }

  const lock = installedCdxgen.parseYaml(readBoundedRegularFile(lockfilePath, "pnpm lockfile"));
  if (!isRecord(lock) || String(lock.lockfileVersion) !== "9.0") {
    throw new Error("Release SBOM validation requires a pnpm lockfileVersion 9.0 object.");
  }
  if (!isRecord(lock.importers) || !isRecord(lock.packages) || !isRecord(lock.snapshots)) {
    throw new Error("pnpm lockfile must contain importers, packages, and snapshots maps.");
  }

  const lockedCdxgen = lock.importers["."]?.devDependencies?.["@cyclonedx/cdxgen"];
  if (
    !isRecord(lockedCdxgen) ||
    lockedCdxgen.specifier !== expectedCdxgenVersion ||
    lockedCdxgen.version !== expectedCdxgenVersion
  ) {
    throw new Error(`Root pnpm importer must lock @cyclonedx/cdxgen exactly to ${expectedCdxgenVersion}.`);
  }

  const bom = readJsonFile(resolvedSbomFile, "CycloneDX SBOM");
  if (bom.bomFormat !== "CycloneDX" || String(bom.specVersion) !== EXPECTED_CYCLONEDX_SPEC_VERSION) {
    throw new Error(
      `SBOM must use CycloneDX ${EXPECTED_CYCLONEDX_SPEC_VERSION}; received ${String(bom.bomFormat)} ${String(bom.specVersion)}.`,
    );
  }
  if (!Array.isArray(bom.components) || !Array.isArray(bom.dependencies)) {
    throw new Error("SBOM must contain components and dependencies arrays.");
  }
  if (!isRecord(bom.metadata?.component)) {
    throw new Error("SBOM must contain metadata.component.");
  }

  // pnpm v9's packages map is the canonical resolved identity inventory. Every
  // entry is required, including optional and platform-specific packages.
  // Peer-expanded snapshot keys are graph variants, not additional package
  // identities; each must collapse back to one canonical packages-map entry.
  const lockPackageIdentities = new Set();
  const lockPackageRefsByKey = new Map();
  for (const packageKey of Object.keys(lock.packages)) {
    const identity = parsePnpmPackageKey(packageKey, { allowPeerSuffix: false });
    addUnique(lockPackageIdentities, identity.key, `pnpm packages identity ${identity.label}`);
    lockPackageRefsByKey.set(packageKey, identity.ref);
  }

  for (const snapshotKey of Object.keys(lock.snapshots)) {
    const identity = parsePnpmPackageKey(snapshotKey, { allowPeerSuffix: true });
    if (!lockPackageIdentities.has(identity.key)) {
      throw new Error(
        `pnpm snapshot ${snapshotKey} does not collapse to a canonical packages entry (${identity.label}).`,
      );
    }
  }

  const bomPackageIdentities = new Set();
  const packageRefs = new Set();
  for (const component of bom.components) {
    const identity = validateBomComponentIdentity(component, "SBOM package component");
    addUnique(bomPackageIdentities, identity.key, `SBOM package identity ${identity.label}`);
    addUnique(packageRefs, component["bom-ref"], `SBOM package bom-ref ${component["bom-ref"]}`);
  }
  assertExactSet("canonical pnpm package identities", lockPackageIdentities, bomPackageIdentities);

  const importerRecords = readImporterRecords(resolvedRepoRoot, lock.importers);
  const rootImporter = importerRecords.get(".");
  if (!rootImporter) {
    throw new Error("pnpm lockfile must contain the root importer '.'.");
  }

  const rootBomIdentity = validateBomComponentIdentity(bom.metadata.component, "SBOM root component");
  if (rootBomIdentity.key !== rootImporter.identity.key) {
    throw new Error(
      `SBOM root identity ${rootBomIdentity.label} does not match root importer ${rootImporter.identity.label}.`,
    );
  }

  const workspaceComponents = bom.metadata.component.components;
  if (!Array.isArray(workspaceComponents)) {
    throw new Error("SBOM metadata.component.components must enumerate every non-root workspace importer.");
  }

  const expectedWorkspaceIdentities = new Set();
  const expectedImporterByIdentity = new Map();
  for (const [importerPath, importer] of importerRecords) {
    if (importerPath === ".") {
      continue;
    }
    addUnique(
      expectedWorkspaceIdentities,
      importer.identity.key,
      `workspace importer identity ${importer.identity.label}`,
    );
    expectedImporterByIdentity.set(importer.identity.key, importerPath);
  }

  const actualWorkspaceIdentities = new Set();
  const workspaceRefs = new Set();
  for (const component of workspaceComponents) {
    const identity = validateBomComponentIdentity(component, "SBOM workspace component");
    addUnique(actualWorkspaceIdentities, identity.key, `SBOM workspace identity ${identity.label}`);
    addUnique(workspaceRefs, component["bom-ref"], `SBOM workspace bom-ref ${component["bom-ref"]}`);

    const importerPath = expectedImporterByIdentity.get(identity.key);
    if (!importerPath) {
      continue;
    }
    const properties = propertiesToMultiMap(component.properties);
    const sourceFiles = properties.get("SrcFile") ?? [];
    const virtualPaths = properties.get("internal:virtual_path") ?? [];
    if (!(properties.get("internal:is_workspace") ?? []).includes("true")) {
      throw new Error(`Workspace component ${identity.label} is missing internal:is_workspace=true.`);
    }
    const expectedManifest = `${importerPath}/package.json`;
    if (!sourceFiles.map(normalizePortablePath).includes(expectedManifest)) {
      throw new Error(`Workspace component ${identity.label} is not bound to ${expectedManifest}.`);
    }
    if (!virtualPaths.map(normalizePortablePath).includes(importerPath)) {
      throw new Error(`Workspace component ${identity.label} is not bound to importer ${importerPath}.`);
    }
  }
  assertExactSet("workspace importer identities", expectedWorkspaceIdentities, actualWorkspaceIdentities);

  const expectedDependencyRefs = new Set([bom.metadata.component["bom-ref"], ...workspaceRefs, ...packageRefs]);
  const actualDependencyRefs = new Set();
  const actualDependencyEdges = new Set();
  for (const dependency of bom.dependencies) {
    if (!isRecord(dependency) || typeof dependency.ref !== "string" || !Array.isArray(dependency.dependsOn)) {
      throw new Error("Every SBOM dependency record must contain a string ref and dependsOn array.");
    }
    addUnique(actualDependencyRefs, dependency.ref, `SBOM dependency ref ${dependency.ref}`);
    const localDependsOn = new Set();
    for (const dependencyRef of dependency.dependsOn) {
      if (typeof dependencyRef !== "string") {
        throw new Error(`Dependency record ${dependency.ref} contains a non-string dependsOn ref.`);
      }
      addUnique(localDependsOn, dependencyRef, `dependsOn ref ${dependencyRef} under ${dependency.ref}`);
      if (!expectedDependencyRefs.has(dependencyRef)) {
        throw new Error(`Dependency record ${dependency.ref} points to unknown ref ${dependencyRef}.`);
      }
      addUnique(
        actualDependencyEdges,
        dependencyEdgeKey(dependency.ref, dependencyRef),
        `dependency edge ${dependency.ref} -> ${dependencyRef}`,
      );
    }
  }
  assertExactSet("SBOM dependency refs", expectedDependencyRefs, actualDependencyRefs);
  const expectedDependencyGraph = buildExpectedDependencyGraph({
    lock,
    importerRecords,
    lockPackageRefsByKey,
  });
  assertExactSet("required pnpm dependency edges", expectedDependencyGraph.edges, actualDependencyEdges);

  return {
    cdxgenVersion: installedCdxgen.version,
    specVersion: String(bom.specVersion),
    packageCount: lockPackageIdentities.size,
    importerCount: importerRecords.size,
    workspaceCount: expectedWorkspaceIdentities.size,
    dependencyRefCount: expectedDependencyRefs.size,
    dependencyEdgeCount: expectedDependencyGraph.edges.size,
    omittedImporterAliasEdges: expectedDependencyGraph.omittedImporterAliasEdges,
    omittedOptionalEdges: expectedDependencyGraph.omittedOptionalEdges,
  };
}

function buildExpectedDependencyGraph({ lock, importerRecords, lockPackageRefsByKey }) {
  const edges = new Set();
  let omittedImporterAliasEdges = 0;
  let omittedOptionalEdges = 0;

  for (const [importerPath, importerRecord] of importerRecords) {
    const importer = lock.importers[importerPath];
    const dependencyFields =
      importerPath === "." ? ["dependencies"] : ["dependencies", "devDependencies", "peerDependencies"];
    omittedOptionalEdges += Object.keys(importer.optionalDependencies ?? {}).length;

    for (const field of dependencyFields) {
      for (const [dependencyName, lockedDependency] of Object.entries(importer[field] ?? {})) {
        const target = resolveLockedDependencyTarget({
          dependencyName,
          lockedDependency,
          importerPath,
          importerRecords,
          lockPackageRefsByKey,
        });
        if (target?.isAlias) {
          // cdxgen 12.7.1 does not emit direct importer edges when a manifest
          // dependency name aliases a different locked package identity.
          // The target still remains mandatory in the component/ref inventory.
          omittedImporterAliasEdges += 1;
          continue;
        }
        if (target?.ref) {
          edges.add(dependencyEdgeKey(importerRecord.identity.ref, target.ref));
        }
      }
    }

    if (importerPath === ".") {
      for (const [workspacePath, workspace] of importerRecords) {
        if (workspacePath !== ".") {
          edges.add(dependencyEdgeKey(importerRecord.identity.ref, workspace.identity.ref));
        }
      }
    }
  }

  // cdxgen 12.7.1 emits the canonical union of required `dependencies`
  // across peer-expanded snapshots. It intentionally omits snapshot
  // optionalDependencies edges while retaining those package identities.
  for (const [snapshotKey, snapshot] of Object.entries(lock.snapshots)) {
    const source = parsePnpmPackageKey(snapshotKey, { allowPeerSuffix: true });
    omittedOptionalEdges += Object.keys(snapshot.optionalDependencies ?? {}).length;
    for (const [dependencyName, lockedDependency] of Object.entries(snapshot.dependencies ?? {})) {
      const target = resolveLockedDependencyTarget({
        dependencyName,
        lockedDependency,
        importerPath: null,
        importerRecords,
        lockPackageRefsByKey,
      });
      if (target?.ref) {
        edges.add(dependencyEdgeKey(source.ref, target.ref));
      }
    }
  }

  return { edges, omittedImporterAliasEdges, omittedOptionalEdges };
}

function resolveLockedDependencyTarget({
  dependencyName,
  lockedDependency,
  importerPath,
  importerRecords,
  lockPackageRefsByKey,
}) {
  const version = typeof lockedDependency === "string" ? lockedDependency : lockedDependency?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`Locked dependency ${dependencyName} is missing a resolved version.`);
  }

  if (version.startsWith("link:")) {
    const linkBase = importerPath && importerPath !== "." ? importerPath : "";
    const targetPath = path.posix.normalize(path.posix.join(linkBase, version.slice("link:".length)));
    return importerRecords.has(targetPath)
      ? { ref: importerRecords.get(targetPath).identity.ref, isAlias: false }
      : null;
  }

  const peerSuffixIndex = version.indexOf("(");
  const canonicalVersion = peerSuffixIndex === -1 ? version : version.slice(0, peerSuffixIndex);
  const declaredKey = `${dependencyName}@${canonicalVersion}`;
  if (lockPackageRefsByKey.has(declaredKey)) {
    return { ref: lockPackageRefsByKey.get(declaredKey), isAlias: false };
  }
  if (lockPackageRefsByKey.has(canonicalVersion)) {
    return { ref: lockPackageRefsByKey.get(canonicalVersion), isAlias: true };
  }
  throw new Error(`Locked dependency ${dependencyName}@${canonicalVersion} has no canonical packages entry.`);
}

function dependencyEdgeKey(sourceRef, targetRef) {
  return `${sourceRef} -> ${targetRef}`;
}

function readImporterRecords(repoRoot, importers) {
  const records = new Map();
  const seenIdentities = new Set();
  for (const importerKey of Object.keys(importers)) {
    const importerPath = normalizeImporterPath(importerKey);
    if (records.has(importerPath)) {
      throw new Error(`pnpm lockfile contains duplicate importer path ${importerPath}.`);
    }
    const manifestPath = path.resolve(repoRoot, importerPath, "package.json");
    assertPathWithin(repoRoot, manifestPath, `importer ${importerPath}`);
    const manifest = readJsonFile(manifestPath, `package manifest for importer ${importerPath}`);
    const identity = identityFromParts(manifest.name, manifest.version, `importer ${importerPath}`);
    addUnique(seenIdentities, identity.key, `workspace package identity ${identity.label}`);
    records.set(importerPath, { identity, manifestPath });
  }
  return records;
}

function validateBomComponentIdentity(component, label) {
  if (!isRecord(component)) {
    throw new Error(`${label} must be an object.`);
  }
  const packageName = component.group ? `${component.group}/${component.name}` : component.name;
  const identity = identityFromParts(packageName, component.version, label);
  if (typeof component.purl !== "string" || typeof component["bom-ref"] !== "string") {
    throw new Error(`${label} ${identity.label} must contain purl and bom-ref strings.`);
  }
  let decodedPurl;
  try {
    decodedPurl = decodeURIComponent(component.purl);
  } catch {
    throw new Error(`${label} ${identity.label} contains an invalid encoded purl.`);
  }
  if (decodedPurl !== component["bom-ref"] || component["bom-ref"] !== identity.ref) {
    throw new Error(`${label} ${identity.label} has inconsistent purl or bom-ref identity.`);
  }
  return identity;
}

function parsePnpmPackageKey(packageKey, { allowPeerSuffix }) {
  if (typeof packageKey !== "string" || packageKey.length === 0) {
    throw new Error("pnpm package keys must be non-empty strings.");
  }
  const peerIndex = packageKey.indexOf("(");
  if (!allowPeerSuffix && peerIndex !== -1) {
    throw new Error(`pnpm packages key must be canonical without a peer suffix: ${packageKey}`);
  }
  const canonicalKey = peerIndex === -1 ? packageKey : packageKey.slice(0, peerIndex);
  const versionSeparator = canonicalKey.lastIndexOf("@");
  if (versionSeparator <= 0 || versionSeparator === canonicalKey.length - 1) {
    throw new Error(`Unsupported pnpm package identity: ${packageKey}`);
  }
  return identityFromParts(
    canonicalKey.slice(0, versionSeparator),
    canonicalKey.slice(versionSeparator + 1),
    `pnpm package ${packageKey}`,
  );
}

function identityFromParts(packageName, version, label) {
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error(`${label} must contain a package name.`);
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${label} must contain a package version.`);
  }
  let group = "";
  let name = packageName;
  if (packageName.startsWith("@")) {
    const slashIndex = packageName.indexOf("/");
    if (slashIndex <= 1 || slashIndex === packageName.length - 1) {
      throw new Error(`${label} contains an invalid scoped package name: ${packageName}`);
    }
    group = packageName.slice(0, slashIndex);
    name = packageName.slice(slashIndex + 1);
  } else if (packageName.includes("/")) {
    throw new Error(`${label} contains an invalid unscoped package name: ${packageName}`);
  }
  const normalizedName = group ? `${group}/${name}` : name;
  return {
    group,
    name,
    version,
    key: JSON.stringify([group, name, version]),
    label: `${normalizedName}@${version}`,
    ref: `pkg:npm/${normalizedName}@${version}`,
  };
}

function resolveInstalledCdxgen() {
  const cdxgenEntry = fileURLToPath(import.meta.resolve("@cyclonedx/cdxgen"));
  let current = path.dirname(cdxgenEntry);
  while (true) {
    const packagePath = path.join(current, "package.json");
    if (fs.existsSync(packagePath)) {
      const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      if (manifest.name === "@cyclonedx/cdxgen") {
        const requireFromCdxgen = createRequire(pathToFileURL(packagePath));
        const yaml = requireFromCdxgen("yaml");
        if (typeof yaml.parse !== "function") {
          throw new Error("Resolved cdxgen YAML dependency does not expose parse().");
        }
        return { version: manifest.version, parseYaml: yaml.parse };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error("Could not resolve the installed @cyclonedx/cdxgen package metadata.");
}

function readJsonFile(filePath, label) {
  const raw = readBoundedRegularFile(filePath, label);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
}

function readBoundedRegularFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`${label} is not available at ${filePath}: ${error.message}`, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_INPUT_BYTES) {
    throw new Error(`${label} must be a non-empty regular non-link file no larger than ${MAX_INPUT_BYTES} bytes.`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function propertiesToMultiMap(properties) {
  const values = new Map();
  if (!Array.isArray(properties)) {
    return values;
  }
  for (const property of properties) {
    if (!isRecord(property) || typeof property.name !== "string" || typeof property.value !== "string") {
      continue;
    }
    const propertyValues = values.get(property.name) ?? [];
    propertyValues.push(property.value);
    values.set(property.name, propertyValues);
  }
  return values;
}

function normalizeImporterPath(importerPath) {
  if (importerPath === ".") {
    return ".";
  }
  if (
    typeof importerPath !== "string" ||
    importerPath.length === 0 ||
    path.posix.isAbsolute(importerPath) ||
    importerPath.includes("\\")
  ) {
    throw new Error(`Invalid pnpm importer path: ${String(importerPath)}`);
  }
  const normalized = path.posix.normalize(importerPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`pnpm importer escapes the repository: ${importerPath}`);
  }
  return normalized;
}

function normalizePortablePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function assertPathWithin(root, candidate, label) {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return;
  }
  throw new Error(`${label} resolves outside the repository root.`);
}

function addUnique(set, value, label) {
  if (set.has(value)) {
    throw new Error(`Duplicate ${label}.`);
  }
  set.add(value);
}

function assertExactSet(label, expected, actual) {
  const missing = [...expected].filter((value) => !actual.has(value));
  const extra = [...actual].filter((value) => !expected.has(value));
  if (missing.length || extra.length) {
    throw new Error(`${label} mismatch: missing=${formatSetDifference(missing)}; extra=${formatSetDifference(extra)}.`);
  }
}

function formatSetDifference(values) {
  if (values.length === 0) {
    return "none";
  }
  const rendered = values.slice(0, 10).join(", ");
  return values.length > 10 ? `${rendered}, ... (${values.length} total)` : rendered;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root" || arg === "--sbom-file") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      args[arg.slice(2).replace("-", "")] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = validatePnpmSbom({ repoRoot: args.reporoot, sbomFile: args.sbomfile });
  console.log(
    `SBOM validation passed: cdxgen ${result.cdxgenVersion}; CycloneDX ${result.specVersion}; ` +
      `${result.packageCount} canonical lock packages; ${result.importerCount} importers; ` +
      `${result.dependencyRefCount} dependency refs; ${result.dependencyEdgeCount} required edges; ` +
      `${result.omittedOptionalEdges} optional and ${result.omittedImporterAliasEdges} direct-alias edges explicitly omitted.`,
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
