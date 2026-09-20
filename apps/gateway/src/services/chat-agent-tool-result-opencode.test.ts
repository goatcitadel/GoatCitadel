import { describe, expect, it } from "vitest";
import {
  buildCompactToolResultMetadata,
  extractPersistableToolArtifactContent,
} from "./chat-agent-tool-result-compaction.js";

describe("OpenCode artifact projection", () => {
  it("retains bounded agent evidence and process exit truth when JSONL is virtualized", () => {
    const result = {
      exitCode: -1,
      stdout: "x".repeat(20000),
      externalAgent: {
        engine: "opencode",
        version: 1,
        sessionId: "ses_test",
        error: "Permission rejected",
        truncated: false,
        steps: [{ id: "call_1", tool: "edit", title: "src/example.ts", status: "error" }],
        files: [],
      },
    };
    expect(extractPersistableToolArtifactContent("shell.exec", result)?.compactMode).toBe("structured");
    const compact = buildCompactToolResultMetadata(result);
    expect(compact.exitCode).toBe(-1);
    expect(compact.externalAgent).toMatchObject({
      sessionId: "ses_test",
      error: "Permission rejected",
      steps: [{ status: "error" }],
    });
    expect(compact).not.toHaveProperty("stdout");
  });
});
