import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validatePnpmSbom } from "./validate-pnpm-sbom.mjs";

// The release SBOM validator refuses to run while NODE_PATH is set (module-resolution
// poisoning guard). CI runners (pnpm/setup-node) export NODE_PATH, which would trip every
// happy-path validation below, so clear it here to mirror the clean release environment.
// The dedicated poisoning test sets and restores NODE_PATH within its own scope.
delete process.env.NODE_PATH;

test("accepts exact required edges while documenting optional and direct-alias omissions", (t) => {
  const fixture = makeFixture(t);

  assert.deepEqual(validatePnpmSbom(fixture), {
    cdxgenVersion: "12.7.1",
    specVersion: "1.6",
    packageCount: 2,
    importerCount: 2,
    workspaceCount: 1,
    dependencyRefCount: 4,
    dependencyEdgeCount: 4,
    omittedImporterAliasEdges: 1,
    omittedOptionalEdges: 1,
  });
});

test("rejects a missing optional or platform-specific lock package", (t) => {
  const fixture = makeFixture(t);
  const bom = readBom(fixture);
  bom.components = bom.components.filter((component) => component.name !== "optional-platform");
  writeBom(fixture, bom);

  assert.throws(
    () => validatePnpmSbom(fixture),
    /canonical pnpm package identities mismatch: missing=.*optional-platform/u,
  );
});

test("rejects an SBOM package absent from the frozen lock", (t) => {
  const fixture = makeFixture(t);
  const bom = readBom(fixture);
  bom.components.push(component("injected", "9.9.9"));
  bom.dependencies.push({ ref: ref("injected", "9.9.9"), dependsOn: [] });
  writeBom(fixture, bom);

  assert.throws(
    () => validatePnpmSbom(fixture),
    /canonical pnpm package identities mismatch: missing=none; extra=.*injected/u,
  );
});

test("rejects a peer-expanded snapshot without a canonical package identity", (t) => {
  const fixture = makeFixture(t);
  const lockPath = path.join(fixture.repoRoot, "pnpm-lock.yaml");
  fs.appendFileSync(lockPath, "\n  injected@9.9.9(peer@1.0.0):\n    optional: true\n", "utf8");

  assert.throws(
    () => validatePnpmSbom(fixture),
    /snapshot injected@9\.9\.9\(peer@1\.0\.0\) does not collapse to a canonical packages entry/u,
  );
});

test("rejects a missing workspace importer component", (t) => {
  const fixture = makeFixture(t);
  const bom = readBom(fixture);
  bom.metadata.component.components = [];
  bom.dependencies = bom.dependencies.filter((dependency) => dependency.ref !== ref("@example/app", "1.0.0"));
  writeBom(fixture, bom);

  assert.throws(() => validatePnpmSbom(fixture), /workspace importer identities mismatch: missing=.*@example.*app/u);
});

test("rejects a workspace component not bound to its importer path", (t) => {
  const fixture = makeFixture(t);
  const bom = readBom(fixture);
  const properties = bom.metadata.component.components[0].properties;
  properties.find((property) => property.name === "SrcFile").value = "apps/other/package.json";
  writeBom(fixture, bom);

  assert.throws(() => validatePnpmSbom(fixture), /is not bound to apps\/app\/package\.json/u);
});

test("rejects a missing dependency graph ref even when component identities are complete", (t) => {
  const fixture = makeFixture(t);
  const bom = readBom(fixture);
  bom.dependencies = bom.dependencies.filter((dependency) => dependency.ref !== ref("optional-platform", "2.0.0"));
  writeBom(fixture, bom);

  assert.throws(() => validatePnpmSbom(fixture), /SBOM dependency refs mismatch: missing=.*optional-platform/u);
});

test("rejects dependency edges to identities outside the package and importer inventory", (t) => {
  const fixture = makeFixture(t);
  const bom = readBom(fixture);
  bom.dependencies[0].dependsOn.push(ref("injected", "9.9.9"));
  writeBom(fixture, bom);

  assert.throws(() => validatePnpmSbom(fixture), /points to unknown ref .*injected/u);
});

test("rejects a missing non-alias workspace direct edge", (t) => {
  const fixture = makeFixture(t);
  const bom = readBom(fixture);
  const workspaceDependency = bom.dependencies.find((dependency) => dependency.ref === ref("@example/app", "1.0.0"));
  workspaceDependency.dependsOn = [];
  writeBom(fixture, bom);

  assert.throws(
    () => validatePnpmSbom(fixture),
    /required pnpm dependency edges mismatch: missing=.*@example\/app.*optional-platform/u,
  );
});

test("rejects a missing canonical required snapshot edge", (t) => {
  const fixture = makeFixture(t);
  const bom = readBom(fixture);
  const packageDependency = bom.dependencies.find((dependency) => dependency.ref === ref("dependency", "1.0.0"));
  packageDependency.dependsOn = [];
  writeBom(fixture, bom);

  assert.throws(
    () => validatePnpmSbom(fixture),
    /required pnpm dependency edges mismatch: missing=.*dependency@1\.0\.0.*optional-platform/u,
  );
});

