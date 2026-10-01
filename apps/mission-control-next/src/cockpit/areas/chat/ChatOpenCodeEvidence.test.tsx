import { renderToStaticMarkup } from "react-dom/server";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { ChatOpenCodeEvidence } from "./ChatOpenCodeEvidence";

function toolRun(externalAgent: unknown): ChatToolRunRecord {
  return {
    toolRunId: "tool-1", turnId: "turn-1", sessionId: "session-1", startedAt: "2026-09-28T00:00:00Z",
    toolName: "shell.exec", status: "executed", result: { externalAgent },
  };
}

describe("ChatOpenCodeEvidence", () => {
  it("shows bounded external agent evidence and preserves partial and failure truth", () => {
    const report = {
      engine: "opencode", version: 1, truncated: true, error: "Permission rejected",
      files: [{ path: "<script>unsafe</script>", additions: 2, patch: "-old\n+new", truncated: true }],
      steps: [{ id: "step-1", tool: "edit", title: "Edit file", status: "error", error: "Blocked" }],
    };
    const html = renderToStaticMarkup(<ChatOpenCodeEvidence toolRuns={[toolRun(report)]} onOpenRunDetails={() => undefined} />);
    expect(html).toContain("OpenCode report");
    expect(html).toContain("1 reported file · 1 step");
    expect(html).toContain("Permission rejected");
    expect(html).toContain("Diff preview is partial");
    expect(html).toContain("Some output was omitted");
    expect(html).toContain("Open run evidence");
    expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("does not turn malformed results into an agent report", () => {
    expect(renderToStaticMarkup(<ChatOpenCodeEvidence toolRuns={[toolRun({ engine: "opencode" })]} onOpenRunDetails={() => undefined} />)).toBe("");
  });
});
