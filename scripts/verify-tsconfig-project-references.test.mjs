import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  collectProjectReferenceFindings,
  collectWorkspaceImports,
  parseWorkspacePackageGlobs,
  workspacePackageNameFromSpecifier,
} from "./verify-tsconfig-project-references.mjs";

const typescriptModule = createRequire(import.meta.url)("typescript");
const ts = typescriptModule.default ?? typescriptModule;

function project(overrides) {
  return {
    packageName: "@goatcitadel/gateway",
    directory: "apps/gateway",
    tsconfigPath: "apps/gateway/tsconfig.json",
    parseError: null,
    references: [],
    imports: [],
    ...overrides,
  };
}

const sharedProject = project({
  packageName: "@goatcitadel/mission-control-shared",
  directory: "packages/mission-control-shared",
  tsconfigPath: "packages/mission-control-shared/tsconfig.json",
});

test("project references flag a workspace import that is not declared", () => {
  const findings = collectProjectReferenceFindings({
    projects: [
      sharedProject,
      project({
        imports: [
          {
            packageName: "@goatcitadel/mission-control-shared",
            specifier: "@goatcitadel/mission-control-shared/api/session-control",
            filePath: "apps/gateway/src/session-control-cli.ts",
          },
          {
            packageName: "@goatcitadel/mission-control-shared",
            specifier: "@goatcitadel/mission-control-shared/api/http-internal",
            filePath: "apps/gateway/src/session-control-cli.ts",
          },
        ],
      }),
    ],
  });

  assert.deepEqual(
    findings.map((finding) => [finding.code, finding.filePath]),
    [["MISSING_PROJECT_REFERENCE", "apps/gateway/tsconfig.json"]],
  );
  assert.match(findings[0].message, /apps\/gateway\/src\/session-control-cli\.ts imports/);
  assert.match(findings[0].message, /and 1 other import,/);
  assert.match(findings[0].message, /"path": "\.\.\/\.\.\/packages\/mission-control-shared"/);
});

test("project references accept a project whose workspace imports are all declared", () => {
  const findings = collectProjectReferenceFindings({
    projects: [
      sharedProject,
      project({
        references: [
          { rawPath: "../../packages/mission-control-shared", resolvedDirectory: "packages/mission-control-shared" },
        ],
        imports: [
          {
            packageName: "@goatcitadel/mission-control-shared",
            specifier: "@goatcitadel/mission-control-shared/api/session-control",
            filePath: "apps/gateway/src/session-control-cli.ts",
          },
        ],
      }),
    ],
  });

  assert.deepEqual(findings, []);
});

test("project references ignore a package importing its own subpaths", () => {
  const findings = collectProjectReferenceFindings({
    projects: [
      project({
        packageName: "@goatcitadel/mission-control-shared",
        directory: "packages/mission-control-shared",
        tsconfigPath: "packages/mission-control-shared/tsconfig.json",
        imports: [
          {
            packageName: "@goatcitadel/mission-control-shared",
            specifier: "@goatcitadel/mission-control-shared/api/client",
            filePath: "packages/mission-control-shared/src/api/chat.ts",
          },
        ],
      }),
    ],
  });

  assert.deepEqual(findings, []);
});

test("project references flag an entry that resolves outside the workspace projects", () => {
  const findings = collectProjectReferenceFindings({
    projects: [
      project({
        references: [
          { rawPath: "../../packages/mission-control-shard", resolvedDirectory: "packages/mission-control-shard" },
        ],
      }),
    ],
  });

  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["UNRESOLVABLE_PROJECT_REFERENCE"],
  );
  assert.match(findings[0].message, /mission-control-shard/);
});

test("project references report an unreadable tsconfig instead of passing it", () => {
  const findings = collectProjectReferenceFindings({
    projects: [
      project({
        parseError: "Unexpected token } in JSON",
        imports: [
          {
            packageName: "@goatcitadel/mission-control-shared",
            specifier: "@goatcitadel/mission-control-shared/api/session-control",
            filePath: "apps/gateway/src/session-control-cli.ts",
          },
        ],
      }),
    ],
  });

  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["TSCONFIG_PARSE_FAILURE"],
  );
});

test("project references fail closed when workspace discovery finds nothing", () => {
  const findings = collectProjectReferenceFindings({ projects: [] });

  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["WORKSPACE_DISCOVERY_EMPTY"],
  );
});

test("workspace import extraction skips comments and string literals", () => {
  const source = [
    "/**",
    " * Mirrors `ChatStreamingPreview` from `@goatcitadel/contracts` (also",
    " * re-exported as a type from `@goatcitadel/threaded-surface-core`). Declared",
    " * independently here so this package never depends on threaded-surface-core.",
    " */",
    '// import { legacy } from "@goatcitadel/mesh-core";',
    'import type { ChatStreamingPreview } from "@goatcitadel/contracts";',
    'const label = "@goatcitadel/storage";',
    "export type { ChatStreamingPreview };",
    "export const streamingPreviewLabel = label;",
  ].join("\n");

  assert.deepEqual(collectWorkspaceImports(ts, source), [
    { packageName: "@goatcitadel/contracts", specifier: "@goatcitadel/contracts" },
  ]);
});

test("workspace import extraction covers every specifier form that needs a reference", () => {
  const source = [
    'import type { A } from "@goatcitadel/contracts";',
    'export * from "@goatcitadel/skills";',
    'export type { C } from "@goatcitadel/policy-engine";',
    'const dynamic = import("@goatcitadel/memory-core");',
    'import { b } from "@goatcitadel/storage/sub/path";',
    "export const used = [dynamic, b];",
  ].join("\n");

  assert.deepEqual(
    collectWorkspaceImports(ts, source)
      .map((workspaceImport) => workspaceImport.packageName)
      .sort(),
    [
      "@goatcitadel/contracts",
      "@goatcitadel/memory-core",
      "@goatcitadel/policy-engine",
      "@goatcitadel/skills",
      "@goatcitadel/storage",
    ],
  );
});

test("workspace package names come from the first specifier segment", () => {
  assert.equal(workspacePackageNameFromSpecifier("@goatcitadel/contracts"), "@goatcitadel/contracts");
  assert.equal(
    workspacePackageNameFromSpecifier("@goatcitadel/mission-control-shared/api/session-control"),
    "@goatcitadel/mission-control-shared",
  );
  assert.equal(workspacePackageNameFromSpecifier("node:path"), null);
  assert.equal(workspacePackageNameFromSpecifier("@goatcitadel/"), null);
});

test("workspace globs are read from the pnpm packages list and stop at the next key", () => {
  const globs = parseWorkspacePackageGlobs(
    ["packages:", '  - "apps/*"', "  # a comment", '  - "packages/*"', "allowBuilds:", "  esbuild: true"].join("\n"),
  );

  assert.deepEqual(globs, ["apps/*", "packages/*"]);
});

test("workspace glob parsing fails closed when the packages list is missing", () => {
  assert.throws(() => parseWorkspacePackageGlobs("allowBuilds:\n  esbuild: true\n"), /no 'packages:' list/);
});
