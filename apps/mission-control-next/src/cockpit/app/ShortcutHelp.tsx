import { Dialog } from "../ui/Dialog";
import { Kbd } from "../ui/Kbd";
import { COCKPIT_AREA_SHORTCUTS } from "./routes";

export function ShortcutHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const opener = useRef<HTMLElement | null>(null);
  return <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts"
    onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
    onCloseAutoFocus={(event) => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); } }}
    description="Area shortcuts work outside text fields. Press g, then the area key within 1.5 seconds. Moving focus cancels the sequence.">
    <dl className="grid gap-3 text-sm">
      {COCKPIT_AREA_SHORTCUTS.map((entry) => <div key={entry.area} className="flex justify-between gap-4">
        <dt>{entry.label}</dt><dd><Kbd>g</Kbd> then <Kbd>{entry.shortcut}</Kbd></dd>
      </div>)}
      <div className="flex justify-between gap-4"><dt>Command palette</dt><dd><Kbd>Ctrl / Cmd K</Kbd></dd></div>
      <div className="flex justify-between gap-4"><dt>Toggle sidebar</dt><dd><Kbd>Ctrl / Cmd B</Kbd></dd></div>
      <div className="flex justify-between gap-4"><dt>Shortcut help</dt><dd><Kbd>?</Kbd></dd></div>
      <div className="flex justify-between gap-4"><dt>Close dialog</dt><dd><Kbd>Esc</Kbd></dd></div>
    </dl>
  </Dialog>;
}
import { useRef } from "react";
