import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPnpmBootstrapArgs,
  normalizeBootstrapMode,
  readWorkspacePackageFreshness,
  resolveBootstrapPlan,
} from "./lib/dev-bootstrap.mjs";

test("createPnpmBootstrapArgs serializes forced re-emits for shared TypeScript project references", () => {
  assert.deepEqual(createPnpmBootstrapArgs(["@test/one", "@test/two"]), [
    "--workspace-concurrency=1",
    "--filter",
    "@test/one",
    "--filter",
    "@test/two",
    "build",
    "--force",
  ]);
});

test("normalizeBootstrapMode accepts documented aliases and warns for unknown values", () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);

  assert.equal(normalizeBootstrapMode("auto", warn), "auto");
  assert.equal(normalizeBootstrapMode("force", warn), "always");
  assert.equal(normalizeBootstrapMode("true", warn), "always");
  assert.equal(normalizeBootstrapMode("never", warn), "skip");
  assert.equal(normalizeBootstrapMode("0", warn), "skip");
  assert.equal(normalizeBootstrapMode("mystery", warn), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ignoring unknown bootstrap mode/);
});

test("resolveBootstrapPlan builds only stale runtime packages in auto mode", (t) => {
  const tmp = tempRepo(t);
  createWorkspacePackage(tmp.path, "fresh", "@test/fresh", {
    sourceMtimeMs: 1_000,
    outputMtimeMs: 2_000,
  });
  createWorkspacePackage(tmp.path, "stale", "@test/stale", {
    sourceMtimeMs: 3_000,
    outputMtimeMs: 2_000,
  });
  createWorkspacePackage(tmp.path, "missing-dist", "@test/missing-dist", {
    sourceMtimeMs: 1_000,
  });

  const plan = resolveBootstrapPlan(
    tmp.path,
    ["@test/fresh", "@test/stale", "@test/missing-dist", "@test/missing-package"],
    "auto",
  );

  assert.equal(plan.shouldBuild, true);
  assert.deepEqual(plan.packages, ["@test/stale", "@test/missing-dist", "@test/missing-package"]);
  assert.match(plan.reason, /@test\/stale \(inputs newer than dist\)/);
  assert.match(plan.reason, /@test\/missing-dist \(missing dist\)/);
  assert.match(plan.reason, /@test\/missing-package \(package not found\)/);
});

test("resolveBootstrapPlan keeps forced bootstrap modes explicit", (t) => {
  const tmp = tempRepo(t);
  createWorkspacePackage(tmp.path, "fresh", "@test/fresh", {
    sourceMtimeMs: 1_000,
    outputMtimeMs: 2_000,
  });

  assert.deepEqual(resolveBootstrapPlan(tmp.path, ["@test/fresh"], "always"), {
    shouldBuild: true,
    packages: ["@test/fresh"],
    reason: "forced by bootstrap mode",
  });
  assert.deepEqual(resolveBootstrapPlan(tmp.path, ["@test/fresh"], "skip"), {
    shouldBuild: false,
    packages: [],
    reason: "forced by bootstrap mode",
  });
});

test("readWorkspacePackageFreshness treats missing compiled outputs as stale", (t) => {
  const tmp = tempRepo(t);
  createWorkspacePackage(tmp.path, "empty-dist", "@test/empty-dist", {
    sourceMtimeMs: 1_000,
    outputMtimeMs: undefined,
    createDist: true,
  });

  assert.deepEqual(readWorkspacePackageFreshness(tmp.path, "@test/empty-dist"), {
    fresh: false,
    reason: "missing dist outputs",
  });
});

function tempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-dev-bootstrap-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    path: dir,
  };
}

function createWorkspacePackage(
  rootDir,
  dirName,
  packageName,
  { sourceMtimeMs, outputMtimeMs, createDist = outputMtimeMs !== undefined },
) {
  const packageDir = path.join(rootDir, "packages", dirName);
  const srcDir = path.join(packageDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: packageName }), "utf8");
  fs.writeFileSync(path.join(packageDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }), "utf8");
  const sourcePath = path.join(srcDir, "index.ts");
  fs.writeFileSync(sourcePath, "export const value = 1;\n", "utf8");
  setMtime(sourcePath, sourceMtimeMs);
  setMtime(path.join(packageDir, "package.json"), sourceMtimeMs);
  setMtime(path.join(packageDir, "tsconfig.json"), sourceMtimeMs);

  if (createDist) {
    const distDir = path.join(packageDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    if (outputMtimeMs !== undefined) {
      const outputPath = path.join(distDir, "index.js");
      fs.writeFileSync(outputPath, "export const value = 1;\n", "utf8");
      setMtime(outputPath, outputMtimeMs);
    }
  }
}

function setMtime(filePath, mtimeMs) {
  const date = new Date(mtimeMs);
  fs.utimesSync(filePath, date, date);
}
