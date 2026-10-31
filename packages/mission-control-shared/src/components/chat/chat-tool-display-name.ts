import { readOpenCodeRunSummary, type ChatToolRunRecord } from "@goatcitadel/contracts";
import { humanizeToken } from "../../content/status-vocabulary.js";

/** A tool call's operator-facing name. Tools without one of their own read as words ("Code search files"), never as a raw registry id. */
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
    "fs.stat": "Check file",
    "fs.copy": "Copy file",
    "fs.move": "Move file",
    "fs.delete": "Delete file",
    "file.find": "Find files",
    "file.read_range": "Read file lines",
    "code.search": "Search code",
    "code.search_files": "Search code files",
    "http.get": "Fetch page",
    "browser.extract": "Read page",
    "git.diff": "Review changes",
    "git.status": "Check working tree",
    "tests.run": "Run tests",
    "lint.run": "Check code",
    "build.run": "Build project",
    "browser.search": "Search the web",
    "browser.navigate": "Open page",
    "memory.search": "Search memory",
    "memory.read": "Read memory",
    "documents.create": "Create document",
    "presentations.create": "Create presentation",
    "artifacts.create": "Create artifact",
    "docs.read_bytes": "Read file bytes",
    "docs.extract_text": "Extract document text",
    "docs.decompress": "Decompress data",
    "code_mode.request": "Run code",
  };
  const name = typeof run.toolName === "string" ? run.toolName : "";
  return names[name] ?? (humanizeToken(name) || "Tool");
}
