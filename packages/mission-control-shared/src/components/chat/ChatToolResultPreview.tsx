import { Code2, FileCode2, Terminal } from "lucide-react";
import { readOpenCodeRunSummary, type ChatToolRunRecord } from "@goatcitadel/contracts";
import { AssistantMessageRenderer } from "./AssistantMessageRenderer";
import { ChatToolDiffBlock } from "./ChatToolDiffBlock";
import { extractUnifiedDiffFromToolRun } from "./chat-tool-diff";

/** Expandable evidence stays in the conversation; authority stays with the Gateway. */
export function ChatToolResultPreview({ run }: { run: ChatToolRunRecord }) {
  const agent = readOpenCodeRunSummary(run.result?.externalAgent);
  const diff = extractUnifiedDiffFromToolRun(run);
  if (!agent && !diff) return null;

  if (!agent) {
    return (
      <details className="mc-tool-result-preview">
        <summary>
          <FileCode2 size={14} aria-hidden="true" />
          <span>Review diff</span>
        </summary>
        <ChatToolDiffBlock diff={diff!} maxLines={100} />
      </details>
    );
  }

  return (
    <details className="mc-tool-result-preview mc-opencode-result">
      <summary>
        <Code2 size={16} aria-hidden="true" />
        <strong>OpenCode</strong>
        <span>
          {agent.steps.length} {agent.steps.length === 1 ? "step" : "steps"} · {agent.files.length} reported{" "}
          {agent.files.length === 1 ? "file" : "files"}
        </span>
        {agent.error ? <span className="mc-tool-result-error-label">Needs attention</span> : null}
      </summary>
      <div className="mc-tool-result-body">
        {agent.error ? <p className="mc-tool-result-error">{agent.error}</p> : null}
        {agent.text ? <AssistantMessageRenderer role="assistant" content={agent.text} /> : null}
        {agent.files.length > 0 ? (
          <div className="mc-tool-result-files" aria-label="Files reported changed by OpenCode">
            {agent.files.map((file) => (
              <details key={file.path} className="mc-tool-result-file">
                <summary>
                  <FileCode2 size={14} aria-hidden="true" />
                  <span className="mc-tool-result-path" title={file.path}>
                    {file.path}
                  </span>
                  {file.additions !== undefined ? (
                    <span className="mc-tool-result-added" aria-label={`${file.additions} added lines`}>
                      +{file.additions}
                    </span>
                  ) : null}
                  {file.deletions !== undefined ? (
                    <span className="mc-tool-result-removed" aria-label={`${file.deletions} removed lines`}>
                      −{file.deletions}
                    </span>
                  ) : null}
                </summary>
                {file.patch ? (
                  <ChatToolDiffBlock diff={file.patch} maxLines={80} />
                ) : (
                  <p>No diff was returned for this file.</p>
                )}
                {file.truncated ? (
                  <p className="mc-tool-result-note">
                    Diff preview is partial. Inspect the captured output for more detail.
                  </p>
                ) : null}
              </details>
            ))}
          </div>
        ) : null}
        {agent.steps.length > 0 ? (
          <details className="mc-tool-result-steps">
            <summary>
              <Terminal size={14} aria-hidden="true" />
              <span>Agent steps</span>
            </summary>
            <ol>
              {agent.steps.map((step) => (
                <li key={step.id}>
                  <span
                    className={step.status === "error" ? "mc-tool-result-error-label" : "mc-tool-result-step-status"}
                  >
                    {step.status === "error" ? "Failed" : "Reported done"}
                  </span>
                  <span title={step.tool}>{step.title}</span>
                  {step.error ? <span className="mc-tool-result-error">{step.error}</span> : null}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
        {agent.truncated ? (
          <p className="mc-tool-result-note">
            Some output is omitted or incomplete. Open execution details for the captured evidence.
          </p>
        ) : null}
        {agent.sessionId ? (
          <p className="mc-tool-result-note">
            OpenCode session <code>{agent.sessionId}</code>
          </p>
        ) : null}
      </div>
    </details>
  );
}

export function chatToolDisplayName(run: ChatToolRunRecord): string {
  if (readOpenCodeRunSummary(run.result?.externalAgent)) return "OpenCode";
  const names: Record<string, string> = {
    "shell.exec": "Run command",
    "shell.exec_background": "Background command",
    "fs.read": "Read file",
    "fs.write": "Write file",
    "fs.patch": "Edit file",
    "fs.list": "Browse files",
    "fs.search": "Search files",
    "git.diff": "Review changes",
    "git.status": "Check working tree",
    "tests.run": "Run tests",
    "lint.run": "Check code",
    "build.run": "Build project",
    "browser.search": "Search the web",
    "browser.navigate": "Open page",
    "memory.search": "Search memory",
    "memory.read": "Read memory",
  };
  return names[run.toolName] ?? run.toolName;
}
