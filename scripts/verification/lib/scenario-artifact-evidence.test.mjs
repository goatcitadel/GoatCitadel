import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertNamedScenarioProofs, validateRequiredScenarioArtifacts } from "./scenario-artifact-evidence.mjs";

test("required scenario evidence accepts unique run-relative regular files", async () => {
  await withArtifactRoot(async ({ artifactRoot }) => {
    await writeArtifact(artifactRoot, "diagnostics/proof.json");
    await writeArtifact(artifactRoot, "logs/proof.log");
    const scenario = {
      id: "proof.valid",
      status: "passed",
      artifacts: {
        diagnostics: ["diagnostics/proof.json"],
        logs: ["logs/proof.log"],
      },
    };

    assert.deepEqual(validateRequiredScenarioArtifacts(artifactRoot, [scenario]), {
      evidence: ["diagnostics/proof.json", "logs/proof.log"],
      issues: [],
    });
    assert.doesNotThrow(() =>
      assertNamedScenarioProofs(
        { artifactRoot, manifest: { scenarios: [scenario] } },
        [scenario.id],
        "named prerequisites",
      ),
    );
  });
});

test("required scenario evidence counts orthogonal media and Playwright aliases once per retained file", async () => {
  await withArtifactRoot(async ({ artifactRoot }) => {
    await writeArtifact(artifactRoot, "playwright/console.json");
    await writeArtifact(artifactRoot, "playwright/trace.zip");
    const scenario = {
      id: "proof.cross-category",
      status: "passed",
      artifacts: {
        logs: ["playwright/console.json"],
        traces: ["playwright/trace.zip"],
        playwright: ["playwright/console.json", "playwright/trace.zip"],
      },
    };

    assert.deepEqual(validateRequiredScenarioArtifacts(artifactRoot, [scenario]), {
      evidence: ["playwright/console.json", "playwright/trace.zip"],
      issues: [],
    });
  });
});

test("required scenario evidence rejects duplicate entries within one category", async () => {
  await withArtifactRoot(async ({ artifactRoot }) => {
    await writeArtifact(artifactRoot, "diagnostics/proof.json");

    const validation = validateRequiredScenarioArtifacts(artifactRoot, [
      {
        id: "proof.duplicate-category",
        artifacts: {
          diagnostics: ["diagnostics/proof.json", "diagnostics/proof.json"],
        },
      },
    ]);

    assert.deepEqual(validation.issues, [
      {
        scenarioId: "proof.duplicate-category",
        category: "diagnostics",
        index: 1,
        reference: "diagnostics/proof.json",
        reason: "duplicate-reference",
      },
    ]);
    assert.deepEqual(validation.evidence, ["diagnostics/proof.json"]);
  });
});

test("required scenario evidence rejects retained-file reuse across scenarios", async () => {
  await withArtifactRoot(async ({ artifactRoot }) => {
    await writeArtifact(artifactRoot, "playwright/shared-console.json");

    const validation = validateRequiredScenarioArtifacts(artifactRoot, [
      {
        id: "proof.owner",
        artifacts: { logs: ["playwright/shared-console.json"] },
      },
      {
        id: "proof.reuser",
        artifacts: { playwright: ["playwright/shared-console.json"] },
      },
    ]);

    assert.deepEqual(validation.issues, [
      {
        scenarioId: "proof.reuser",
        category: "playwright",
        index: 0,
        reference: "playwright/shared-console.json",
        reason: "duplicate-reference",
      },
    ]);
    assert.deepEqual(validation.evidence, ["playwright/shared-console.json"]);
  });
});

test("required scenario evidence rejects missing, non-file, absolute, out-of-root, traversal, duplicate, and invalid refs", async () => {
  await withArtifactRoot(async ({ artifactRoot, parentRoot }) => {
    await fs.mkdir(path.join(artifactRoot, "diagnostics", "directory"), { recursive: true });
    await writeArtifact(artifactRoot, "diagnostics/valid.json");
    const outsidePath = path.join(parentRoot, "outside.log");
    await fs.writeFile(outsidePath, "outside\n", "utf8");
    const outsideDirectory = path.join(parentRoot, "outside-directory");
    await fs.mkdir(outsideDirectory, { recursive: true });
    await fs.writeFile(path.join(outsideDirectory, "proof.log"), "outside through link\n", "utf8");
    await fs.symlink(
      outsideDirectory,
      path.join(artifactRoot, "linked-outside"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const cases = [
      {
        artifacts: { logs: ["logs/missing.log"] },
        reason: "missing-reference",
      },
      {
        artifacts: { diagnostics: ["diagnostics/directory"] },
        reason: "non-file-reference",
      },
      {
        artifacts: { logs: [path.join(artifactRoot, "diagnostics", "valid.json")] },
        reason: "absolute-reference",
      },
      {
        artifacts: { logs: ["../outside.log"] },
        reason: "traversal-reference",
      },
      {
        artifacts: { logs: ["linked-outside/proof.log"] },
        reason: "outside-artifact-root",
      },
      {
        artifacts: { diagnostics: [""] },
        reason: "invalid-reference",
      },
      {
        artifacts: { diagnostics: [42] },
        reason: "invalid-reference",
      },
      {
        artifacts: { diagnostics: "diagnostics/valid.json" },
        reason: "invalid-artifact-list",
      },
    ];

    for (const [index, entry] of cases.entries()) {
      const validation = validateRequiredScenarioArtifacts(artifactRoot, [
        {
          id: `proof.invalid-${index}`,
          status: "passed",
          artifacts: entry.artifacts,
        },
      ]);
      assert.ok(
        validation.issues.some((issue) => issue.reason === entry.reason),
        `expected ${entry.reason}: ${JSON.stringify(validation)}`,
      );
    }
  });
});

test("named prerequisite proof fails closed when a retained artifact is absent", async () => {
  await withArtifactRoot(async ({ artifactRoot }) => {
    const scenario = {
      id: "proof.missing",
      status: "passed",
      artifacts: { logs: ["logs/missing.log"] },
    };

    assert.throws(
      () =>
        assertNamedScenarioProofs(
          { artifactRoot, manifest: { scenarios: [scenario] } },
          [scenario.id],
          "named prerequisites",
        ),
      /proof\.missing:evidence-missing.*proof\.missing:evidence-missing-reference/u,
    );
  });
});

async function withArtifactRoot(callback) {
  const parentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-scenario-artifacts-"));
  const artifactRoot = path.join(parentRoot, "run");
  await fs.mkdir(artifactRoot, { recursive: true });
  try {
    await callback({ artifactRoot, parentRoot });
  } finally {
    await fs.rm(parentRoot, { recursive: true, force: true });
  }
}

async function writeArtifact(artifactRoot, reference) {
  const absolutePath = path.join(artifactRoot, ...reference.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${reference}\n`, "utf8");
}
