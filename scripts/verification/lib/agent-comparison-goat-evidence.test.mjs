import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { COMPARISON_TASKS, sha256 } from "./agent-comparison.mjs";
import { readNativeGoatWorkflowEvidence } from "./agent-comparison-goat-evidence.mjs";
import { PERMISSION_REVIEW_FILE, PERMISSION_REVIEW_VERSION } from "./agent-comparison-permissions.mjs";
import { verifyComparisonEvidence } from "./agent-comparison-verifiers.mjs";

async function fixture(t, count = 205) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, "goat-workflow-evidence-"));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.equal(await realpath(root), root);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true });
  });
  const evidenceDirectory = path.join(root, "evidence");
  const rawDirectory = path.join(evidenceDirectory, "goatcitadel");
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(rawDirectory, { recursive: true });
  await mkdir(path.join(workspaceRoot, "input"), { recursive: true });
  const task = COMPARISON_TASKS.find((item) => item.id === "workflow_capture_reuse");
  const source = "controlled_fixture";
  const binding = {
    executionId: "native-workflow-execution",
    manifestSha256: sha256("controlled manifest"),
    cellId: "goatcitadel:workflow_capture_reuse:1",
    revision: "a".repeat(40),
    effectiveConfigSha256: sha256("controlled config"),
    fixtureSha256: sha256(task),
  };
  const write = async (name, value) => {
    const bytes = JSON.stringify(value, null, 2) + "\n";
    await writeFile(path.join(evidenceDirectory, name), bytes);
    return { path: name, sha256: sha256(bytes) };
  };
  const nativeReceipts = [];
  const rawReceipts = [];
  let sequence = 0;
  for (const [index, phase] of ["source", "review", "reuse"].entries()) {
    const records = [];
    const phaseCount = Math.floor(count / 3) + (index < count % 3 ? 1 : 0);
    for (let position = 0; position < phaseCount; position++) {
      const name = "thread-poll";
      const value = { body: { state: position % 3 } };
      rawReceipts.push(await write(`goatcitadel/workflow-${String(++sequence).padStart(4, "0")}-${name}.json`, value));
      records.push({ phase, name, ...value });
    }
    // Real concurrent status reads can finish in a different order from their
    // assigned filenames, and unchanged polling responses can repeat.
    nativeReceipts.push(
      await write(`native-goat-workflow-${phase}.json`, { ...binding, source, records: records.reverse() }),
    );
  }
  const launchReceipt = await write("native-launch.json", { ...binding, source });
  nativeReceipts.push(
    await write(PERMISSION_REVIEW_FILE, {
      schemaVersion: PERMISSION_REVIEW_VERSION,
      ...binding,
      policy: {
        files: "workspace_only",
        terminal: "disabled",
        skills: "review_before_activation",
        schedule: "disabled",
      },
      reviewedBy: "controlled local fixture",
      reviewedAt: "2026-09-12T00:00:00.000Z",
      sourceReceipts: [launchReceipt],
    }),
  );
  const sourceText =
    "# What changed\nMissing attachment name\n# Evidence\nattachment-name regression test passed\n# Unverified\nevery attachment format works\n";
  const instructions =
    "# Inputs\nChange list.\n# Instructions\nWrite release sections.\n# Failure handling\nStop on missing input.\n# Verification\nCheck every claim.\n";
  for (const [name, content] of Object.entries({
    ...task.files,
    ...task.phases[2].files,
    "source-release.md": sourceText,
    "release.md":
      "# What changed\nDuplicate reminder after reconnect\n# Evidence\nreconnect regression test passed\n# Unverified\nall providers are faster\n",
  }))
    await writeFile(path.join(workspaceRoot, name), content);
  await writeFile(path.join(evidenceDirectory, "reviewed-skill.md"), instructions);
  const summary = {
    schemaVersion: "goatcitadel.agent-comparison.execution.v1",
    ...binding,
    product: "goatcitadel",
    taskId: task.id,
    source,
    nativeReceipts,
    workflow: {
      phases: [
        {
          id: "source_workflow",
          status: "completed",
          sessionId: "source-session",
          turnId: "source-turn",
          sourceArtifactSha256: sha256(sourceText),
        },
        {
          id: "capture_review",
          sessionId: "source-session",
          turnId: "capture-turn",
          sourceSessionId: "source-session",
          sourceTurnId: "source-turn",
          sourceArtifactSha256: sha256(sourceText),
          instructionsSha256: sha256(instructions),
          reviewedInstructionsSha256: sha256(instructions),
          reviewDecision: "approved",
          skillVersionId: "reviewed-version",
        },
        {
          id: "reuse",
          sessionId: "new-session",
          turnId: "reuse-turn",
          skillVersionId: "reviewed-version",
          loadedInstructionsSha256: sha256(instructions),
        },
      ],
      activationEvents: [{ skillVersionId: "reviewed-version", instructionsSha256: sha256(instructions) }],
    },
  };
  await write("workflow-execution.json", summary);
  return {
    root,
    evidenceDirectory,
    rawDirectory,
    workspaceRoot,
    binding,
    source,
    summary,
    write,
    rawReceipts,
    launchReceipt,
    read: (extra = {}) => readNativeGoatWorkflowEvidence({ evidenceDirectory, binding, source, ...extra }),
    verify: () => verifyComparisonEvidence({ taskId: task.id, workspaceRoot, evidenceRoot: evidenceDirectory }),
    rewritePhase: async (phase, change) => {
      const name = `native-goat-workflow-${phase}.json`;
      const value = JSON.parse(await readFile(path.join(evidenceDirectory, name), "utf8"));
      change(value);
      const ref = await write(name, value);
      summary.nativeReceipts = summary.nativeReceipts.map((item) => (item.path === name ? ref : item));
      await write("workflow-execution.json", summary);
    },
  };
}

