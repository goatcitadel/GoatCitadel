import { useMemo, useState } from "react";
import type { ChatMode } from "@goatcitadel/contracts";
import { StatusChip } from "../../components/StatusChip";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui";
import { useMediaQuery } from "../../hooks/useMediaQuery";

type PresetPickerOption = {
  value: string;
  label: string;
  summary?: string;
  routeHint?: ChatMode;
  toolsPosture?: "safe_auto" | "manual";
};

const ROUTE_HINT_LABEL: Record<ChatMode, string> = {
  chat: "Chat",
  cowork: "Cowork",
  code: "Code",
};

function formatToolsPosture(value: PresetPickerOption["toolsPosture"]): string {
  if (value === "manual") {
    return "Manual tools";
  }
  return "Safe auto";
}

function renderPresetPanel(input: {
  presets: PresetPickerOption[];
  selectedPresetId: string;
  onPresetChange: (value: string) => void;
  onApplyPreset: () => void;
}) {
  const { presets, selectedPresetId, onPresetChange, onApplyPreset } = input;

  return (
    <div className="chat-preset-picker-panel">
      <div className="chat-preset-picker-list" role="listbox" aria-label="Preset templates">
        {presets.map((preset) => {
          const selected = preset.value === selectedPresetId;
          return (
            <button
              key={preset.value}
              type="button"
              role="option"
              aria-selected={selected}
              className={`chat-preset-picker-card${selected ? " active" : ""}`}
              onClick={() => onPresetChange(preset.value)}
            >
              <div className="chat-preset-picker-card-head">
                <div className="chat-preset-picker-card-copy">
                  <strong>{preset.label}</strong>
                  {preset.summary ? <p>{preset.summary}</p> : <p>Apply this preset as a starting posture.</p>}
                </div>
                {selected ? <StatusChip tone="live">Selected</StatusChip> : null}
              </div>
              <div className="chat-preset-picker-card-meta">
                {preset.routeHint ? <StatusChip tone="muted">{ROUTE_HINT_LABEL[preset.routeHint]}</StatusChip> : null}
                {preset.toolsPosture ? (
                  <StatusChip tone={preset.toolsPosture === "manual" ? "warning" : "success"}>
                    {formatToolsPosture(preset.toolsPosture)}
                  </StatusChip>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
      <div className="chat-preset-picker-actions">
        <p>Applying a preset updates the draft and defaults, but never sends automatically.</p>
        <button type="button" className="gc-button" disabled={!selectedPresetId} onClick={onApplyPreset}>
          Apply preset
        </button>
      </div>
    </div>
  );
}

export function ChatPresetPicker({
  presets,
  selectedPresetId,
  onPresetChange,
  onApplyPreset,
}: {
  presets: PresetPickerOption[];
  selectedPresetId: string;
  onPresetChange: (value: string) => void;
  onApplyPreset: () => void;
}) {
  const compactSheet = useMediaQuery("(max-width: 840px)");
  const [open, setOpen] = useState(false);
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.value === selectedPresetId) ?? null,
    [presets, selectedPresetId],
  );

  if (presets.length === 0) {
    return null;
  }

  const trigger = (
    <button type="button" className="gc-nav-button gc-nav-tier-chip chat-preset-picker-trigger">
      <span className="chat-preset-picker-trigger-kicker">Preset</span>
      <strong>{selectedPreset?.label ?? "Preset templates"}</strong>
    </button>
  );

  const applyAndClose = () => {
    onApplyPreset();
    setOpen(false);
  };

  if (compactSheet) {
    return (
      <>
        <button
          type="button"
          className="gc-nav-button gc-nav-tier-chip chat-preset-picker-trigger"
          onClick={() => setOpen(true)}
        >
          <span className="chat-preset-picker-trigger-kicker">Preset</span>
          <strong>{selectedPreset?.label ?? "Preset templates"}</strong>
        </button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="chat-preset-picker-sheet">
            <SheetHeader>
              <SheetTitle>Preset templates</SheetTitle>
              <SheetDescription>Agent-backed templates for Chat, Cowork, and Code.</SheetDescription>
            </SheetHeader>
            {renderPresetPanel({
              presets,
              selectedPresetId,
              onPresetChange,
              onApplyPreset: applyAndClose,
            })}
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="chat-preset-picker-popover" align="start" sideOffset={10}>
        <PopoverHeader>
          <PopoverTitle>Preset templates</PopoverTitle>
          <PopoverDescription>Choose a starting posture, then apply it without auto-sending.</PopoverDescription>
        </PopoverHeader>
        {renderPresetPanel({
          presets,
          selectedPresetId,
          onPresetChange,
          onApplyPreset: applyAndClose,
        })}
      </PopoverContent>
    </Popover>
  );
}
