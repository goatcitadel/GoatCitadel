import { useEffect } from "react";
import { COCKPIT_AREA_SHORTCUTS } from "./routes";

export function useAreaShortcuts({ scope, navigate, onPalette, onHelp, onToggleSidebar }: {
  scope: string;
  navigate: (path: string) => void;
  onPalette: () => void;
  onHelp: () => void;
  onToggleSidebar: () => void;
}) {
  useEffect(() => {
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { pending = false; clearTimeout(timer); };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) { cancel(); return; }
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === "k") {
        cancel(); event.preventDefault(); onPalette(); return;
      }
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
        || document.querySelector('[role="dialog"][data-state="open"], dialog[open]')) { cancel(); return; }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === "b") {
        cancel(); event.preventDefault(); onToggleSidebar(); return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && key !== "?")) { cancel(); return; }
      if (key === "?") { cancel(); event.preventDefault(); onHelp(); return; }
      if (pending) {
        cancel();
        const target = COCKPIT_AREA_SHORTCUTS.find((entry) => entry.shortcut === key);
        if (target) { event.preventDefault(); navigate(target.path); }
        return;
      }
      if (key === "g") { pending = true; timer = setTimeout(cancel, 1500); }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", cancel);
    document.addEventListener("pointerdown", cancel);
    document.addEventListener("visibilitychange", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      cancel(); document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", cancel); document.removeEventListener("pointerdown", cancel);
      document.removeEventListener("visibilitychange", cancel); window.removeEventListener("blur", cancel);
    };
  }, [scope, navigate, onPalette, onHelp, onToggleSidebar]);
}
