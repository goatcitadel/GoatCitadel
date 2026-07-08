import assert from "node:assert/strict";
import test from "node:test";
import {
  collectInstallerUpdatePostureFindings,
  collectSupplyChainPostureFindings,
  isPinnedDependencySpecifier,
  parsePnpmLockImporters,
  parsePnpmLockOverrides,
} from "./verify-supply-chain-posture.mjs";

const frozenInstallPs1 = "pnpm install --frozen-lockfile; $env:GOATCITADEL_INSTALL_ALLOW_LOCKFILE_REFRESH";
const frozenInstallSh = "pnpm install --frozen-lockfile; GOATCITADEL_INSTALL_ALLOW_LOCKFILE_REFRESH=1";
const frozenInstallLauncher =
  "pnpm install --frozen-lockfile; GOATCITADEL_INSTALL_ALLOW_LOCKFILE_REFRESH; --no-frozen-lockfile";

test("supply-chain posture flags ranged direct deps, dist tags, and mutable overrides", () => {
  const findings = collectSupplyChainPostureFindings({
    manifestPaths: ["package.json"],
    lockfileSource: `
lockfileVersion: '9.0'
overrides:
  lodash: ^4.18.0
importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.18.1
    devDependencies:
      typescript-7:
        specifier: npm:typescript@beta
        version: typescript@7.0.2
`,
    readTextFile: (filePath) => {
      if (filePath === "package.json") {
        return JSON.stringify({
          packageManager: "pnpm@latest",
          pnpm: { overrides: { lodash: "^4.18.0" } },
          dependencies: { lodash: "^4.17.21" },
          devDependencies: { "typescript-7": "npm:typescript@beta" },
        });
      }
      if (filePath === "install.ps1") return frozenInstallPs1;
      if (filePath === "install.sh") return frozenInstallSh;
      if (filePath === "bin/goatcitadel.mjs") return frozenInstallLauncher;
      return "pnpm install --frozen-lockfile";
    },
    rootDir: ".",
  });

  assert.deepEqual(
    findings.map((finding) => finding.code).sort(),
    [
      "UNPINNED_DIRECT_DEPENDENCY",
      "UNPINNED_DIRECT_DEPENDENCY",
      "UNPINNED_LOCKFILE_OVERRIDE",
      "UNPINNED_PACKAGE_MANAGER",
      "UNPINNED_PNPM_OVERRIDE",
    ].sort(),
  );
});

test("supply-chain posture flags manifest and lockfile specifier drift", () => {
  const findings = collectSupplyChainPostureFindings({
    manifestPaths: ["package.json"],
    lockfileSource: `
lockfileVersion: '9.0'
overrides:
  lodash: 4.18.1
importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.18.1
`,
    readTextFile: (filePath) => {
      if (filePath === "package.json") {
        return JSON.stringify({
          packageManager: "pnpm@10.31.0",
          pnpm: { overrides: { lodash: "4.18.1" } },
          dependencies: { lodash: "4.18.1" },
        });
      }
      if (filePath === "install.ps1") return frozenInstallPs1;
      if (filePath === "install.sh") return frozenInstallSh;
      if (filePath === "bin/goatcitadel.mjs") return frozenInstallLauncher;
      return "pnpm install --frozen-lockfile";
    },
    rootDir: ".",
  });

  assert.deepEqual(findings.map((finding) => finding.code), ["LOCKFILE_SPECIFIER_MISMATCH"]);
});

