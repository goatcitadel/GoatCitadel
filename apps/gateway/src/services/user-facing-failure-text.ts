/**
 * Plain-language wording for failures an operator reads in Chat and the Inbox.
 * The raw error stays in the durable/technical fields; only presentation text
 * goes through here.
 */

const WINDOWS_HOME_PATTERN = /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"`<>|]+/giu;
const POSIX_HOME_PATTERN = /(?<![\w.])\/(?:home|Users)\/[^/\s'"`<>|]+/gu;

/** Replaces home-directory prefixes (which carry the OS username) with `~`. */
export function redactLocalHomePaths(text: string): string {
  return text.replace(WINDOWS_HOME_PATTERN, "~").replace(POSIX_HOME_PATTERN, "~");
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
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
  "documents.create": "Create document",
  "presentations.create": "Create presentation",
  "artifacts.create": "Create artifact",
};

export function describeToolForOperator(toolName: string): string {
  return TOOL_DISPLAY_NAMES[toolName] ?? "The approved action";
}

/** A short cause an operator can act on, without paths or error codes. */
export function describeFailureCause(message: string): string | undefined {
  if (/\bENOENT\b|no such file or directory/iu.test(message)) return "the file or folder doesn't exist";
  if (/\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/iu.test(message)) {
    return "permission was denied";
  }
  if (/\bETIMEDOUT\b|timed out|timeout/iu.test(message)) return "it timed out";
  if (/\bENOSPC\b|no space left/iu.test(message)) return "the disk is full";
  if (/\bEBUSY\b|resource busy|\bEEXIST\b/iu.test(message)) return "the file or folder is in use or already exists";
  return undefined;
}

export function buildPlainApprovedToolFailureText(
  toolName: string,
  failure: { message: string; kind: string },
): string {
  const label = describeToolForOperator(toolName);
  const subject = label === "The approved action" ? label : `The approved action (${label})`;
  if (failure.kind === "manual_reconciliation") {
    return `${subject} may have partly run and needs manual reconciliation. Check the target system before trying again.`;
  }
  const cause = describeFailureCause(failure.message);
  return cause
    ? `${subject} didn't work because ${cause}. Open Activity for technical details.`
    : `${subject} didn't work. Open Activity for technical details.`;
}
