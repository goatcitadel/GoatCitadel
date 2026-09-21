import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { ChatToolResultPreview } from "./ChatToolResultPreview";
import { ChatTurnActivityRows } from "./ChatToolActivity";
import { getChatToolRunDiagnostics } from "./chat-tool-diagnostics";

const run = (result: Record<string, unknown>) =>
  ({ toolName: "shell.exec", status: "executed", result }) as ChatToolRunRecord;
const externalAgent = {
  engine: "opencode",
  version: 1,
  sessionId: "ses_demo",
  truncated: false,
  steps: [{ id: "step1", tool: "edit", title: "retry.ts", status: "completed" }],
  files: [
    {
      path: "src/retry.ts",
      additions: 1,
      deletions: 1,
      patch: "--- a/retry.ts\n+++ b/retry.ts\n@@ -1 +1 @@\n-old\n+new",
      truncated: true,
    },
  ],
};

describe("inline agent evidence", () => {
  it("keeps the agent result in the actual timeline after prerequisite calls, while preserving blockers", () => {
    const toolRuns = Array.from({ length: 4 }, (_, i) => ({ ...run({ exitCode: 0 }), toolRunId: `setup-${i}` }));
    toolRuns.push({ ...run({ externalAgent }), toolRunId: "opencode" });
    toolRuns.push({ ...run({}), toolRunId: "approval", toolName: "fs.write", status: "approval_required" });
    toolRuns.push({ ...run({ exitCode: 1 }), toolRunId: "failure", toolName: "tests.run" });
    const html = renderToStaticMarkup(
      <ChatTurnActivityRows mode="chat" toolRuns={toolRuns} onOpenRunDetails={() => undefined} />,
    );
    expect(html).toContain("OpenCode");
    expect(html).toContain("approval");
    expect(html).toContain("needs review");
    expect(html).toContain("+4 more");
  });
  it("renders expandable file reports, accessible line counts, and partial-diff truth", () => {
    const html = renderToStaticMarkup(<ChatToolResultPreview run={run({ externalAgent })} />);
    expect(html).toContain("OpenCode");
    expect(html).toContain("1 step · 1 reported file");
    expect(html).toContain("src/retry.ts");
    expect(html).toContain("1 added lines");
    expect(html).toContain("Diff preview is partial");
    expect(html).toContain("Reported done");
  });
  it("keeps external errors and process failure visible even with an executed tool record", () => {
    const failed = run({ exitCode: -1, externalAgent: { ...externalAgent, error: "Permission rejected" } });
    expect(getChatToolRunDiagnostics(failed).hasFailureSignal).toBe(true);
    expect(getChatToolRunDiagnostics(failed).summary).toContain("exited with code -1");
    expect(renderToStaticMarkup(<ChatToolResultPreview run={failed} />)).toContain("Permission rejected");
    expect(
      getChatToolRunDiagnostics(run({ exitCode: 0, externalAgent: { ...externalAgent, error: "API failed" } }))
        .hasFailureSignal,
    ).toBe(true);
  });
  it("ignores malformed projections and escapes external file titles", () => {
    expect(renderToStaticMarkup(<ChatToolResultPreview run={run({ externalAgent: {} })} />)).toBe("");
    const html = renderToStaticMarkup(
      <ChatToolResultPreview
        run={run({ externalAgent: { ...externalAgent, files: [{ path: "<script>alert(1)</script>" }] } })}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("brings ordinary tool diffs into the conversation too", () => {
    const html = renderToStaticMarkup(<ChatToolResultPreview run={run({ diff: externalAgent.files[0]!.patch })} />);
    expect(html).toContain("Review diff");
    expect(html).toContain("line add");
  });
});
