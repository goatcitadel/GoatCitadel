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
            className="chat-plus-trigger"
            disabled={disabled}
            aria-expanded={open}
            aria-label="Open chat actions"
          >
            +
          </button>
        </Popover.Trigger>
        <Popover.Portal>
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
            >
              Add files or photos
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onRunQuickResearch();
              }}
            >
              Quick web research
            </button>
          </Popover.Content>
        </Popover.Portal>
      </div>
    </Popover.Root>
  );
}
