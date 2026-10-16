import { useQuery } from "@tanstack/react-query";
import type { DocumentPatchProposalRecord } from "@goatcitadel/contracts";
import { listNotes } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { fetchChatGeneratedArtifact } from "@goatcitadel/mission-control-shared/api/chat";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useWorkspaceNameLookup } from "../../data/use-workspace-name";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

/** The Library page that holds a proposal's target document. */
export function documentLibraryLabel(targetKind: DocumentPatchProposalRecord["targetKind"]): string {
  return targetKind === "personal_note" ? "Open notes" : "Open artifacts";
}

export function DocumentLibraryLink({ proposal }: { proposal: DocumentPatchProposalRecord }) {
  return (
    <NativeOwnerLink
      href={proposal.targetKind === "personal_note" ? "/library/notes" : "/library/artifacts"}
      scope={[proposal.workspaceId, proposal.proposalId]}
      className="w-fit text-sm font-medium text-accent hover:underline"
    >
      {documentLibraryLabel(proposal.targetKind)}
    </NativeOwnerLink>
  );
}

export function DocumentProposalTarget({ proposal }: { proposal: DocumentPatchProposalRecord }) {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const workspaceName =
    useWorkspaceNameLookup(activeCitadelId)(proposal.workspaceId) ??
    (proposal.workspaceId === (activeWorkspaceId ?? "default") ? "This workspace" : "Another workspace");
  const title = useQuery({
    queryKey: ["document-proposal-target", proposal.workspaceId, proposal.targetKind, proposal.targetId],
    retry: false,
    queryFn: async () =>
      proposal.targetKind === "personal_note"
        ? ((await listNotes(proposal.workspaceId)).items.find(
            (note) => note.noteId === proposal.targetId && note.workspaceId === proposal.workspaceId,
          )?.title ?? null)
        : (await fetchChatGeneratedArtifact(proposal.targetId, proposal.workspaceId)).item.title,
  });
  return (
    <div className="space-y-1">
      <p className="break-words">
        Target: {title.data || (title.isPending ? "Reading document title…" : "Document title unavailable")} ·{" "}
        {proposal.targetKind === "personal_note" ? "Note" : "Artifact"} · {workspaceName}
        {proposal.sessionId ? " · From a conversation" : ""}
      </p>
      <TechnicalDetails label="Target identifiers">
        <p className="break-all font-mono text-xs">
          {proposal.targetKind === "personal_note" ? "Note" : "Artifact"} {proposal.targetId} · Workspace{" "}
          {proposal.workspaceId}
          {proposal.sessionId ? ` · Conversation ${proposal.sessionId}` : ""}
        </p>
      </TechnicalDetails>
    </div>
  );
}

export function DocumentProposalDiff({ diff }: { diff: string }) {
  return (
    <pre
      aria-label="Replacement diff"
      className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs"
    >
      {diff.split("\n").map((line, index) => (
        <span
          key={index}
          className={`block ${line.startsWith("+") ? "text-status-done" : line.startsWith("-") ? "text-status-failed" : "text-fg-secondary"}`}
        >
          {line || " "}
        </span>
      ))}
    </pre>
  );
}
