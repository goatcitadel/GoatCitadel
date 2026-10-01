import { useMemo } from "react";
import type { CodePanelType } from "./code-workbench-model";
import type { useCodeRunLedger } from "./useCodeRunLedger";
import { codeModeArtifactReviewRows, summarizeValidationForReview } from "./code-workbench-evidence";
import { shortId } from "./format";

export function useCodeWorkbenchReviewPacket(
  props: CodePanelType["props"],
  ledger: ReturnType<typeof useCodeRunLedger>,
  changedFiles: string[],
  readyForRepoOps: boolean,
) {
  const { workbenchState, selectedTurn, output, diff, hasDirtyDraft } = props;
  const { selectedRunDetail, selectedRunSummary, selectedRunApprovalId, visibleRunItems } = ledger;
  const reviewPacket = useMemo(() => {
    const validation = summarizeValidationForReview(workbenchState?.validationStatus, output, visibleRunItems.length);
    const intent =
      typeof selectedTurn?.userMessage?.content === "string" && selectedTurn.userMessage.content.trim()
        ? selectedTurn.userMessage.content.trim()
        : "No user intent captured for the selected turn.";
    const changedSummary = diff?.summary
      ? `${diff.summary.changedFiles} file${diff.summary.changedFiles === 1 ? "" : "s"} · +${
          diff.summary.additions
        } / -${diff.summary.deletions}`
      : `${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}`;
    const latestRun = selectedRunDetail ?? selectedRunSummary;
    const artifactRows = codeModeArtifactReviewRows(selectedRunDetail);
    const artifactReady = artifactRows.some((row) => row.value !== "not recorded");
    const publishCandidate = validation.status === "passed" && changedFiles.length > 0 && !hasDirtyDraft;

    return {
      intent,
      metrics: [
        {
          label: "Patch intent",
          value: selectedTurn?.turnId ? shortId(selectedTurn.turnId) : "no turn",
          detail: intent,
          tone: intent.startsWith("No user intent") ? "warning" : "good",
        },
        {
          label: "Changed files",
          value: changedSummary,
          detail: changedFiles.length ? changedFiles.slice(0, 5).join(", ") : "No worktree changes recorded.",
          tone: changedFiles.length ? "warning" : "muted",
        },
        {
          label: "Validation",
          value: validation.status,
          detail: `${validation.command} · ${validation.detail}`,
          tone: validation.tone,
        },
        {
          label: "Ledger run",
          value: latestRun?.runId ? shortId(latestRun.runId) : "none selected",
          detail: latestRun?.status ?? "No Code Mode ledger run selected.",
          tone: latestRun?.status === "completed" || latestRun?.status === "passed" ? "good" : "muted",
        },
      ],
      validation,
      artifactRows,
      checklist: [
        {
          label: "Diff review",
          status: changedFiles.length ? "Ready for review" : "No patch captured",
          detail: changedFiles.length
            ? "Inspect selected-file and repo diff before handoff."
            : "Create or refresh a worktree diff before packaging.",
          tone: changedFiles.length ? "good" : "warning",
        },
        {
          label: "Validation proof",
          status: validation.status,
          detail: validation.skipped,
          tone: validation.tone,
        },
        {
          label: "Approval linkage",
          status: selectedRunApprovalId ? `Linked ${shortId(selectedRunApprovalId)}` : "No approval linked",
          detail: selectedRunApprovalId
            ? "Approval evidence is visible from the Code Mode run."
            : "No approval was recorded for the selected run.",
          tone: selectedRunApprovalId ? "good" : "muted",
        },
        {
          label: "Artifact hashes",
          status: artifactReady ? "Recorded" : "Missing",
          detail: artifactReady
            ? "Source, wrapper, policy, stdout, or stderr artifact references are available below."
            : "Load a Code Mode run detail to inspect immutable artifacts.",
          tone: artifactReady ? "good" : "warning",
        },
        {
          label: "Ready to publish",
          status: publishCandidate ? "Candidate" : "Hold",
          detail: publishCandidate
            ? "Still verify branch state, untracked files, screenshots, and remote SHA before publishing."
            : "Needs passed validation, changed-file review, and no unsaved editor draft.",
          tone: publishCandidate ? "good" : "warning",
        },
      ],
      risk: hasDirtyDraft
        ? "Unsaved editor draft is still present."
        : readyForRepoOps
          ? "Remote branch parity, screenshots, and untracked artifacts are not recorded in this panel."
          : "Create a ready worktree before treating this as publish evidence.",
    };
  }, [
    changedFiles,
    diff?.summary,
    hasDirtyDraft,
    output,
    readyForRepoOps,
    selectedRunApprovalId,
    selectedRunDetail,
    selectedRunSummary,
    selectedTurn?.turnId,
    selectedTurn?.userMessage?.content,
    visibleRunItems.length,
    workbenchState?.validationStatus,
  ]);
  return reviewPacket;
}
