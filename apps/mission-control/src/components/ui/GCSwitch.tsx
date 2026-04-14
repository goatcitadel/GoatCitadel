import { cn } from "@/lib/utils";
import { Switch } from "./switch";

interface GCSwitchProps {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
}

export function GCSwitch({ checked, onCheckedChange, label, disabled = false, id }: GCSwitchProps) {
  return (
    <label className={cn("gc-switch-row mc-gc-switch-row", disabled && "opacity-70")} htmlFor={id}>
      <Switch
        id={id}
        className="gc-switch-root mc-gc-switch-root"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
      {label ? <span className="mc-gc-switch-label">{label}</span> : null}
    </label>
  );
}
