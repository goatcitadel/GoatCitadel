import { useMemo, type ReactNode } from "react";
import * as Select from "@radix-ui/react-select";

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
      <span className={`gc-select-shell${className ? ` ${className}` : ""}`}>
        {renderPrefix ? <span className="gc-select-prefix">{renderPrefix}</span> : null}
        <select
          {...rest}
          className="gc-select"
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
    <Select.Root value={selected?.value ?? ""} onValueChange={onChange} disabled={disabled}>
      <span className={`gc-select-shell${className ? ` ${className}` : ""}`}>
        {renderPrefix ? <span className="gc-select-prefix">{renderPrefix}</span> : null}
        <Select.Trigger {...rest} className="gc-select-trigger">
          <Select.Value className="gc-select-value" placeholder={placeholderOption?.label ?? "Select a value"} />
          <Select.Icon asChild>
            <span className="gc-select-caret" aria-hidden>▾</span>
          </Select.Icon>
        </Select.Trigger>
      </span>
      <Select.Portal>
        <Select.Content className="gc-select-content" position="popper" sideOffset={6} align="start">
          <Select.Viewport className="gc-select-list">
            {selectableOptions.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={`gc-select-option${option.value === selected?.value ? " active" : ""}`}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator asChild>
                  <span className="gc-select-check" aria-hidden>●</span>
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
