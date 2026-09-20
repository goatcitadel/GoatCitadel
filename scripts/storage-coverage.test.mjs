import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { STORAGE_COVERAGE_SHARD_COUNT } from "./coverage-shard-contract.mjs";
import { storageCoverageOptions } from "./storage-coverage.mjs";

test("storage coverage rejects invalid or partial shard selections before running", () => {
  assert.deepEqual(storageCoverageOptions([]), { reportDirectory: "coverage", nodeArgs: [] });
  for (const argv of [["--shard=0/4"], ["--shard=5/4"], ["--shard=1/3"], ["--shard=1/4", "extra"], ["--shard=1/4/../tmp"]]) {
    assert.throws(() => storageCoverageOptions(argv), /Expected no arguments or --shard/);
  }
});

test("Node storage shards execute every test file exactly once with separate report directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goat-storage-shards-"));
  try {
    const files = Array.from({ length: 11 }, (_value, index) => `fixture-${index}.test.mjs`);
    for (const file of files) {
      fs.writeFileSync(path.join(root, file), `import { test } from 'node:test'; test(${JSON.stringify(file)}, () => {});`);
    }
    const seen = new Set();
    const reports = new Set();
    for (let shard = 1; shard <= STORAGE_COVERAGE_SHARD_COUNT; shard++) {
      const options = storageCoverageOptions([`--shard=${shard}/${STORAGE_COVERAGE_SHARD_COUNT}`]);
      reports.add(options.reportDirectory);
      const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...options.nodeArgs, ...files], {
        cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      });
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      const executed = [...result.stdout.matchAll(/^ok \d+ - (fixture-\d+\.test\.mjs)\r?$/gm)].map((match) => match[1]);
      assert.ok(executed.length > 0, `shard ${shard} must execute tests: ${result.stdout}`);
      for (const file of executed) {
        assert.equal(seen.has(file), false, `${file} must not run twice`);
        seen.add(file);
      }
    }
    assert.equal(reports.size, STORAGE_COVERAGE_SHARD_COUNT);
    assert.deepEqual([...seen].sort(), files.sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
