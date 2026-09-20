import type { ReactNode } from "react";
import { useState } from "react";
import { Popover } from "radix-ui";
import type { ChatOptionActiveSetting } from "./chat-option-settings";

export function ChatOptionsPopover({
  activeSettings,
  children,
}: {
  activeSettings: readonly ChatOptionActiveSetting[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const container =
    typeof document === "undefined" ? undefined : (document.querySelector<HTMLElement>(".mc-app-shell") ?? undefined);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className="mc-next-composer-options-bar">
        <Popover.Trigger asChild>
          <button
            type="button"
            className="mc-next-composer-options-trigger"
            aria-label="Chat options"
            aria-expanded={open}
          >
            Options
          </button>
        </Popover.Trigger>
        {activeSettings.length > 0 ? (
          <span className="mc-next-composer-options-active" aria-label="Active chat options">
            {activeSettings.map((setting) => (
              <button
                key={setting.id}
                type="button"
                className="mc-next-composer-options-chip"
                title={setting.description}
                aria-label={`${setting.label}. ${setting.description} Open Chat options to change it.`}
                onClick={() => setOpen(true)}
              >
                {setting.label}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      <Popover.Portal container={container}>
        <Popover.Content
          className="mc-next-composer-options-popover"
          side="top"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          aria-label="Chat options"
        >
          <div className="mc-next-composer-options-heading">
            <strong>Chat options</strong>
            <Popover.Close asChild>
              <button type="button" className="mc-next-panel-button" aria-label="Close Chat options">
                Close
              </button>
            </Popover.Close>
          </div>
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
