import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  Check,
  FilePlus2,
  Globe2,
  Image,
  Mic,
  PencilRuler,
  Radio,
  ScrollText,
  Sparkles,
  Target,
  Volume2,
} from "lucide-react";

export interface ChatComposerPlusMenuAction {
  label: string;
  disabled?: boolean;
  active?: boolean;
  tone?: "default" | "accent" | "warning";
  onSelect: () => void;
}

function iconForAction(label: string): ReactNode {
  const normalized = label.toLowerCase();
  if (normalized.includes("file") || normalized.includes("photo")) {
    return <FilePlus2 aria-hidden="true" size={15} strokeWidth={2} />;
  }
  if (normalized.includes("plan")) {
    return <PencilRuler aria-hidden="true" size={15} strokeWidth={2} />;
  }
  if (normalized.includes("goal")) {
    return <Target aria-hidden="true" size={15} strokeWidth={2} />;
  }
  if (normalized.includes("web") || normalized.includes("research")) {
    return <Globe2 aria-hidden="true" size={15} strokeWidth={2} />;
  }
  if (normalized.includes("voice") || normalized.includes("audio") || normalized.includes("transcribe")) {
    return <Mic aria-hidden="true" size={15} strokeWidth={2} />;
  }
  if (normalized.includes("speak")) {
    return <Volume2 aria-hidden="true" size={15} strokeWidth={2} />;
  }
  if (normalized.includes("image")) {
    return <Image aria-hidden="true" size={15} strokeWidth={2} />;
  }
  if (normalized.includes("run") || normalized.includes("detail")) {
    return <ScrollText aria-hidden="true" size={15} strokeWidth={2} />;
  }
  if (normalized.includes("stream") || normalized.includes("steer")) {
    return <Radio aria-hidden="true" size={15} strokeWidth={2} />;
  }
  return <Sparkles aria-hidden="true" size={15} strokeWidth={2} />;
}

function renderActionContent(label: string, active?: boolean): ReactNode {
  return (
    <>
      <span className="chat-plus-action-icon">{iconForAction(label)}</span>
      <span className="chat-plus-action-label">{label}</span>
      {active ? (
        <span className="chat-plus-action-check" aria-hidden="true">
          <Check size={14} strokeWidth={2.4} />
        </span>
      ) : null}
    </>
  );
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
                aria-label="Attach files"
                onClick={() => {
                  setOpen(false);
                  onAttachFiles();
                }}
                className="gc-button chat-plus-action"
              >
                {renderActionContent("Add files or photos")}
              </button>
            ) : null}
            {onRunQuickResearch ? (
              <button
                type="button"
                aria-label="Quick web research"
                onClick={() => {
                  setOpen(false);
                  onRunQuickResearch();
                }}
                className="gc-button chat-plus-action"
              >
                {renderActionContent("Quick web research")}
              </button>
            ) : null}
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                aria-label={action.label}
                aria-pressed={typeof action.active === "boolean" ? action.active : undefined}
                onClick={() => {
                  setOpen(false);
                  action.onSelect();
                }}
                disabled={action.disabled}
                className={`gc-button chat-plus-action${action.active ? " active" : ""}${
                  action.tone ? ` tone-${action.tone}` : ""
                }`}
              >
                {renderActionContent(action.label, action.active)}
              </button>
            ))}
            {children ? <div className="chat-plus-custom">{children}</div> : null}
          </Popover.Content>
        </Popover.Portal>
      </div>
    </Popover.Root>
  );
}
