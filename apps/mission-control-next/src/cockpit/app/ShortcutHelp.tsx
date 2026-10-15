import { useRef } from "react";
import { Dialog } from "../ui/Dialog";
import { Kbd } from "../ui/Kbd";
import { shortcutLabel } from "./platform-keys";
import { COCKPIT_AREA_SHORTCUTS } from "./routes";

const GLOBAL_SHORTCUTS: ReadonlyArray<{ label: string; keys: () => string }> = [
  { label: "Command palette", keys: () => shortcutLabel("k") },
  { label: "Toggle sidebar", keys: () => shortcutLabel("b") },
  { label: "Toggle inspector", keys: () => shortcutLabel("i") },
  { label: "Shortcut help", keys: () => "?" },
  { label: "Close dialog or inspector", keys: () => "Esc" },
];

export function ShortcutHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      onOpenAutoFocus={() => {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }}
      onCloseAutoFocus={(event) => {
        if (opener.current?.isConnected) {
          event.preventDefault();
          opener.current.focus();
        }
      }}
      description="Area shortcuts work outside text fields. Press g, then the area key within 1.5 seconds. Moving focus cancels the sequence."
    >
      <dl className="grid gap-3 text-sm">
        {COCKPIT_AREA_SHORTCUTS.map((entry) => (
          <div key={entry.area} className="flex justify-between gap-4">
            <dt>{entry.label}</dt>
            <dd>
              <Kbd>g</Kbd> then <Kbd>{entry.shortcut}</Kbd>
            </dd>
          </div>
        ))}
        {GLOBAL_SHORTCUTS.map((entry) => (
          <div key={entry.label} className="flex justify-between gap-4">
            <dt>{entry.label}</dt>
            <dd>
              <Kbd>{entry.keys()}</Kbd>
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
