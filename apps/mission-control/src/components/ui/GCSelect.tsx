import { useMemo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

export interface GCSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface GCSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: GCSelectOption[];
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  id?: string;
  renderPrefix?: ReactNode;
}

export function GCSelect({
  value,
  onChange,
  options,
  disabled = false,
  className,
  renderPrefix,
  ...rest
}: GCSelectProps) {
  const canUsePortalSelect = typeof document !== "undefined" && typeof document.createElement === "function";
  const placeholderOption = useMemo(() => {
    return options.find((option) => option.value === "" && option.disabled) ?? null;
  }, [options]);

  const selectableOptions = useMemo(() => {
    return options.filter((option) => !(option.value === "" && option.disabled));
  }, [options]);

  const selected = useMemo(() => {
    return selectableOptions.find((option) => option.value === value) ?? null;
  }, [selectableOptions, value]);

  if (!canUsePortalSelect) {
    return (
      <span className={cn("gc-select-shell mc-gc-select-shell", className)}>
        {renderPrefix ? <span className="gc-select-prefix mc-gc-select-prefix">{renderPrefix}</span> : null}
        <select
          {...rest}
          className="gc-select mc-gc-select-native"
          disabled={disabled}
          value={selected?.value ?? ""}
          onChange={(event) => onChange(event.target.value)}
        >
          {placeholderOption ? (
            <option value="" disabled>
              {placeholderOption.label}
            </option>
          ) : null}
          {selectableOptions.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      </span>
    );
  }

  return (
    <Select value={selected?.value ?? ""} onValueChange={onChange} disabled={disabled}>
      <span className={cn("gc-select-shell mc-gc-select-shell", className)}>
        {renderPrefix ? <span className="gc-select-prefix mc-gc-select-prefix">{renderPrefix}</span> : null}
        <SelectTrigger
          {...rest}
          className="gc-select-trigger mc-gc-select-trigger min-w-[10rem] bg-background/70 text-left"
        >
          <SelectValue className="gc-select-value" placeholder={placeholderOption?.label ?? "Select a value"} />
        </SelectTrigger>
      </span>
      <SelectContent className="gc-select-content mc-gc-select-content" position="popper" sideOffset={6} align="start">
        {selectableOptions.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            className={cn("gc-select-option", option.value === selected?.value && "active")}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
