import { describe, expect, it } from "vitest";

import {
  buildPatchLifecycleRecords,
  deriveChangedFileEvidence,
  derivePatchArtifactRecord,
  verifyPatchClaims,
} from "./agentic-patch-review-service.js";

describe("agentic patch review service", () => {
  it("derives changed-file evidence from a unified workbench diff", () => {
    const changedFiles = deriveChangedFileEvidence(`diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/old.ts b/src/new.ts
similarity index 98%
rename from src/old.ts
rename to src/new.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/added.ts b/src/added.ts
new file mode 100644
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1 @@
+added
`);

    expect(changedFiles).toEqual([
      {
        path: "src/a.ts",
        kind: "modified",
        source: "workbench_diff",
        hunks: 1,
      },
      {
        path: "src/added.ts",
        kind: "added",
        source: "workbench_diff",
        hunks: 1,
      },
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        kind: "renamed",
        source: "workbench_diff",
        hunks: 1,
      },
    ]);
  });

  it("records apply, export, and revert lifecycle state", () => {
    expect(
      buildPatchLifecycleRecords({
        apply: {
          status: "succeeded",
          at: "2026-05-05T01:02:03.000Z",
          evidence: "applied patch artifact patch-1",
        },
        export: "failed",
      }),
    ).toEqual([
      {
        state: "apply",
        status: "succeeded",
        at: "2026-05-05T01:02:03.000Z",
        evidence: "applied patch artifact patch-1",
      },
      { state: "export", status: "failed" },
      { state: "revert", status: "unknown" },
    ]);
  });

  it("verifies claimed files, tests, and artifacts against supplied evidence", () => {
    const verification = verifyPatchClaims(
      {
        files: ["src/present.ts", "src/missing.ts"],
        tests: [{ command: "pnpm test present" }, { command: "pnpm test missing" }],
        artifacts: [{ path: "reports/present.json" }, { id: "missing-artifact" }],
      },
      {
        files: ["src/present.ts"],
        tests: [{ command: "pnpm test present", status: "passed" }],
        artifacts: [{ path: "reports/present.json", kind: "json" }],
      },
    );

    expect(verification.files.present).toEqual(["src/present.ts"]);
    expect(verification.files.missing).toEqual(["src/missing.ts"]);
    expect(verification.tests.present).toEqual([{ command: "pnpm test present" }]);
    expect(verification.tests.missing).toEqual([{ command: "pnpm test missing" }]);
    expect(verification.artifacts.present).toEqual([{ path: "reports/present.json" }]);
    expect(verification.artifacts.missing).toEqual([{ id: "missing-artifact" }]);
  });

  it("emits diagnostics for dirty worktrees without artifacts and missing claims", () => {
    const record = derivePatchArtifactRecord({
      id: "patch-1",
      createdAt: "2026-05-05T01:02:03.000Z",
      workbenchDiff: `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`,
      claims: {
        files: ["src/a.ts", "src/missing.ts"],
        tests: [{ command: "pnpm test missing" }],
        artifacts: [{ path: "reports/missing.json" }],
      },
      evidence: {
        dirty: true,
        files: ["src/a.ts"],
        tests: [],
        artifacts: [],
      },
      lifecycle: {
        apply: "succeeded",
        export: "pending",
        revert: "not_requested",
      },
    });

    expect(record.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "dirty_worktree_without_artifact",
      "missing_claimed_file",
      "missing_claimed_test",
      "missing_claimed_artifact",
    ]);
    expect(record.changedFiles).toEqual([
      {
        path: "src/a.ts",
        kind: "modified",
        source: "workbench_diff",
        hunks: 1,
      },
    ]);
    expect(record.lifecycle).toEqual([
      { state: "apply", status: "succeeded" },
      { state: "export", status: "pending" },
      { state: "revert", status: "not_requested" },
    ]);
  });
});