test("rejects a non-1.6 CycloneDX document", (t) => {
  const fixture = makeFixture(t);
  const bom = readBom(fixture);
  bom.specVersion = "1.7";
  writeBom(fixture, bom);

  assert.throws(() => validatePnpmSbom(fixture), /SBOM must use CycloneDX 1\.6/u);
});

test("rejects a root manifest that does not exactly pin cdxgen", (t) => {
  const fixture = makeFixture(t);
  const manifestPath = path.join(fixture.repoRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.devDependencies["@cyclonedx/cdxgen"] = "^12.7.1";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  assert.throws(() => validatePnpmSbom(fixture), /package\.json must pin @cyclonedx\/cdxgen exactly to 12\.7\.1/u);
});

test("rejects NODE_PATH module-resolution poisoning", (t) => {
  const fixture = makeFixture(t);
  const originalNodePath = process.env.NODE_PATH;
  process.env.NODE_PATH = path.join(fixture.repoRoot, "untrusted-modules");
  t.after(() => {
    if (originalNodePath === undefined) {
      delete process.env.NODE_PATH;
    } else {
      process.env.NODE_PATH = originalNodePath;
    }
  });

  assert.throws(() => validatePnpmSbom(fixture), /NODE_PATH must be unset/u);
});

function makeFixture(t) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-pnpm-sbom-"));
  const sbomFile = path.join(repoRoot, "bom.json");
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  fs.mkdirSync(path.join(repoRoot, "apps", "app"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture-root",
        version: "1.0.0",
        devDependencies: { "@cyclonedx/cdxgen": "12.7.1" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoRoot, "apps", "app", "package.json"),
    `${JSON.stringify({ name: "@example/app", version: "1.0.0" }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoRoot, "pnpm-lock.yaml"),
    [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      dependency:",
      "        specifier: 1.0.0",
      "        version: 1.0.0",
      "    devDependencies:",
      "      '@cyclonedx/cdxgen':",
      "        specifier: 12.7.1",
      "        version: 12.7.1",
      "  apps/app:",
      "    dependencies:",
      "      optional-platform:",
      "        specifier: 2.0.0",
      "        version: 2.0.0(peer-helper@1.0.0)",
      "    devDependencies:",
      "      dependency-alias:",
      "        specifier: npm:dependency@1.0.0",
      "        version: dependency@1.0.0",
      "packages:",
      "  dependency@1.0.0:",
      "    resolution: {integrity: sha512-test}",
      "  optional-platform@2.0.0:",
      "    resolution: {integrity: sha512-test}",
      "    cpu: [x64]",
      "    os: [linux]",
      "snapshots:",
      "  dependency@1.0.0:",
      "    dependencies:",
      "      optional-platform: 2.0.0(peer-helper@1.0.0)",
      "  optional-platform@2.0.0(peer-helper@1.0.0):",
      "    optional: true",
      "    optionalDependencies:",
      "      dependency: 1.0.0",
      "",
    ].join("\n"),
    "utf8",
  );
  writeBom({ sbomFile }, validBom());
  return { repoRoot, sbomFile };
}

function validBom() {
  const root = component("fixture-root", "1.0.0", "application");
  const workspace = component("@example/app", "1.0.0", "application");
  workspace.properties = [
    { name: "internal:is_workspace", value: "true" },
    { name: "SrcFile", value: "apps/app/package.json" },
    { name: "internal:virtual_path", value: "apps/app" },
  ];
  root.components = [workspace];

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: { component: root },
    components: [component("dependency", "1.0.0"), component("optional-platform", "2.0.0")],
    dependencies: [
      { ref: root["bom-ref"], dependsOn: [workspace["bom-ref"], ref("dependency", "1.0.0")] },
      { ref: workspace["bom-ref"], dependsOn: [ref("optional-platform", "2.0.0")] },
      { ref: ref("dependency", "1.0.0"), dependsOn: [ref("optional-platform", "2.0.0")] },
      { ref: ref("optional-platform", "2.0.0"), dependsOn: [] },
    ],
  };
}

function component(packageName, version, type = "library") {
  const slashIndex = packageName.startsWith("@") ? packageName.indexOf("/") : -1;
  const group = slashIndex === -1 ? "" : packageName.slice(0, slashIndex);
  const name = slashIndex === -1 ? packageName : packageName.slice(slashIndex + 1);
  const bomRef = ref(packageName, version);
  const purl = packageName.startsWith("@") ? `pkg:npm/${encodeURIComponent(group)}/${name}@${version}` : bomRef;
  return { group, name, version, purl, type, "bom-ref": bomRef };
}

function ref(packageName, version) {
  return `pkg:npm/${packageName}@${version}`;
}

function readBom(fixture) {
  return JSON.parse(fs.readFileSync(fixture.sbomFile, "utf8"));
}

function writeBom(fixture, bom) {
  fs.writeFileSync(fixture.sbomFile, `${JSON.stringify(bom, null, 2)}\n`, "utf8");
}