it("verifies a complete native workflow with more than 100 raw snapshots through lossless phase bundles", async (t) => {
  const f = await fixture(t);
  await f.write("execution.json", {
    ...f.summary,
    nativeReceipts: [...f.rawReceipts, ...f.summary.nativeReceipts, f.launchReceipt],
  });
  await assert.rejects(f.verify(), /At least one retained native receipt/);
  const execution = await f.read();
  assert.equal(execution.nativeSnapshotCount, 205);
  assert.equal(execution.nativeReceipts.length, 5);
  await f.write("execution.json", { ...execution, nativeReceipts: [...execution.nativeReceipts, f.launchReceipt] });
  const verified = await f.verify();
  assert.equal(verified.outcome, "passed");
  assert.equal(verified.evidenceKind, "controlled");
  assert.equal(
    Object.values(verified.checks).every((check) => check.passed),
    true,
  );
  assert.equal(Object.keys(verified.checks).length, 6);
});

it("rejects changed, missing and additional raw native snapshots", async (t) => {
  const f = await fixture(t, 6);
  const first = f.rawReceipts[0].path;
  const bytes = await readFile(path.join(f.evidenceDirectory, first));
  await f.write(first, { changed: true });
  await assert.rejects(f.read(), /missing from its phase bundle/);
  await writeFile(path.join(f.evidenceDirectory, first), bytes);
  await rm(path.join(f.evidenceDirectory, first));
  await assert.rejects(f.read(), /do not cover the raw inventory/);
  await writeFile(path.join(f.evidenceDirectory, first), bytes);
  await f.write("goatcitadel/workflow-0007-thread-poll.json", { body: {} });
  await assert.rejects(f.read(), /do not cover the raw inventory/);
});

it("rejects phase payload substitution even when its summary hash is updated", async (t) => {
  const f = await fixture(t, 9);
  await f.rewritePhase("source", (value) => {
    value.records[0].body.state = "invented";
  });
  await assert.rejects(f.read(), /missing from its phase bundle/);
});

it("rejects changed execution identity, mixed sources, and wrong phase attribution", async (t) => {
  const f = await fixture(t, 6);
  await assert.rejects(f.read({ binding: { ...f.binding, executionId: "other" } }), /execution binding/);
  await assert.rejects(f.read({ source: "native_receipts" }), /execution binding/);
  await f.rewritePhase("review", (value) => {
    value.records[0].phase = "source";
  });
  await assert.rejects(f.read(), /changed phase/);
});

it("requires distinct complete phase references and unchanged phase bytes", async (t) => {
  const f = await fixture(t, 6);
  await f.write("workflow-execution.json", {
    ...f.summary,
    nativeReceipts: [f.summary.nativeReceipts[0], f.summary.nativeReceipts[0], ...f.summary.nativeReceipts.slice(2)],
  });
  await assert.rejects(f.read(), /phase inventory/);
  await f.write("workflow-execution.json", f.summary);
  await f.write("native-goat-workflow-source.json", { changed: true });
  await assert.rejects(f.read(), /workflow evidence changed/);
});

it("rejects oversized and multiply-linked files before accepting evidence", async (t) => {
  const f = await fixture(t, 6);
  const first = path.join(f.evidenceDirectory, f.rawReceipts[0].path);
  const bytes = await readFile(first);
  await writeFile(first, Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(f.read(), /byte bound/);
  await writeFile(first, bytes);
  await link(first, path.join(f.root, "linked-snapshot.json"));
  await assert.rejects(f.read(), /ordinary-file/);
});

it("honors cancellation before reading native workflow evidence", async (t) => {
  const f = await fixture(t, 6);
  await assert.rejects(f.read({ signal: AbortSignal.abort() }), { name: "AbortError" });
});

it("bounds total bytes even when every native snapshot fits the individual file limit", async (t) => {
  const f = await fixture(t, 9);
  for (const receipt of f.rawReceipts) {
    const filename = path.join(f.evidenceDirectory, receipt.path);
    const bytes = await readFile(filename);
    const padded = Buffer.alloc(4 * 1024 * 1024, " ");
    bytes.copy(padded);
    await writeFile(filename, padded);
  }
  await assert.rejects(f.read(), /byte bound/);
});

it("rejects a snapshot inventory beyond the native workflow's own retained-record limit", async (t) => {
  const f = await fixture(t, 501);
  await assert.rejects(f.read(), /inventory bound/);
});
