import { readOpenCodeRunSummary, type ChatToolRunRecord } from "@goatcitadel/contracts";

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
