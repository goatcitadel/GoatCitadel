import { describe, expect, it } from "vitest";
import {
  AgenticScriptedRunnerMemoryStore,
  buildAgenticScriptedRunnerRecord,
  recordAgenticScriptedRunnerResult,
} from "./agentic-scripted-runner.js";

describe("buildAgenticScriptedRunnerRecord", () => {
  it("exposes only policy-approved tool names and keeps final output bounded", () => {
    const record = buildAgenticScriptedRunnerRecord({
      scriptRunId: "script-run-1",
      runId: "run-1",
      sessionId: "session-1",
      policySnapshotHash: "policy-hash",
      requestedToolNames: ["memory.read", "shell.exec", "artifact.write", "memory.read", " "],
      policyApprovedToolNames: ["memory.read", "artifact.write"],
      finalOutput: "abcdef",
      maxOutputChars: 4,
      artifactRefs: ["artifact:1", "artifact:1", " "],
      eventRefs: ["event:1", "event:2", "event:1"],
      startedAt: "2026-05-05T00:00:00.000Z",
      completedAt: "2026-05-05T00:00:01.000Z",
    });

    expect(record).toMatchObject({
      scriptRunId: "script-run-1",
      runId: "run-1",
      sessionId: "session-1",
      status: "passed",
      policySnapshotHash: "policy-hash",
      exposedTools: ["memory.read", "artifact.write"],
      blockedTools: ["shell.exec"],
      outputPreview: "abcd",
      outputTruncated: true,
      artifactRefs: ["artifact:1"],
      eventRefs: ["event:1", "event:2"],
      externalExecution: "not_implemented",
    });
  });

  it("records queued scaffolds without pretending execution ran", () => {
    const record = buildAgenticScriptedRunnerRecord({
      scriptRunId: "script-run-2",
      policyApprovedToolNames: ["memory.read"],
      now: () => "2026-05-05T00:00:00.000Z",
    });

    expect(record).toMatchObject({
      status: "queued",
      exposedTools: ["memory.read"],
      outputPreview: undefined,
      completedAt: undefined,
      externalExecution: "not_implemented",
    });
  });

  it("persists memory-level records by script run id", () => {
    const store = new AgenticScriptedRunnerMemoryStore();

    recordAgenticScriptedRunnerResult(store, {
      scriptRunId: "script-run-3",
      requestedToolNames: ["memory.read", "network.fetch"],
      policyApprovedToolNames: ["memory.read"],
      finalOutput: "Done",
      artifactRefs: ["artifact:summary"],
      eventRefs: ["event:scripted-runner.completed"],
      now: () => "2026-05-05T00:00:00.000Z",
    });

    expect(store.list()).toHaveLength(1);
    expect(store.get("script-run-3")).toMatchObject({
      exposedTools: ["memory.read"],
      blockedTools: ["network.fetch"],
      artifactRefs: ["artifact:summary"],
      eventRefs: ["event:scripted-runner.completed"],
    });
  });
});
