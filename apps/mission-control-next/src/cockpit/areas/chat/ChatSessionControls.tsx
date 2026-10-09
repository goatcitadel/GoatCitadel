import { useState, type FormEvent } from "react";
import { MoreHorizontal, Pencil } from "lucide-react";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../../ui/Menu";

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
    onClick={() => { dock.onRenameTitleChange(title); setRenaming(true); }} className="inline-flex max-w-full items-center gap-1 text-left hover:text-accent"><span className="truncate">{title}</span><Pencil aria-hidden="true" className="size-3 shrink-0" /></button></h1>;
}

export function ChatSessionOverflow({ dock, onFork, onInspect }: {
  dock: MissionThreadedContextDockProps | null;
  onFork?: () => void;
  onInspect?: () => void;
}) {
  const [archiveOpen, setArchiveOpen] = useState(false);
  if (!dock) return null;
  const archived = Boolean(dock.selectedSession.archivedAt);
  const archivePending = dock.sessionControlPending === "archive";
  // Radix gives the menu Escape, arrow keys and focus return; the bare <details> it replaces had none.
  return <>
    <Menu>
      <MenuTrigger aria-label="Conversation actions" className="inline-flex min-h-8 shrink-0 items-center rounded-md border border-line px-2 text-sm text-fg-secondary hover:border-accent max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center">
        <MoreHorizontal aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuContent align="end">
        {onInspect ? <MenuItem className="max-sm:min-h-11 md:hidden" onSelect={onInspect}>Inspect conversation</MenuItem> : null}
        <MenuItem className="max-sm:min-h-11" disabled={!onFork} onSelect={() => onFork?.()}>New conversation from latest message</MenuItem>
        <MenuItem className="max-sm:min-h-11" disabled={Boolean(dock.sessionControlPending)} onSelect={() => void dock.onTogglePinSession()}>{dock.selectedSession.pinned ? "Unpin conversation" : "Pin conversation"}</MenuItem>
        <MenuItem className="max-sm:min-h-11" disabled={Boolean(dock.sessionControlPending)} onSelect={dock.onDeleteSession}>Delete conversation…</MenuItem>
        <MenuItem className="max-sm:min-h-11" onSelect={() => dock.onExportSnapshot()}>Export conversation</MenuItem>
        <MenuItem className="max-sm:min-h-11" disabled={archivePending} onSelect={() => setArchiveOpen(true)}>
          {archived ? "Restore conversation" : "Archive conversation"}
        </MenuItem>
      </MenuContent>
    </Menu>
    <Dialog open={archiveOpen} onOpenChange={setArchiveOpen} title={archived ? "Restore conversation?" : "Archive conversation?"}
      description={archived ? "The conversation will return to recent history." : "The conversation will leave recent history and remain recoverable in Archived."}>
      <div className="flex justify-end gap-2"><Button onClick={() => setArchiveOpen(false)} disabled={archivePending}>Cancel</Button>
        <Button variant="primary" disabled={archivePending} onClick={() => void dock.onToggleArchiveSession().then(() => setArchiveOpen(false))}>
          {archivePending ? "Working…" : archived ? "Restore" : "Archive"}
        </Button></div>
    </Dialog>
  </>;
}
