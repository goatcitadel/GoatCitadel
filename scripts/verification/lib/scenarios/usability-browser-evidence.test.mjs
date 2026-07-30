import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureBrowserActionCheckpoint,
  discardBrowserVideo,
  emptyBrowserEvidenceArtifacts,
  mergeBrowserEvidenceArtifacts,
  retainFailedBrowserVideo,
} from "./usability-browser-evidence.mjs";

test("browser evidence artifact sets preserve every verification artifact class", () => {
  assert.deepEqual(emptyBrowserEvidenceArtifacts({ screenshots: ["a.png", "a.png"] }), {
    diagnostics: [],
    screenshots: ["a.png"],
    traces: [],
    logs: [],
    perf: [],
    playwright: [],
  });
  assert.deepEqual(
    mergeBrowserEvidenceArtifacts(
      { screenshots: ["a.png"], perf: ["perf.json"], playwright: ["console.json"] },
      { screenshots: ["a.png", "b.png"], traces: ["trace.zip"], playwright: ["trace.zip"] },
    ),
    {
      diagnostics: [],
      screenshots: ["a.png", "b.png"],
      traces: ["trace.zip"],
      logs: [],
      perf: ["perf.json"],
      playwright: ["console.json", "trace.zip"],
    },
  );
});

test("action checkpoints use stable safe names and return run-relative evidence", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-usability-checkpoint-"));
  let capturedPath;
  try {
    const evidence = await captureBrowserActionCheckpoint(
      { artifactRoot },
      {
        bundleId: "Chat lifecycle",
        stepId: "route.chat/send + stream",
        page: {
          async screenshot(input) {
            capturedPath = input.path;
            await fs.writeFile(input.path, "fixture", "utf8");
          },
        },
      },
    );
    assert.equal(evidence, "screenshots/Chat-lifecycle--route.chat-send-stream.png");
    assert.equal(capturedPath, path.join(artifactRoot, evidence.replaceAll("/", path.sep)));
    assert.equal(await fs.readFile(capturedPath, "utf8"), "fixture");
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("failed videos are retained under a deterministic Playwright path and the transient recording is deleted", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-usability-video-"));
  let savedPath;
  let deleteCount = 0;
  const video = {
    async saveAs(filePath) {
      savedPath = filePath;
      await fs.writeFile(filePath, "video", "utf8");
    },
    async delete() {
      deleteCount += 1;
    },
  };
  try {
    const evidence = await retainFailedBrowserVideo({ artifactRoot }, { slug: "settings/core", video });
    assert.equal(evidence, "playwright/settings-core-failure.webm");
    assert.equal(savedPath, path.join(artifactRoot, "playwright", "settings-core-failure.webm"));
    assert.equal(deleteCount, 1);
    await discardBrowserVideo(video);
    assert.equal(deleteCount, 2);
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});
