import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";

export interface ChatComposerPlusMenuAction {
  label: string;
  disabled?: boolean;
  active?: boolean;
  onSelect: () => void;
}

export function ChatComposerPlusMenu({
  disabled,
  onAttachFiles,
  onRunQuickResearch,
  actions = [],
  children,
}: {
  disabled?: boolean;
  onAttachFiles?: () => void;
  onRunQuickResearch?: () => void;
  actions?: ChatComposerPlusMenuAction[];
  children?: ReactNode;
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
            {onAttachFiles ? (
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
            ) : null}
            {onRunQuickResearch ? (
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
            ) : null}
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() => {
                  setOpen(false);
                  action.onSelect();
                }}
                disabled={action.disabled}
                className={`gc-button chat-plus-action${action.active ? " active" : ""}`}
              >
                {action.label}
              </button>
            ))}
            {children ? <div className="chat-plus-custom">{children}</div> : null}
          </Popover.Content>
        </Popover.Portal>
      </div>
    </Popover.Root>
  );
}
