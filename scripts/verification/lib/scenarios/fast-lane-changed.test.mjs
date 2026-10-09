import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectChangedPaths,
  describeChangedFastLanePlan,
  expandToDependents,
  planChangedFastLane,
  readWorkspacePackages,
} from "./fast-lane-changed.mjs";
import { FAST_LANE_COMMANDS, FAST_LANE_LIBRARY_TEST_FILTERS, resolveChangedFastLaneRun } from "./fast-lane.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const commandIds = FAST_LANE_COMMANDS.map((command) => command.id);

const PACKAGES = [
  { name: "@goatcitadel/contracts", dir: "packages/contracts", dependencies: [] },
  { name: "@goatcitadel/storage", dir: "packages/storage", dependencies: ["@goatcitadel/contracts"] },
  { name: "@goatcitadel/policy-engine", dir: "packages/policy-engine", dependencies: ["@goatcitadel/contracts"] },
  {
    name: "@goatcitadel/gateway",
    dir: "apps/gateway",
    dependencies: ["@goatcitadel/storage", "@goatcitadel/policy-engine"],
  },
  { name: "@goatcitadel/mission-control-next", dir: "apps/mission-control-next", dependencies: [] },
];

function plan(changedPaths) {
  return planChangedFastLane({ changedPaths, packages: PACKAGES, commandIds, libraryPackages: FAST_LANE_LIBRARY_TEST_FILTERS });
}

describe("verify:fast --changed planning", () => {
  it("a UI-only change skips gateway, storage, policy and library suites but keeps prerequisites", () => {
    const result = plan(["apps/mission-control-next/src/App.tsx"]);
    assert.equal(result.fullLane, false);
    assert.deepEqual(result.affectedPackages, ["@goatcitadel/mission-control-next"]);
    assert.ok(result.selection.has("fast.test.mission-control-next"));
    for (const id of ["fast.repo-hygiene", "fast.typecheck", "fast.build", "fast.docs", "fast.gateway-async-boundary"]) {
      assert.ok(result.selection.has(id), `${id} always runs`);
    }
    for (const id of ["fast.test.gateway.shard1", "fast.test.storage.shard1", "fast.test.policy-engine", "fast.test.libraries", "fast.smoke"]) {
      assert.ok(result.skipped.includes(id), `${id} is unaffected`);
    }
  });

  it("a storage change also selects every dependent package's suites", () => {
    const result = plan(["packages/storage/src/repo.ts"]);
    assert.deepEqual(result.affectedPackages, ["@goatcitadel/gateway", "@goatcitadel/storage"]);
    assert.ok(result.selection.has("fast.test.storage.shard4"));
    assert.ok(result.selection.has("fast.test.gateway.shard2"));
    assert.ok(result.selection.has("fast.coverage.gateway.smoke"));
    assert.ok(result.skipped.includes("fast.test.policy-engine"));
  });

  it("a contracts change selects the library group and everything that depends on contracts", () => {
    const result = plan(["packages/contracts/src/index.ts"]);
    assert.ok(result.selection.has("fast.test.libraries"));
    assert.ok(result.selection.has("fast.test.policy-engine"));
    assert.ok(result.selection.has("fast.test.gateway.node"));
    assert.ok(result.skipped.includes("fast.test.mission-control-next"));
  });

  it("root configuration, lockfile and script changes run the whole lane", () => {
    for (const file of ["pnpm-lock.yaml", "vitest.shared.ts", "package.json", "scripts/storage-coverage.mjs"]) {
      const result = plan([file]);
      assert.equal(result.fullLane, true, `${file} must select the whole lane`);
      assert.deepEqual(result.fullLaneTriggers, [file]);
    }
  });

  it("docs and native-only paths run only the always-on checks and flag the native suite", () => {
    const result = plan(["docs/x.md", "README.md", "scripts/packaging/remote-worker-windows-cell.test.mjs"]);
    assert.equal(result.fullLane, false);
    assert.deepEqual(result.affectedPackages, []);
    assert.equal(result.nativeWindowsChanged, true);
    assert.ok(result.selection.has("fast.repo-hygiene"));
    assert.equal(result.selection.has("fast.test.gateway.shard1"), false);
    assert.match(describeChangedFastLanePlan(result, "origin/main"), /verify:remote-worker:windows/);
  });

  it("normalizes Windows separators and duplicate paths", () => {
    const result = plan(["apps\\mission-control-next\\src\\a.ts", "apps/mission-control-next/src/a.ts"]);
    assert.deepEqual(result.changedPaths, ["apps/mission-control-next/src/a.ts"]);
  });

  it("dependent expansion is transitive", () => {
    assert.deepEqual(
      [...expandToDependents(PACKAGES, ["@goatcitadel/contracts"])].sort(),
      ["@goatcitadel/contracts", "@goatcitadel/gateway", "@goatcitadel/policy-engine", "@goatcitadel/storage"],
    );
  });
});

describe("verify:fast --changed inputs", () => {
  it("reads every real workspace package with its workspace dependencies", () => {
    const packages = readWorkspacePackages(repoRoot);
    const gateway = packages.find((pkg) => pkg.name === "@goatcitadel/gateway");
    assert.equal(gateway?.dir, "apps/gateway");
    assert.ok(gateway.dependencies.includes("@goatcitadel/storage"));
    for (const library of FAST_LANE_LIBRARY_TEST_FILTERS) {
      assert.ok(packages.some((pkg) => pkg.name === library), `${library} must be a workspace package`);
    }
  });

  it("combines branch, uncommitted and untracked paths since the merge base", () => {
    const calls = [];
    const outputs = new Map([
      ["merge-base origin/main HEAD", "abc123\n"],
      ["diff --name-only abc123 HEAD", "apps/gateway/a.ts\n"],
      ["diff --name-only HEAD", "packages/storage/b.ts\r\n"],
      ["ls-files --others --exclude-standard", "docs/new.md\n"],
    ]);
    const paths = collectChangedPaths("root", "origin/main", (_cwd, args) => {
      calls.push(args.join(" "));
      return outputs.get(args.join(" ")) ?? "";
    });
    assert.deepEqual(paths, ["apps/gateway/a.ts", "packages/storage/b.ts", "docs/new.md"]);
    assert.equal(calls.length, 4);
  });

  it("fails with a clear message when the base ref has no merge base", () => {
    assert.throws(
      () => collectChangedPaths("root", "origin/nope", () => { throw new Error("bad ref"); }),
      /could not find a merge base with "origin\/nope"/,
    );
  });

  it("records a partial selection for package-scoped runs and none for whole-lane runs", () => {
    const scoped = resolveChangedFastLaneRun("origin/main", {
      collectChangedPaths: () => ["apps/mission-control-next/src/App.tsx"],
      readWorkspacePackages: () => PACKAGES,
    });
    assert.match(scoped.commandSelection, /^changed:origin\/main:/);
    assert.ok(scoped.selection.has("fast.test.mission-control-next"));

    const whole = resolveChangedFastLaneRun(undefined, {
      collectChangedPaths: () => ["pnpm-lock.yaml"],
      readWorkspacePackages: () => PACKAGES,
    });
    assert.equal(whole.baseRef, "origin/main");
    assert.equal(whole.selection, undefined);
    assert.equal(whole.commandSelection, undefined);
  });
});
