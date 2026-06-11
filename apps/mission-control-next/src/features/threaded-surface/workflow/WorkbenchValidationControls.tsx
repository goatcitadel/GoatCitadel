import { memo, useState } from "react";
import type { ValidationCommandPreset } from "./format";

/*
 * Owns the validation command-line input state so typing a command
 * re-renders these controls only, not the whole CodeWorkbenchPanel.
 * The parent mirrors the latest command line into a ref (via
 * onCommandChange) for callers outside this subtree, e.g. the
 * workbench command palette. Handlers must be referentially stable
 * for the memo() to hold.
 */

export const DEFAULT_VALIDATION_COMMAND = "pnpm test";

interface WorkbenchValidationControlsProps {
  busy: boolean;
  blockedReason: string | null;
  available: boolean;
  presets: ReadonlyArray<ValidationCommandPreset>;
  onCommandChange: (commandLine: string) => void;
  onRunCommandLine: (commandLine: string) => void;
}

export const WorkbenchValidationControls = memo(function WorkbenchValidationControls({
  busy,
  blockedReason,
  available,
  presets,
  onCommandChange,
  onRunCommandLine,
}: WorkbenchValidationControlsProps) {
  const [command, setCommand] = useState(DEFAULT_VALIDATION_COMMAND);

  return (
    <>
      <input
        className="mc-next-workbench-command-input"
        value={command}
        onChange={(event) => {
          setCommand(event.target.value);
          onCommandChange(event.target.value);
        }}
        disabled={busy}
        aria-label="Validation command"
      />
      <button
        type="button"
        className="mc-next-panel-button"
        onClick={() => onRunCommandLine(command)}
        disabled={busy || Boolean(blockedReason) || !available}
        title={blockedReason ?? (!available ? "Validation backend is unavailable." : undefined)}
      >
        Test
      </button>
      {presets.map((preset) => (
        <button
          key={preset.label}
          type="button"
          className="mc-next-panel-button"
          disabled={busy || Boolean(blockedReason) || !available}
          title={blockedReason ?? preset.command}
          onClick={() => {
            setCommand(preset.command);
            onCommandChange(preset.command);
            onRunCommandLine(preset.command);
          }}
        >
          {preset.label}
        </button>
      ))}
    </>
  );
});
