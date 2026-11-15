import { describeApiErrorText } from "@goatcitadel/mission-control-shared/api/describe-api-error";

export interface WorkbenchErrorDescription {
  summary: string;
  technical?: string;
}

/** Turns the build editor's recorded error text into one plain sentence, keeping the original for details. */
export function describeWorkbenchError(error: string): WorkbenchErrorDescription {
  const summary = summarize(error);
  return summary === error ? { summary } : { summary, technical: error };
}

function summarize(error: string): string {
  if (/not a git repository/i.test(error)) {
    return "This project's folder isn't a git repository, so the build editor can't make a worktree for it. Make the folder a git repository, then press Create worktree again.";
  }
  if (/\bgit\b.*(?:not found|ENOENT|is not recognized)/i.test(error)) {
    return "Git isn't installed on the computer running GoatCitadel, so the build editor can't make a worktree. Install git, then press Create worktree again.";
  }
  if (/^\s*API error/.test(error)) {
    return describeApiErrorText(error).summary;
  }
  return error;
}