test("supply-chain posture accepts exact versions and local protocol specs", () => {
  const findings = collectSupplyChainPostureFindings({
    manifestPaths: ["package.json", "packages/contracts/package.json"],
    lockfileSource: `
lockfileVersion: '9.0'
overrides:
  '@webgpu/types': link:vendor/webgpu-types-stub
  lodash: 4.18.1
importers:

  .:
    dependencies:
      shell-quote:
        specifier: 1.8.4
        version: 1.8.4
    devDependencies:
      typescript:
        specifier: npm:@typescript/typescript6@6.0.2
        version: '@typescript/typescript6@6.0.2'
      typescript-7:
        specifier: npm:typescript@7.0.2
        version: typescript@7.0.2
  packages/contracts:
    dependencies:
      '@goatcitadel/storage':
        specifier: workspace:*
        version: link:../storage
      zod:
        specifier: 3.25.76
        version: 3.25.76
`,
    readTextFile: (filePath) => {
      if (filePath === "package.json") {
        return JSON.stringify({
          packageManager: "pnpm@10.31.0",
          pnpm: { overrides: { "@webgpu/types": "link:vendor/webgpu-types-stub", lodash: "4.18.1" } },
          dependencies: { "shell-quote": "1.8.4" },
          devDependencies: {
            typescript: "npm:@typescript/typescript6@6.0.2",
            "typescript-7": "npm:typescript@7.0.2",
          },
        });
      }
      if (filePath === "packages/contracts/package.json") {
        return JSON.stringify({
          dependencies: { "@goatcitadel/storage": "workspace:*", zod: "3.25.76" },
        });
      }
      if (filePath === "install.ps1") return frozenInstallPs1;
      if (filePath === "install.sh") return frozenInstallSh;
      if (filePath === "bin/goatcitadel.mjs") return frozenInstallLauncher;
      return "pnpm install --frozen-lockfile";
    },
    rootDir: ".",
  });

  assert.equal(findings.length, 0);
});

test("installer and workflow posture requires frozen installs and explicit lockfile recovery opt-in", () => {
  const findings = collectInstallerUpdatePostureFindings({
    workflowPaths: [".github/workflows/code-quality.yml"],
    readTextFile: (filePath) => {
      if (filePath === "install.ps1") return "pnpm install --no-frozen-lockfile";
      if (filePath === "install.sh") return "pnpm install";
      if (filePath === "bin/goatcitadel.mjs") return "pnpm install --no-frozen-lockfile";
      return "run: pnpm install";
    },
    rootDir: ".",
  });

  assert.deepEqual(
    findings.map((finding) => finding.code).sort(),
    [
      "INSTALLER_MUTABLE_LOCKFILE_INSTALL",
      "INSTALLER_MUTABLE_LOCKFILE_INSTALL",
      "INSTALLER_MUTABLE_LOCKFILE_INSTALL",
      "INSTALLER_UNGOVERNED_LOCKFILE_REFRESH",
      "INSTALLER_UNGOVERNED_LOCKFILE_REFRESH",
      "INSTALLER_UNGOVERNED_LOCKFILE_REFRESH",
      "WORKFLOW_MUTABLE_LOCKFILE_INSTALL",
    ].sort(),
  );
});

test("pnpm lock parser reads importers and overrides without a YAML dependency", () => {
  const source = `
lockfileVersion: '9.0'
overrides:
  '@babel/core@^7.0.0': 7.29.6
  esbuild: 0.28.1
importers:

  packages/mission-control-shared:
    dependencies:
      '@assistant-ui/react':
        specifier: 0.12.25
        version: 0.12.25(react@19.2.5)
`;

  const importers = parsePnpmLockImporters(source);
  const overrides = parsePnpmLockOverrides(source);

  assert.equal(
    importers.get("packages/mission-control-shared")?.get("dependencies")?.get("@assistant-ui/react")?.specifier,
    "0.12.25",
  );
  assert.equal(overrides.get("@babel/core@^7.0.0"), "7.29.6");
  assert.equal(overrides.get("esbuild"), "0.28.1");
});

test("dependency specifier predicate allows only exact versions or local protocols", () => {
  assert.equal(isPinnedDependencySpecifier("1.2.3"), true);
  assert.equal(isPinnedDependencySpecifier("1.2.3-beta.4"), true);
  assert.equal(isPinnedDependencySpecifier("npm:typescript@7.0.2"), true);
  assert.equal(isPinnedDependencySpecifier("npm:@typescript/typescript6@6.0.2"), true);
  assert.equal(isPinnedDependencySpecifier("workspace:*"), true);
  assert.equal(isPinnedDependencySpecifier("link:vendor/example"), true);
  assert.equal(isPinnedDependencySpecifier("^1.2.3"), false);
  assert.equal(isPinnedDependencySpecifier("npm:typescript@beta"), false);
  assert.equal(isPinnedDependencySpecifier("latest"), false);
  assert.equal(isPinnedDependencySpecifier("beta"), false);
});
