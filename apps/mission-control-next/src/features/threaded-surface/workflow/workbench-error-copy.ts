import { describeApiErrorText } from "@goatcitadel/mission-control-shared/api/describe-api-error";

export interface WorkbenchErrorDescription {
  summary: string;
  technical?: string;
}

export interface WorkbenchErrorContext {
  /** True only while the failure can belong to creating the worktree (no ready worktree yet). */
  worktreeCreation?: boolean;
}

const GENERIC_SUMMARY = "The gateway couldn't complete that request.";
const LOOKS_LIKE_COMMAND_OR_PATH = /Command failed|\b[A-Za-z]:[\\/]|\/(?:Users|home|var|etc|tmp)\//;
const GIT_MISSING = /spawn git(?:\.exe)? ENOENT|'?git(?:\.exe)?'? is not recognized|git(?:\.exe)?: command not found/i;

/** Turns the build editor's recorded error text into one plain sentence, keeping the original for details. */
export function describeWorkbenchError(error: string, context: WorkbenchErrorContext = {}): WorkbenchErrorDescription {
  const summary = summarize(error, context);
  return summary === error ? { summary } : { summary, technical: error };
}

function summarize(error: string, context: WorkbenchErrorContext): string {
  if (context.worktreeCreation) {
    if (/not a git repository/i.test(error)) {
      return "This project's folder isn't a git repository, so the build editor can't make a worktree for it. Make the folder a git repository, then press Create worktree again.";
    }
    if (GIT_MISSING.test(error)) {
      return "Git isn't installed on the computer running GoatCitadel, so the build editor can't make a worktree. Install git, then press Create worktree again.";
    }
  }
  const summary = describeApiErrorText(error).summary;
  return summary === error.trim() && LOOKS_LIKE_COMMAND_OR_PATH.test(error) ? GENERIC_SUMMARY : summary;
}
