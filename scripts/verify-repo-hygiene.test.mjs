import assert from "node:assert/strict";
import test from "node:test";
import { collectRepoHygieneFindings } from "./verify-repo-hygiene.mjs";

test("repo hygiene flags tracked ignored local settings and generated installer binaries", () => {
  const findings = collectRepoHygieneFindings({
    trackedFiles: [
      ".claude/settings.local.json",
      "artifacts/installers/windows-native/GoatCitadel-Setup-windows-x64.exe",
    ],
    ignoredTrackedFiles: [".claude/settings.local.json", "artifacts/installers/windows-native/GoatCitadel-Setup-windows-x64.exe"],
    fileInfoByPath: new Map([
      [".claude/settings.local.json", { size: 128 }],
      ["artifacts/installers/windows-native/GoatCitadel-Setup-windows-x64.exe", { size: 1_000_000 }],
    ]),
    readTextFile: (filePath) =>
      filePath === ".claude/settings.local.json" ? '{"path":"F:/code/personal-ai"}' : "",
  });

  assert.deepEqual(
    findings.map((finding) => finding.code).sort(),
    [
      "TRACKED_BINARY_ARTIFACT",
      "TRACKED_GENERATED_ARTIFACT",
      "TRACKED_IGNORED_FILE",
      "TRACKED_IGNORED_FILE",
      "TRACKED_LOCAL_SETTINGS",
      "TRACKED_PERSONAL_PATH",
    ].sort(),
  );
});

test("repo hygiene ignores deliberate fixture paths in tests", () => {
  const findings = collectRepoHygieneFindings({
    trackedFiles: ["apps/gateway/src/example.test.ts"],
    ignoredTrackedFiles: [],
    fileInfoByPath: new Map([["apps/gateway/src/example.test.ts", { size: 128 }]]),
    readTextFile: () => 'const root = "F:/code/personal-ai";',
  });

  assert.equal(findings.length, 0);
});

test("repo hygiene flags large tracked archives", () => {
  const findings = collectRepoHygieneFindings({
    trackedFiles: ["release/installer.zip"],
    ignoredTrackedFiles: [],
    fileInfoByPath: new Map([["release/installer.zip", { size: 26 * 1024 * 1024 }]]),
    readTextFile: () => "",
  });

  assert.deepEqual(
    findings.map((finding) => finding.code).sort(),
    ["TRACKED_BINARY_ARTIFACT", "TRACKED_LARGE_FILE"].sort(),
  );
});
