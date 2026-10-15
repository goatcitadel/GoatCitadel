import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "release-installers.yml");
const packagePath = path.join(repositoryRoot, "package.json");
const lockfilePath = path.join(repositoryRoot, "pnpm-lock.yaml");
const sbomValidatorPath = path.join(repositoryRoot, "scripts", "release", "validate-pnpm-sbom.mjs");

const signedReleaseCondition =
  "if: ${{ github.event_name == 'push' && github.repository == 'goatcitadel/GoatCitadel' && startsWith(github.ref, 'refs/tags/v') }}";
const unsignedSmokeCondition =
  "github.event_name == 'workflow_dispatch' && github.event.inputs.allow_unsigned == 'true'";

describe("release-installers workflow trust boundary", () => {
  const workflow = readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n");

  it("makes manual dispatch unsigned-smoke-only and safe by default", () => {
    const dispatchBlock = workflow.slice(
      workflow.indexOf("  workflow_dispatch:\n"),
      workflow.indexOf("\nconcurrency:\n"),
    );
    expect(dispatchBlock).not.toContain("release_tag:");
    expect(dispatchBlock).toContain('default: "true"');

    const manualJobNames = extractJobNames(workflow).filter((jobName) =>
      extractJobMetadata(workflow, jobName).includes("workflow_dispatch"),
    );
    expect(manualJobNames).toEqual(["windows-build-inputs", "linux", "macos-build-inputs"]);
    for (const jobName of manualJobNames) {
      const metadata = extractJobMetadata(workflow, jobName);
      expect(metadata).toContain(unsignedSmokeCondition);
      expect(metadata).toContain("github.event_name == 'push'");
      expect(metadata).toContain("github.repository == 'goatcitadel/GoatCitadel'");
    }
  });

  it("requires exact tag-push repository identity on every signed-release job", () => {
    const signedJobs = [
      "windows-component-sign",
      "windows-assemble",
      "windows-installer-sign",
      "windows",
      "macos-sign-notarize",
      "macos",
      "release-inputs",
      "release-artifact-sign",
      "release-assemble",
      "release-certificate-sign",
      "release-finalize",
      "publish-release",
    ];
    for (const jobName of signedJobs) {
      const metadata = extractJobMetadata(workflow, jobName);
      expect(metadata, jobName).toContain(signedReleaseCondition);
      expect(metadata, jobName).not.toContain("workflow_dispatch");
    }
  });

  it("keeps manual runs out of reusable-secret, OIDC, and publish jobs", () => {
    for (const jobName of extractJobNames(workflow)) {
      const block = extractJobBlock(workflow, jobName);
      const hasPrivilegedTrust =
        /secrets\.(?:WINDOWS_SIGN_CERT|MACOS_DEVELOPER_ID|APPLE_)|id-token: write|contents: write|softprops\/action-gh-release@/u.test(
          block,
        );
      if (!hasPrivilegedTrust) continue;

      const metadata = extractJobMetadata(workflow, jobName);
      expect(metadata, jobName).toContain(signedReleaseCondition);
      expect(metadata, jobName).not.toContain("workflow_dispatch");
    }
  });

  it("hooks every credential, OIDC, and publish job to the protected release environment", () => {
    const protectedJobs = new Map([
      ["windows-component-sign", "secrets.WINDOWS_SIGN_CERT_BASE64"],
      ["windows-installer-sign", "secrets.WINDOWS_SIGN_CERT_BASE64"],
      ["macos-sign-notarize", "secrets.MACOS_DEVELOPER_ID_CERT_BASE64"],
      ["release-artifact-sign", "cosign sign-blob"],
      ["release-certificate-sign", "cosign sign-blob"],
      ["publish-release", "softprops/action-gh-release@"],
    ]);
    for (const [jobName, privilegedMarker] of protectedJobs) {
      const block = extractJobBlock(workflow, jobName);
      expect(extractJobMetadata(workflow, jobName), jobName).toContain("environment: release");
      expect(block, jobName).toContain("Require externally protected release environment");
      expect(block, jobName).toContain("vars.GOATCITADEL_RELEASE_TRUST_READY");
      expect(block, jobName).toContain('run: test "$RELEASE_TRUST_READY" = "true"');
      expect(block.indexOf(privilegedMarker), jobName).toBeGreaterThan(
        block.indexOf("Require externally protected release environment"),
      );
    }
  });

  it("rechecks the live peeled tag immediately before each privileged boundary", () => {
    const privilegedMarkers = new Map([
      ["windows-component-sign", "secrets.WINDOWS_SIGN_CERT_BASE64"],
      ["windows-installer-sign", "secrets.WINDOWS_SIGN_CERT_BASE64"],
      ["macos-sign-notarize", "secrets.MACOS_DEVELOPER_ID_CERT_BASE64"],
      ["release-artifact-sign", "cosign sign-blob"],
      ["release-certificate-sign", "cosign sign-blob"],
      ["publish-release", "softprops/action-gh-release@"],
    ]);
    for (const [jobName, privilegedMarker] of privilegedMarkers) {
      const block = extractJobBlock(workflow, jobName);
      const liveCheckIndex = block.indexOf("Verify live release tag still resolves to this commit");
      expect(liveCheckIndex, jobName).toBeGreaterThan(0);
      expect(block.indexOf(privilegedMarker), jobName).toBeGreaterThan(liveCheckIndex);
      expect(block, jobName).toContain("git ls-remote --exit-code");
      expect(block, jobName).toContain("PEELED_SHA=");
      expect(block, jobName).toContain('"$LIVE_SHA" == "$GITHUB_SHA"');
    }
    expect(workflow.match(/- name: Verify live release tag still resolves to this commit/g) ?? []).toHaveLength(6);
  });

  it("serializes each ref and never overwrites existing release assets", () => {
    expect(workflow).toContain("group: release-installers-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(extractJobBlock(workflow, "publish-release")).toContain("overwrite_files: false");
  });

  it("pins release toolchains and verifies the immutable Inno Setup asset", () => {
    expect(workflow).toContain("NODE_VERSION: 22.23.1");
    expect(workflow).toContain("DOTNET_VERSION: 10.0.300");
    expect(workflow).toContain("RUST_TOOLCHAIN: 1.94.0");
    expect(workflow).toContain("INNO_SETUP_VERSION: 6.7.3");
    expect(workflow).toContain(
      "INNO_SETUP_URL: https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe",
    );
    expect(workflow).toContain("INNO_SETUP_SHA256: 9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732");
    expect(workflow.match(/Invoke-WebRequest -Uri \$env:INNO_SETUP_URL/g) ?? []).toHaveLength(2);
    expect(workflow.match(/Get-FileHash -LiteralPath \$installer -Algorithm SHA256/g) ?? []).toHaveLength(2);
    expect(workflow).not.toMatch(/choco install innosetup|rustup default stable|dotnet-version: 10\.0\.x/u);
  });

  it("uses the exact locked pnpm-aware CycloneDX CLI and validates complete lock identities", () => {
    const rootPackage = JSON.parse(readFileSync(packagePath, "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const lockfile = readFileSync(lockfilePath, "utf8");
    const validator = readFileSync(sbomValidatorPath, "utf8");
    const sbomStep = workflow.slice(
      workflow.indexOf("      - name: Generate CycloneDX SBOM\n"),
      workflow.indexOf("\n      - name: Wait for 1.0 release proof\n"),
    );
    expect(rootPackage.devDependencies?.["@cyclonedx/cdxgen"]).toBe("12.7.1");
    expect(readRootCycloneDxPin(lockfile)).toEqual({ specifier: "12.7.1", version: "12.7.1" });
    expect(sbomStep).toContain("timeout-minutes: 5");
    expect(sbomStep).toContain("env -u NODE_PATH node node_modules/@cyclonedx/cdxgen/bin/cdxgen.js .");
    expect(sbomStep).toContain("--spec-version 1.6");
    expect(sbomStep).toContain("--no-install-deps");
    expect(sbomStep).toContain("--fail-on-error");
    expect(sbomStep).toContain("--no-babel");
    expect(sbomStep).toContain("--no-recurse");
    expect(sbomStep).toContain("--validate");
    expect(sbomStep).toContain("env -u NODE_PATH node scripts/release/validate-pnpm-sbom.mjs");
    expect(sbomStep).toContain('CDXGEN_FETCH_PKG_METADATA: "false"');
    expect(sbomStep).toContain('FETCH_LICENSE: "false"');
    expect(sbomStep).not.toMatch(/pnpm (?:dlx|exec)|\bnpx\b|cyclonedx-npm/u);
    expect(validator).toContain('const EXPECTED_CDXGEN_VERSION = "12.7.1"');
    expect(validator).toContain('assertExactSet("canonical pnpm package identities"');
    expect(validator).toContain('assertExactSet("workspace importer identities"');
    expect(validator).toContain('assertExactSet("SBOM dependency refs"');
    expect(validator).toContain('assertExactSet("required pnpm dependency edges"');
    expect(validator).toContain("omittedImporterAliasEdges");
    expect(validator).toContain("omittedOptionalEdges");
  });
});

describe("root CycloneDX lockfile pin matching", () => {
  it.each(["'", '"'])("accepts equivalent matching %s key quotes", (quote) => {
    expect(readRootCycloneDxPin(cycloneDxLockFixture(quote))).toEqual({
      specifier: "12.7.1",
      version: "12.7.1",
    });
  });

  it.each([
    ["12.7.0", "12.7.1"],
    ["^12.7.1", "12.7.1"],
    ["12.7.1", "12.7.0"],
    ["12.7.1", "12.7.1-other"],
  ])("rejects changed specifier %s or resolved version %s", (specifier, version) => {
    expect(readRootCycloneDxPin(cycloneDxLockFixture('"', specifier, version))).not.toEqual({
      specifier: "12.7.1",
      version: "12.7.1",
    });
  });

  it("rejects mismatched dependency key quotes", () => {
    const fixture = cycloneDxLockFixture('"').replace('"@cyclonedx/cdxgen":', "\"@cyclonedx/cdxgen':");
    expect(() => readRootCycloneDxPin(fixture)).toThrow("Missing or duplicate root CycloneDX dependency");
  });

  it("rejects a different dependency key", () => {
    const fixture = cycloneDxLockFixture('"').replace("@cyclonedx/cdxgen", "@cyclonedx/cdxgen-other");
    expect(() => readRootCycloneDxPin(fixture)).toThrow("Missing or duplicate root CycloneDX dependency");
  });

  it("rejects a pin present only in another importer", () => {
    const fixture = cycloneDxLockFixture('"').replace("  .:", "  apps/other:");
    expect(() => readRootCycloneDxPin(fixture)).toThrow("Missing or duplicate lockfile mapping");
  });

  it("rejects an ambiguous duplicate root dependency", () => {
    const fixture =
      cycloneDxLockFixture('"') + '      "@cyclonedx/cdxgen":\n        specifier: 12.7.1\n        version: 12.7.1\n';
    expect(() => readRootCycloneDxPin(fixture)).toThrow("Missing or duplicate root CycloneDX dependency");
  });
});

function cycloneDxLockFixture(quote: string, specifier = "12.7.1", version = "12.7.1"): string {
  return [
    "importers:",
    "  .:",
    "    devDependencies:",
    "      " + quote + "@cyclonedx/cdxgen" + quote + ":",
    "        specifier: " + specifier,
    "        version: " + version,
    "",
  ].join("\n");
}

function readRootCycloneDxPin(source: string): { specifier: string; version: string } {
  const importers = extractLockfileMapping(source, "importers:", 0);
  const rootImporter = extractLockfileMapping(importers, "  .:", 2);
  const devDependencies = extractLockfileMapping(rootImporter, "    devDependencies:", 4);
  const matches = [...devDependencies.matchAll(/^ {6}(["'])@cyclonedx\/cdxgen\1:$/gmu)];
  if (matches.length !== 1) throw new Error("Missing or duplicate root CycloneDX dependency");
  const entry = extractLockfileMapping(devDependencies, matches[0]![0], 6);
  const specifiers = [...entry.matchAll(/^ {8}specifier: ([^\n]+)$/gmu)];
  const versions = [...entry.matchAll(/^ {8}version: ([^\n]+)$/gmu)];
  if (specifiers.length !== 1 || versions.length !== 1)
    throw new Error("Missing or duplicate root CycloneDX pin fields");
  return { specifier: specifiers[0]![1]!, version: versions[0]![1]! };
}

function extractLockfileMapping(source: string, header: string, indentation: number): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const matches = lines.map((line, index) => ({ line, index })).filter(({ line }) => line === header);
  if (matches.length !== 1) throw new Error("Missing or duplicate lockfile mapping: " + header.trim());
  const start = matches[0]!.index + 1;
  let end = start;
  while (end < lines.length && (!lines[end]!.trim() || lines[end]!.startsWith(" ".repeat(indentation + 1)))) end += 1;
  return lines.slice(start, end).join("\n");
}

function extractJobNames(source: string): string[] {
  const jobsIndex = source.indexOf("\njobs:\n");
  if (jobsIndex < 0) throw new Error("Missing jobs block in release workflow");
  return [...source.slice(jobsIndex).matchAll(/^ {2}([a-z0-9][a-z0-9-]*):\n/gmu)].map((match) => match[1] ?? "");
}

function extractJobMetadata(source: string, jobName: string): string {
  const block = extractJobBlock(source, jobName);
  const stepsIndex = block.indexOf("\n    steps:\n");
  if (stepsIndex < 0) throw new Error(`Missing steps for release workflow job: ${jobName}`);
  return block.slice(0, stepsIndex);
}

function extractJobBlock(source: string, jobName: string): string {
  const header = `  ${jobName}:\n`;
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`Missing release workflow job: ${jobName}`);
  const remainder = source.slice(start + header.length);
  const nextJob = remainder.search(/\n {2}[a-z0-9][a-z0-9-]*:\n/u);
  return source.slice(start, nextJob < 0 ? source.length : start + header.length + nextJob);
}
