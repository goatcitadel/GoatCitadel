import { useEffect, useRef, useState } from "react";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import { AssistantMessageRenderer } from "@goatcitadel/mission-control-shared/components/chat/AssistantMessageRenderer";
import { useSessionDraft, hasSessionDraft, useSessionDraftVersion } from "../native-routes/library/session-drafts";
import { useDraftLeave } from "../native-routes/library/DraftLeaveDialog";
import { ContextDisclosure } from "./ThreadedContextDisclosure";

export function ThreadedDocumentsPanel({ props }: { props: MissionThreadedContextDockProps }) {
  const documents = props.documents;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const leave=useDraftLeave();
  useSessionDraftVersion();
  const lock=useRef(false), mounted=useRef(true), currentKey=useRef(selectedKey);
  currentKey.current=selectedKey;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedNote = documents?.notes.find((note) => `personal_note:${note.noteId}` === selectedKey);
  const selectedArtifact = documents?.artifacts.find(
    (artifact) => `generated_artifact:${artifact.artifactId}` === selectedKey,
  );
  const editable = Boolean(selectedNote || selectedArtifact?.kind === "markdown" || selectedArtifact?.kind === "text");
  const selectedRef = selectedNote
    ? { kind: "personal_note" as const, ref: selectedNote.noteId, label: selectedNote.title }
    : selectedArtifact
      ? { kind: "generated_artifact" as const, ref: selectedArtifact.artifactId, label: selectedArtifact.title }
      : null;
  const included = selectedRef
    ? documents?.includedRefs.some((ref) => ref.kind === selectedRef.kind && ref.ref === selectedRef.ref) === true
    : false;

  const scope=props.selectedSession?.workspaceId ?? props.selectedSessionId ?? "unselected";
  const draftKey=(key:string|null)=>"chat-document:"+scope+":"+(key??"none");
  const documentDraft=useSessionDraft(draftKey(selectedKey),selectedNote?.body ?? selectedArtifact?.content ?? "",selectedNote?.revision ?? selectedArtifact?.contentHash,{label:selectedRef?.label??"Chat document",active:editable,available:Boolean(selectedRef),onSave:()=>saveDirect()});
  const draft=documentDraft.value,setDraft=documentDraft.setValue;
  useEffect(()=>setError(null),[selectedKey]);
  async function saveDirect():Promise<boolean> {
    if(lock.current || !documents || !selectedRef)return false;
    lock.current=true;setBusy(true);setError(null);const submitted=draft, key=selectedKey;
    try {
      if(selectedNote){
        if(typeof documentDraft.baseRevision!=="number")throw new Error("The note's base revision is unavailable.");
        const saved=await documents.onSaveNote({...selectedNote,revision:documentDraft.baseRevision},submitted);
        if(saved.noteId!==selectedNote.noteId || saved.body!==submitted || saved.revision<=documentDraft.baseRevision)throw new Error("The Gateway did not confirm this note update. The draft is retained.");
        return documentDraft.acceptSaved(saved.body,saved.revision,submitted);
      }
      if(selectedArtifact){
        if(typeof documentDraft.baseRevision!=="string")throw new Error("The artifact's base content hash is unavailable.");
        const saved=await documents.onSaveArtifact({...selectedArtifact,contentHash:documentDraft.baseRevision},submitted);
        if(!saved.artifactId || !saved.contentHash || saved.content!==submitted)throw new Error("The artifact version could not be confirmed. The draft is retained.");
        const nextKey="generated_artifact:"+saved.artifactId;
        const cleared=documentDraft.acceptSavedAs(draftKey(nextKey),saved.content,saved.contentHash,submitted);
        if(mounted.current&&currentKey.current===key)setSelectedKey(nextKey);
        return cleared;
      }
      return false;
    }catch(cause){if(mounted.current&&currentKey.current===key)setError(cause instanceof Error?cause.message:"Could not save the document.");return false;}
    finally{lock.current=false;if(mounted.current)setBusy(false);}
  }

  if (!documents?.enabled) {
    return <p className="mc-next-context-empty">Document editing is unavailable in this runtime.</p>;
  }

  const run = async (action: () => Promise<unknown>) => {
    if(lock.current)return;
    lock.current=true;const key=selectedKey;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      if(mounted.current&&currentKey.current===key)setError(cause instanceof Error ? cause.message : "The document action failed.");
      await documents.onRefresh().catch(() => undefined);
    } finally {
      lock.current=false;
      if(mounted.current)setBusy(false);
    }
  };

  return (
    <div className="mc-next-context-section-stack">
      {leave.dialog}
      {documentDraft.hasRemoteChanges ? <section className="mc-next-document-conflict"><p role="alert">This document changed since editing began. Your draft keeps its original revision.</p><details className="mc-next-chat-evidence"><summary>Review latest version</summary><p>Compare this version with your draft before choosing the revision for your next save.</p><pre>{selectedNote?.body ?? selectedArtifact?.content}</pre><button type="button" className="mc-next-panel-button" disabled={busy} onClick={documentDraft.rebaseToCurrent}>Use this revision and keep my draft</button></details></section> : null}
      <section className="mc-next-context-card">
        <div className="mc-next-context-card-title-row">
          <div>
            <p className="mc-next-panel-kicker">Documents</p>
            <h4>Notes and generated artifacts</h4>
          </div>
          <button
            type="button"
            className="mc-next-panel-button"
            disabled={documents.loading}
            onClick={() => void documents.onRefresh()}
          >
            Refresh
          </button>
        </div>
        <p>Opening a document never adds it to model context. Including documents in a turn is temporarily unavailable.</p>
        <div className="mc-next-context-actions" role="group" aria-label="Chat documents">
          {documents.notes.map((note) => (
            <button
              key={note.noteId}
              type="button"
              className="mc-next-panel-button"
              aria-pressed={selectedKey === `personal_note:${note.noteId}`}
              onClick={() => leave.request(()=>setSelectedKey(`personal_note:${note.noteId}`),[documentDraft.key])}
            >
              Note · {note.title} · r{note.revision}{hasSessionDraft(draftKey(`personal_note:${note.noteId}`))?" · Unsaved":""}
            </button>
          ))}
          {documents.artifacts.map((artifact) => (
            <button
              key={artifact.artifactId}
              type="button"
              className="mc-next-panel-button"
              aria-pressed={selectedKey === `generated_artifact:${artifact.artifactId}`}
              onClick={() => leave.request(()=>setSelectedKey(`generated_artifact:${artifact.artifactId}`),[documentDraft.key])}
            >
              Artifact · {artifact.title} · {artifact.kind} v{artifact.version}{hasSessionDraft(draftKey(`generated_artifact:${artifact.artifactId}`))?" · Unsaved":""}
            </button>
          ))}
        </div>
      </section>

      {selectedRef ? (
        <section className="mc-next-context-card">
          <p className="mc-next-panel-kicker">{selectedNote ? "Personal note" : "Generated artifact"}</p>
          <h4>{selectedRef.label}</h4>
          <div className="mc-next-context-actions">
            <button
              type="button"
              className="mc-next-panel-button"
              aria-pressed={included}
              disabled={!included}
              onClick={() => documents.onToggleInclude(selectedRef)}
            >
              {included ? "Remove from next turn" : "Include in next turn temporarily unavailable"}
            </button>
          </div>
          {editable ? (
            <>
              <label className="mc-next-context-field">
                <span>Document content</span>
                <textarea
                  aria-label="Document content"
                  value={draft}
                  rows={12}
                  maxLength={256 * 1024}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </label>
              <div className="mc-next-context-actions">
                <button
                  type="button"
                  className="mc-next-panel-button"
                  disabled={busy}
                  onClick={()=>void saveDirect()}
                >
                  Save directly
                </button>
                <button
                  type="button"
                  className="mc-next-panel-button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (selectedNote && (typeof documentDraft.baseRevision !== "number" || !Number.isFinite(documentDraft.baseRevision))) throw new Error("The note's base revision is unavailable.");
                      if (selectedArtifact && (typeof documentDraft.baseRevision !== "string" || !documentDraft.baseRevision)) throw new Error("The artifact's base content hash is unavailable.");
                      await documents.onCreateProposal({
                        targetKind: selectedNote ? "personal_note" : "generated_artifact",
                        targetId: selectedRef.ref,
                        baseRevision: selectedNote ? Number(documentDraft.baseRevision) : undefined,
                        baseContentHash: selectedArtifact ? String(documentDraft.baseRevision ?? "") : undefined,
                        proposedContent: draft,
                      });
                    })
                  }
                >
                  Create review proposal
                </button>
              </div>
            </>
          ) : (
            <p role="status">
              {selectedArtifact?.kind ?? "This document"} is read-only. Only notes and generated Markdown/text artifacts
              can be edited.
            </p>
          )}
          <ContextDisclosure summary="Safe preview">
            {selectedNote ? <AssistantMessageRenderer role="assistant" content={draft} /> : null}
            {selectedArtifact ? (
              <GeneratedArtifactViewer artifact={{ ...selectedArtifact, content: draft }} compact />
            ) : null}
          </ContextDisclosure>
          {error ? <p role="alert">{error}</p> : null}
        </section>
      ) : null}

      {documents.proposals.length > 0 ? (
        <section className="mc-next-context-card">
          <p className="mc-next-panel-kicker">Patch proposals</p>
          <h4>Review before apply</h4>
          {documents.proposals.map((proposal) => (
            <ContextDisclosure key={proposal.proposalId} summary={`${proposal.targetKind} · ${proposal.state}`}>
              <p>
                {proposal.authorKind} provenance · {proposal.turnId ?? proposal.authorId}
              </p>
              <pre className="generated-artifact-code-block">{proposal.derivedDiff}</pre>
              {proposal.conflictReason ? <p role="alert">{proposal.conflictReason}</p> : null}
              {proposal.state === "pending" ? (
                <div className="mc-next-context-actions">
                  <button
                    type="button"
                    className="mc-next-panel-button"
                    disabled={busy}
                    onClick={() => void run(() => documents.onApplyProposal(proposal.proposalId))}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="mc-next-panel-button"
                    disabled={busy}
                    onClick={() => void run(() => documents.onRejectProposal(proposal.proposalId))}
                  >
                    Reject
                  </button>
                </div>
              ) : null}
              {proposal.state === "conflicted" ? (
                <button
                  type="button"
                  className="mc-next-panel-button"
                  onClick={() => {
                    setSelectedKey(`${proposal.targetKind}:${proposal.targetId}`);
                    setDraft(proposal.proposedContent);
                  }}
                >
                  Load for rebase
                </button>
              ) : null}
            </ContextDisclosure>
          ))}
        </section>
      ) : null}
    </div>
  );
}
