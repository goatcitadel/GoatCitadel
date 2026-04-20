import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";

export function ChatComposerPlusMenu({
  disabled,
  onAttachFiles,
  onRunQuickResearch,
}: {
  disabled?: boolean;
  onAttachFiles: () => void;
  onRunQuickResearch: () => void;
}) {
  const [open, setOpen] = useState(false);
  const portalContainer =
    typeof document === "undefined" ? undefined : (document.querySelector<HTMLElement>(".mc-app-shell") ?? undefined);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className="chat-plus-menu">
        <Popover.Trigger asChild>
          <button
            type="button"
            className="gc-button chat-plus-trigger"
            disabled={disabled}
            aria-expanded={open}
            aria-label="Open chat actions"
          >
            +
          </button>
        </Popover.Trigger>
        <Popover.Portal container={portalContainer}>
          <Popover.Content
            className="chat-plus-popover"
            align="start"
            side="top"
            sideOffset={8}
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAttachFiles();
              }}
              className="gc-button chat-plus-action"
            >
              Add files or photos
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onRunQuickResearch();
              }}
              className="gc-button chat-plus-action"
            >
              Quick web research
            </button>
          </Popover.Content>
        </Popover.Portal>
      </div>
    </Popover.Root>
  );
}
