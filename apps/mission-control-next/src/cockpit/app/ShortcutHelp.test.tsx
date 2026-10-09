// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ShortcutHelp } from "./ShortcutHelp";

it("names help, moves focus to close, and closes with Escape", async () => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  function Harness() { const [open, setOpen] = useState(false); return <><button type="button" onClick={() => setOpen(true)}>Help</button><ShortcutHelp open={open} onOpenChange={setOpen} /></>; }
  try {
    await act(async () => root.render(<Harness />));
    const trigger = container.querySelector("button")!; trigger.focus();
    await act(async () => trigger.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Keyboard shortcuts");
    expect(dialog.textContent).toContain("Settings");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // The dialog returns focus asynchronously; wait for it instead of racing it under load.
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  } finally { act(() => root.unmount()); container.remove(); }
});
