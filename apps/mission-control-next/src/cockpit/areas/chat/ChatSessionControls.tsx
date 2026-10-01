import { useRef, useState, type FormEvent } from "react";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

export function ChatSessionTitle({ title, dock }: { title: string; dock: MissionThreadedContextDockProps | null }) {
  const [renaming, setRenaming] = useState(false);
  const busy = dock?.sessionControlPending === "rename";
  const cancel = () => {
    dock?.onRenameTitleChange(title);
    setRenaming(false);
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dock?.renameTitle.trim() || busy) return;
    await dock.onRenameSession();
    setRenaming(false);
  };

  if (!dock) return <h1 className="truncate font-display text-base font-semibold text-fg">{title}</h1>;
  if (renaming) return <form onSubmit={(event) => void save(event)} className="flex min-w-0 items-center gap-1">
    <label htmlFor="cockpit-chat-title" className="sr-only">Conversation title</label>
    <input id="cockpit-chat-title" autoFocus value={dock.renameTitle} maxLength={200} disabled={busy}
      onChange={(event) => dock.onRenameTitleChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") cancel(); }}
      className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-sm text-fg" />
    <Button type="submit" size="sm" disabled={busy || !dock.renameTitle.trim()}>Save</Button>
    <Button type="button" size="sm" onClick={cancel} disabled={busy}>Cancel</Button>
  </form>;
  return <h1 className="truncate font-display text-base font-semibold text-fg"><button type="button" title="Rename conversation"
    onClick={() => { dock.onRenameTitleChange(title); setRenaming(true); }} className="max-w-full truncate text-left hover:text-accent">{title}</button></h1>;
}

export function ChatSessionOverflow({ dock, onFork, onInspect }: {
  dock: MissionThreadedContextDockProps | null;
  onFork?: () => void;
  onInspect?: () => void;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  if (!dock) return null;
  const archived = Boolean(dock.selectedSession.archivedAt);
  const archivePending = dock.sessionControlPending === "archive";
  const closeMenu = () => { menuRef.current?.removeAttribute("open"); };
  return <>
    <details ref={menuRef} className="relative shrink-0">
      <summary aria-label="Conversation actions" className="cockpit-chat-menu-trigger cursor-pointer rounded-md border border-line px-2 py-1 text-sm text-fg-secondary hover:border-accent">•••</summary>
      <div className="absolute right-0 z-30 mt-1 grid min-w-44 gap-1 rounded-md border border-line bg-overlay p-1 shadow-overlay">
        {onInspect ? <button type="button" onClick={() => { closeMenu(); onInspect(); }} className="rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-sunken md:hidden">Inspect conversation</button> : null}
        <button type="button" onClick={() => { closeMenu(); onFork?.(); }} disabled={!onFork} className="rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-sunken disabled:opacity-50">Fork from latest turn</button>
        <button type="button" onClick={() => { closeMenu(); dock.onExportSnapshot(); }} className="rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-sunken">Export conversation</button>
        <button type="button" onClick={() => { closeMenu(); setArchiveOpen(true); }} disabled={archivePending} className="rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-sunken">{archived ? "Restore conversation" : "Archive conversation"}</button>
      </div>
    </details>
    <Dialog open={archiveOpen} onOpenChange={setArchiveOpen} title={archived ? "Restore conversation?" : "Archive conversation?"}
      description={archived ? "The conversation will return to recent history." : "The conversation will leave recent history and remain recoverable in Archived."}>
      <div className="flex justify-end gap-2"><Button onClick={() => setArchiveOpen(false)} disabled={archivePending}>Cancel</Button>
        <Button variant="primary" disabled={archivePending} onClick={() => void dock.onToggleArchiveSession().then(() => setArchiveOpen(false))}>
          {archivePending ? "Working…" : archived ? "Restore" : "Archive"}
        </Button></div>
    </Dialog>
  </>;
}
