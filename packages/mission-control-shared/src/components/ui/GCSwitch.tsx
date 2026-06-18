import { cn } from "../../lib/utils";

interface GCSwitchProps {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
}

export function GCSwitch({ checked, onCheckedChange, label, disabled = false, id }: GCSwitchProps) {
  const labelId = label && id ? `${id}-label` : undefined;

  return (
    <label className={cn("gc-switch-row mc-gc-switch-row", disabled && "opacity-70")}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled}
        aria-label={!label ? "Toggle setting" : undefined}
        aria-labelledby={labelId}
        className="gc-switch-root mc-gc-switch-root"
        disabled={disabled}
        data-state={checked ? "checked" : "unchecked"}
        onClick={() => {
          if (disabled) {
            return;
          }
          onCheckedChange(!checked);
        }}
      >
        <span aria-hidden="true" className={cn("gc-switch-thumb", checked && "translate-x-[18px]")} />
      </button>
      {label ? (
        <span id={labelId} className="mc-gc-switch-label">
          {label}
        </span>
      ) : null}
    </label>
  );
}
