import { useQuery } from "@tanstack/react-query";
import type { DocumentPatchProposalRecord } from "@goatcitadel/contracts";
import { listNotes } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { fetchChatGeneratedArtifact } from "@goatcitadel/mission-control-shared/api/chat";

export function DocumentProposalTarget({ proposal }: { proposal: DocumentPatchProposalRecord }) {
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
    <p className="break-words">
      Target: {title.data || (title.isPending ? "Reading document title…" : "Document title unavailable")} ·{" "}
      {proposal.targetKind === "personal_note" ? "Note" : "Artifact"} {proposal.targetId} · Workspace{" "}
      {proposal.workspaceId}
      {proposal.sessionId ? ` · Conversation ${proposal.sessionId}` : ""}
    </p>
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
